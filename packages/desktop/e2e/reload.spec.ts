import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Перезагрузка страницы окна (раунд fix-7.3, п. 4): после `webContents.reload()` окно снова на
 * связи с хостом, а не на «Connecting to host…»; перезагрузка с несохранённой правкой идёт через
 * тот же вопрос, что закрытие окна: Cancel — страница та же, правка на месте; Don't save — страница
 * перезагружена, файл на диске прежний.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Перезагрузка из main, как из DevTools; ответ evaluate — до начала перезагрузки. */
async function reload(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    setImmediate(() => contents?.reload());
  });
}

/** Метка на странице: пропала — страница перезагрузилась. */
async function markPage(window: Page): Promise<void> {
  await window.evaluate(() => {
    (globalThis as { __harnasPageMark?: boolean }).__harnasPageMark = true;
  });
}

async function samePage(window: Page): Promise<boolean> {
  return window.evaluate(() => (globalThis as { __harnasPageMark?: boolean }).__harnasPageMark === true);
}

test.describe('перезагрузка окна', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('reload');
    base = await makeTempProject('reload');
    project = path.join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'a.ts'), 'export const answer = 42;\n');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test('без правок — перезагрузка, окно снова на связи; с правкой — вопрос: Cancel оставляет, Don\'t save перезагружает', async () => {
    test.setTimeout(60_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'reload', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();

    // Без правок: вопроса нет, новая страница снова видит хост.
    await markPage(window);
    await reload(electronApp);
    await expect.poll(() => samePage(window).catch(() => true)).toBe(false);
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(window.getByText('Connecting to host…')).toHaveCount(0);

    // Правка файла, перезагрузка — тот же вопрос, что при закрытии окна.
    await window.getByTestId('right-sidebar').locator('[data-tree-path="a.ts"]').click();
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('export const answer = 42;');
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// edited');
    const tab = window.locator('[role="tab"][data-tab-id="file:p:a.ts"]');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await markPage(window);

    // Отмену выгрузки решает main (`will-prevent-unload` без preventDefault — выгрузка отменена), но
    // Playwright по CDP тоже видит этот диалог beforeunload и без обработчика отвечает на него сам —
    // ошибкой протокола «No dialog is showing». Обработчик здесь только гасит её; после ответа
    // «закрыть» страница выгрузку не отменяет, и диалога нет вовсе.
    window.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') void dialog.dismiss().catch(() => {});
    });
    await reload(electronApp);
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await samePage(window)).toBe(true);
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    // Отменённая перезагрузка не сбила счёт грязных в main: крестик окна по-прежнему спрашивает.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await samePage(window)).toBe(true);

    await reload(electronApp);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await expect.poll(() => samePage(window).catch(() => true)).toBe(false);
    await expect(window.getByTestId('app-shell')).toBeVisible();
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n');
  });
});
