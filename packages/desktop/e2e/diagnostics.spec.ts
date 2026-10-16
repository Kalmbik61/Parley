import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Сегмент Diagnostics в строке статуса (спека диагностики хоста 2026-10-16, A1, A6): клик → «Save diagnostics» →
 * zip в `PARLEY_DIAGNOSTICS_DIR` с нужными файлами и ответом настоящего хоста, показ файла в Finder — в журнале
 * main (`PARLEY_SHELL=log`, `playwright.config.ts`); в окне 800×500 строка статуса не переполняется, а у
 * сегмента остаётся одна иконка. Раскладка — при масштабе 1 и 2 (`--force-device-scale-factor`).
 * Агент — эхо-заглушка, настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Parley).parley.call(m, p), [method, params] as const) as Promise<T>;
}

/** Файл zip в журнале «показать в Finder»: последний элемент `__parleyShell`. */
async function lastShellEntry(app: ElectronApplication): Promise<unknown> {
  const log = await app.evaluate(() => (globalThis as { __parleyShell?: unknown[] }).__parleyShell ?? []);
  return log[log.length - 1];
}

test.describe('диагностика хоста в строке статуса', () => {
  let home: string;
  let project: string;
  let outDir: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('diagnostics');
    project = await makeTempProject('diagnostics');
    // Свой каталог архива: настоящие Downloads человека тест не трогает. realpath — путь из журнала main сверяется строкой.
    outDir = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-e2e-diagnostics-out-')));
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function launch(extraArgs: string[] = []): Promise<{ application: ElectronApplication; window: Page }> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_DIAGNOSTICS_DIR: outDir,
    };
    const application = await electron.launch({ args: [mainEntry, ...extraArgs], env });
    app = application;
    const window = await application.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'e2e-diagnostics', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    return { application, window };
  }

  test('Save diagnostics кладёт zip в PARLEY_DIAGNOSTICS_DIR и показывает его в Finder', async () => {
    test.setTimeout(90_000);
    const { application, window } = await launch();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));

    await window.locator('[data-diagnostics-segment]').click();
    await window.getByRole('button', { name: 'Save diagnostics', exact: true }).click();
    await expect(window.getByText('Diagnostics saved')).toBeVisible({ timeout: 15_000 });

    // Main сам показывает файл в Finder; под PARLEY_SHELL=log это запись журнала, а не окно Finder.
    const entry = (await lastShellEntry(application)) as { action: string; path: string };
    expect(entry.action).toBe('showItemInFolder');
    expect(path.dirname(entry.path)).toBe(outDir);
    expect(path.basename(entry.path)).toMatch(/^parley-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(await readdir(outDir)).toEqual([path.basename(entry.path)]);

    const listing = spawnSync('unzip', ['-l', entry.path], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    for (const name of ['README.txt', 'host.log', 'host-info.json', 'app-info.json', 'processes.txt', 'actions.jsonl']) {
      expect(listing.stdout, `в архиве нет ${name}`).toContain(name);
    }

    // Хост настоящий: ответил на host.diagnostics, а не «не ответил».
    const hostInfo = spawnSync('unzip', ['-p', entry.path, 'host-info.json'], { encoding: 'utf8' });
    expect(hostInfo.status).toBe(0);
    const info = JSON.parse(hostInfo.stdout) as { responded: boolean; health: { cpuPct: unknown }; sessions: unknown };
    expect(info.responded).toBe(true);
    expect(typeof info.health.cpuPct).toBe('number');
    expect(Array.isArray(info.sessions)).toBe(true);
  });

  for (const dpr of [1, 2]) {
    test(`в окне 800×500 строка статуса не переполняется, сегмент показывает только иконку (масштаб ${dpr})`, async () => {
      test.setTimeout(90_000);
      const { application, window } = await launch([`--force-device-scale-factor=${dpr}`]);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));

      const segment = window.locator('[data-diagnostics-segment]');
      await expect(segment).toBeVisible();
      await expect(segment).toBeInViewport({ ratio: 1 });
      // Подпись сегмента скрыта до 960 px: у вложенного span display none, остаётся иконка.
      await expect(segment.locator('span')).toHaveCSS('display', 'none');
      await expect(segment.locator('svg')).toBeVisible();

      // Корень строки статуса — дед сегмента (сегмент → правая группа → строка): ничто не выпирает за её границы.
      const fit = await segment.evaluate((el) => {
        const root = el.parentElement?.parentElement;
        if (!root) return null;
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, innerWidth: window.innerWidth };
      });
      expect(fit).not.toBeNull();
      expect(fit!.scrollWidth).toBeLessThanOrEqual(fit!.clientWidth);
      expect(fit!.clientWidth).toBeLessThanOrEqual(fit!.innerWidth);
    });
  }
});
