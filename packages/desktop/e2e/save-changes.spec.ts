import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Вопрос о несохранённых правках при закрытии окна и ⌘Q на собранном окне (кусок 7.3a, тест 11):
 * правка файла → крестик окна — вопрос в самом окне, «Cancel» оставляет окно и правку; выход
 * приложения — тот же вопрос, «Don't save» — приложение закрылось, файл на диске прежний. Имя
 * файла на 255 символов: диалог и строка вкладок не вылезают за окно 800×500.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'s'.repeat(252)}.ts`;

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Что из диалога вылезло за его край или за окно — пустой список, если ничего. */
async function dialogOverflow(window: Page): Promise<string[]> {
  return window.getByTestId('save-changes-dialog').evaluate((el) => {
    const problems: string[] = [];
    const box = el.getBoundingClientRect();
    if (box.left < 0 || box.right > window.innerWidth + 0.5) problems.push(`dialog ${Math.round(box.left)}..${Math.round(box.right)} vs ${window.innerWidth}`);
    for (const node of el.querySelectorAll('h2, button, li')) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.right > box.right + 0.5) problems.push(`${node.tagName.toLowerCase()} right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
    }
    return problems;
  });
}

test.describe('несохранённые правки при закрытии окна', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-save-changes-'));
    base = await makeTempProject('save-changes');
    project = path.join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, LONG_FILE), 'export const answer = 42;\n');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test("крестик окна — вопрос, Cancel оставляет окно; выход — вопрос, Don't save — приложение закрылось", async () => {
    test.setTimeout(60_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    await call(window, 'works.create', { projectPath: project, title: 'save-changes', goal: '' });
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.locator(`[data-tree-path="${LONG_FILE}"]`).click();
    const editor = window.getByTestId('file-text');
    await expect(editor).toHaveValue('export const answer = 42;\n');
    await editor.click();
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await window.keyboard.type('// edited');
    const tab = window.locator(`[role="tab"][data-tab-id="file:p:${LONG_FILE}"]`);
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await expect(tab.locator(`[title="${LONG_FILE}"]`)).toBeVisible();

    // Крестик окна: main отложил закрытие и спросил окно.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveAttribute('title', `Save changes to ${LONG_FILE}?`);
    expect(await dialogOverflow(window)).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();

    // Выход (⌘Q идёт тем же путём — `before-quit`): тот же вопрос, «Don't save» — приложение закрылось.
    const closed = electronApp.waitForEvent('close');
    await electronApp.evaluate(({ app: electronAppMain }) => electronAppMain.quit());
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save all' })).toBeVisible();
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await closed;
    app = null;
    expect(await readFile(path.join(project, LONG_FILE), 'utf8')).toBe('export const answer = 42;\n');
  });
});
