import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Сегмент «Agents» в строке статуса (спека сна агентов и ёмкости, 4.5): потолок машины 2 (`PARLEY_MACHINE_CONCURRENT`),
 * давление памяти `warn` из файла (`PARLEY_MEMORY_PRESSURE_FILE`), три сессии из окна: человек не упирается в потолок,
 * поэтому живых 3 из 2. Текст сегмента совпадает с ответом хоста `capacity.get`; в окне 800×500 строка статуса не
 * переполняется, виден только значок (имена провайдеров целы), полный текст в title; поповер показывает строку памяти. Раскладка — при масштабе 1 и 2.
 * Агент — эхо-заглушка, настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

interface Capacity {
  machine: { live: number; limit: number | null; queued: number; pressure: string; swapGb: number | null; sleepMinutes: number | null };
  queue: unknown[];
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Parley).parley.call(m, p), [method, params] as const) as Promise<T>;
}

test.describe('ёмкость машины в строке статуса', () => {
  let home: string;
  let project: string;
  let pressureDir: string;
  let pressureFile: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('capacity');
    project = await makeTempProject('capacity');
    // Рычаг давления памяти: файл со словом `warn`; настоящий датчик macOS тест не читает.
    pressureDir = await mkdtemp(path.join(tmpdir(), 'parley-e2e-capacity-pressure-'));
    pressureFile = path.join(pressureDir, 'pressure');
    await writeFile(pressureFile, 'warn');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(pressureDir, { recursive: true, force: true });
  });

  async function launch(extraArgs: string[] = []): Promise<{ application: ElectronApplication; window: Page }> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_MACHINE_CONCURRENT: '2',
      PARLEY_MEMORY_PRESSURE_FILE: pressureFile,
    };
    const application = await electron.launch({ args: [mainEntry, ...extraArgs], env });
    app = application;
    const window = await application.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    const work = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-capacity', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    for (const label of ['one', 'two', 'three']) {
      await call(window, 'sessions.create', { projectPath: project, workId: work.workId, provider: 'claude', label, task: '', parent: null });
    }
    // Хост шлёт числа не сразу: ждём, пока он увидит все три сессии и давление из файла.
    await expect
      .poll(async () => {
        const { machine } = await call<Capacity>(window, 'capacity.get', {});
        return `${machine.live}/${machine.limit} ${machine.pressure}`;
      }, { timeout: 30_000 })
      .toBe('3/2 warn');
    return { application, window };
  }

  async function resize(application: ElectronApplication, width: number, height: number): Promise<void> {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
  }

  test('текст сегмента совпадает с capacity.get; поповер показывает память', async () => {
    test.setTimeout(90_000);
    const { application, window } = await launch();
    await resize(application, 1440, 900);

    const { machine } = await call<Capacity>(window, 'capacity.get', {});
    const segment = window.locator('[data-capacity-segment]');
    await expect(segment).toBeVisible();
    // Живых больше потолка, очереди нет, память `warn` — ровно такой текст собирает окно из снимка хоста.
    const expected = `Agents ${machine.live}/${machine.limit} · memory ${machine.pressure}`;
    expect(expected).toBe('Agents 3/2 · memory warn');
    await expect(segment).toHaveAttribute('title', expected);
    await expect(segment).toContainText(expected);

    await segment.click();
    const dialog = window.getByRole('dialog', { name: 'Agents on this machine' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^Memory: warn/)).toBeVisible();
    await expect(dialog.getByText('Live: 3 of 2')).toBeVisible();
    // Анимация открытия поповера закончена: иначе снимок ловит его полупрозрачным.
    await expect(dialog).toHaveCSS('opacity', '1');
    await window.screenshot({ path: test.info().outputPath('capacity-1440x900.png') });
  });

  for (const dpr of [1, 2]) {
    test(`в окне 800×500 строка статуса не переполняется, виден только значок (масштаб ${dpr})`, async () => {
      test.setTimeout(90_000);
      const { application, window } = await launch([`--force-device-scale-factor=${dpr}`]);
      await resize(application, 800, 500);

      const segment = window.locator('[data-capacity-segment]');
      await expect(segment).toBeVisible();
      await expect(segment).toBeInViewport({ ratio: 1 });
      // Ниже 960 px оба текста скрыты (display none), виден один значок; полный текст остаётся в title.
      const spans = segment.locator('span');
      await expect(spans).toHaveCount(2);
      await expect(spans.nth(0)).toHaveCSS('display', 'none');
      await expect(spans.nth(1)).toHaveCSS('display', 'none');
      await expect(segment.locator('svg')).toBeVisible();
      await expect(segment).toHaveAttribute('title', 'Agents 3/2 · memory warn');

      // Корень строки статуса — дед сегмента (сегмент → правая группа → строка): ничто не выпирает за её границы.
      const fit = await segment.evaluate((el) => {
        const root = el.parentElement?.parentElement;
        if (!root) return null;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          innerWidth: el.ownerDocument.defaultView!.innerWidth,
          groupRight: el.parentElement!.getBoundingClientRect().right,
        };
      });
      expect(fit).not.toBeNull();
      expect(fit!.scrollWidth).toBeLessThanOrEqual(fit!.clientWidth);
      expect(fit!.clientWidth).toBeLessThanOrEqual(fit!.innerWidth);
      expect(fit!.groupRight).toBeLessThanOrEqual(fit!.innerWidth);

      await segment.click();
      const dialog = window.getByRole('dialog', { name: 'Agents on this machine' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/^Memory: warn/)).toBeVisible();
      await expect(dialog).toBeInViewport({ ratio: 1 });
      // Анимация открытия поповера закончена: иначе снимок ловит его полупрозрачным.
      await expect(dialog).toHaveCSS('opacity', '1');
      await window.screenshot({ path: test.info().outputPath(`capacity-800x500-dpr${dpr}.png`) });
    });
  }
});
