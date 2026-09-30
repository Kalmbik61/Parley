import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Реестр корней main, `files.locate`, `app.openPath` и `app.showInFinder` на собранном окне
 * (кусок 5.2, спека 10.8). Настоящие `shell.openPath` и `shell.showItemInFolder` открыли бы
 * приложение и Finder на экране человека: `HARNAS_SHELL=log` (`playwright.config.ts`) пишет их
 * в журнал main, тест читает его через `app.evaluate` (`globalThis.__parleyShell`).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

type ShellEntry = { action: 'openPath' | 'showItemInFolder'; path: string } | { action: 'openExternal'; url: string };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Вызов `window.parley.<группа>.<метод>` из рендерера: ответ или текст ошибки, как его видит окно. */
async function bridge(window: Page, group: 'app' | 'files', method: string, args: unknown[]): Promise<{ ok: unknown } | { error: string }> {
  return window.evaluate(
    async ([g, m, a]) => {
      const api = (globalThis as unknown as { parley: Record<string, Record<string, (...x: unknown[]) => Promise<unknown>>> }).parley;
      try {
        return { ok: await api[g]![m]!(...a) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    [group, method, args] as const,
  );
}

async function shellLog(app: ElectronApplication): Promise<ShellEntry[]> {
  return app.evaluate(() => [...((globalThis as { __parleyShell?: ShellEntry[] }).__parleyShell ?? [])]);
}

test.describe('файлы и корни main (кусок 5.2)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('files');
    project = await makeTempProject('files');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('locate находит файл работы; openPath открывает белый список, скрипт показывает в Finder, путь вне корней — files:denied', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    const notes = path.join(project, 'notes.txt');
    const script = path.join(project, 'run.command');
    await writeFile(notes, 'hello');
    await writeFile(script, 'echo hi');
    await chmod(script, 0o755);

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-files', goal: '' });
    const key = `${project} ${workId}`;

    // Реестр main строится из works.changed после создания работы — ждём, пока путь найдётся.
    await expect
      .poll(async () => bridge(window, 'files', 'locate', [key, [notes, '/etc/hosts']]), { timeout: 5_000 })
      .toEqual({
        ok: [
          { root: { workKey: key, spec: { kind: 'project' } }, relPath: 'notes.txt', stat: expect.objectContaining({ kind: 'file', size: 5 }) },
          null,
        ],
      });

    expect(await bridge(window, 'app', 'openPath', [notes])).toEqual({ ok: 'opened' });
    expect(await bridge(window, 'app', 'openPath', [script])).toEqual({ ok: 'revealed' });
    expect(await bridge(window, 'app', 'showInFinder', [notes])).toEqual({ ok: undefined });

    const denied = await bridge(window, 'app', 'openPath', ['/etc/hosts']);
    expect('error' in denied && denied.error).toContain('"code":"files:denied"');

    // Внешний адрес — тоже в журнал, а не в браузер человека (раунд fix-main-r1).
    expect(await bridge(window, 'app', 'openExternal', ['https://example.com/docs'])).toEqual({ ok: undefined });

    expect(await shellLog(electronApp)).toEqual([
      { action: 'openPath', path: notes },
      { action: 'showItemInFolder', path: script },
      { action: 'showItemInFolder', path: notes },
      { action: 'openExternal', url: 'https://example.com/docs' },
    ]);
  });
});
