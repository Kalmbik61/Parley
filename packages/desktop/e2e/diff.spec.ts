import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вкладка диффа на Monaco на собранном окне (кусок 8.3): `DiffEditor` с воркерами на `file://` в
 * светлой теме. Сессия без worktree — стороны `HEAD` ↔ диск папки проекта: «Changes» правого
 * сайдбара, клик по файлу открывает вкладку диффа. Ни ошибок и предупреждений `console`, ни
 * `pageerror`, ни нарушений CSP; неизменённое свёрнуто (`hideUnchangedRegions`), «Inline» и
 * «Collapse all» / «Expand all» работают на живом редакторе. Git-репозиторий — только во временном каталоге.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 60 строк: правка в середине — неизменённое по краям Monaco сворачивает. */
const LINES = Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`);

test.describe('вкладка диффа на собранном окне', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('diff');
    project = await makeTempProject('diff');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'a.ts'), `${LINES.join('\n')}\n`);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 'e2e@example.com');
    git(project, 'config', 'user.name', 'e2e');
    git(project, 'config', 'commit.gpgsign', 'false');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'first');
    const edited = [...LINES];
    edited[30] = 'export const line30 = "changed";';
    await writeFile(path.join(project, 'src', 'a.ts'), `${edited.join('\n')}\n`);
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('светлая тема: Changes → файл — дифф на Monaco, неизменённое свёрнуто; Inline, свернуть и развернуть; ни ошибок, ни CSP', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    expect(await window.evaluate(() => location.protocol)).toBe('file:');

    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') problems.push(`console.${message.type()}: ${message.text()}`);
    });
    await window.evaluate(() => {
      const store = globalThis as unknown as { __cspViolations: string[] };
      store.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        store.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    // Светлая тема — через палитру, как editor.spec тест 3.
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Theme: light');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('Theme: light');
    await window.keyboard.press('Enter');
    await expect.poll(() => window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-diff', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'diff', task: '', parent: null });
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Changes' }).click();
    // Терминал сессии не открывали — сессии в фокусе нет: выбор в шапке «Changes».
    await sidebar.getByRole('combobox', { name: 'Session' }).click();
    await window.getByRole('option', { name: /diff/ }).click();
    await sidebar.getByRole('button', { name: /a\.ts/ }).first().click();

    const tab = window.getByTestId('diff-tab');
    await expect(tab).toBeVisible();
    const diffEditor = tab.locator('.monaco-diff-editor');
    await expect(diffEditor).toHaveCount(1);
    await expect(diffEditor.locator('.editor.modified .view-lines').last()).toContainText('"changed"');
    // Неизменённое свёрнуто (`hideUnchangedRegions`): по 27 строк сверху и снизу — плашками
    // (у каждой стороны свои; в двух колонках сверяем правую).
    await expect(diffEditor.locator('.editor.modified').getByText('27 hidden lines')).toHaveCount(2);
    await expect(window.getByText("Editor didn't load")).toHaveCount(0);
    const background = await diffEditor.locator('.editor.modified .monaco-editor-background').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    // Фон редактора — лист центра `--sheet` светлой темы (#f9f4ed).
    expect(background).toBe('rgb(249, 244, 237)');

    // Раунд fix-live, D1: окно 1400×900 с обоими сайдбарами — вкладка уже 900 px, порога Monaco
    // `useInlineViewWhenSpaceIsLimited`. Опция выключена: «Side by side» — две колонки при любой
    // ширине, левый редактор шире полосы номеров.
    expect((await tab.boundingBox())?.width ?? Infinity).toBeLessThan(900);
    const original = diffEditor.locator('.editor.original');
    const sideBySide = tab.getByRole('radio', { name: 'Side by side' });
    await expect(sideBySide).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await original.boundingBox())?.width ?? 0).toBeGreaterThan(200);

    // «Inline» — выбор записан, одна колонка: левый редактор сжат до полосы номеров; редактор жив.
    const inline = tab.getByRole('radio', { name: 'Inline' });
    await inline.click();
    await expect(inline).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await original.boundingBox())?.width ?? 0).toBeLessThan(100);
    await expect(diffEditor.locator('.editor.modified .view-lines').last()).toContainText('"changed"');
    // Снова «Side by side» — снова две колонки.
    await sideBySide.click();
    await expect.poll(async () => (await original.boundingBox())?.width ?? 0).toBeGreaterThan(200);
    // «Collapse all» освобождает редактор, «Expand all» возвращает.
    await tab.getByRole('button', { name: 'Collapse all' }).click();
    await expect(tab.locator('.monaco-diff-editor')).toHaveCount(0);
    await tab.getByRole('button', { name: 'Expand all' }).click();
    await expect(tab.locator('.monaco-diff-editor')).toHaveCount(1);

    expect(problems).toEqual([]);
    expect(await window.evaluate(() => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
  });

  test('fix-live D3: 800×500 — панель вкладки диффа переносится, а не прокручивается; ни одна кнопка не обрезана', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-diff', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'diff', task: '', parent: null });
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Changes' }).click();
    await sidebar.getByRole('combobox', { name: 'Session' }).click();
    await window.getByRole('option', { name: /diff/ }).click();
    await sidebar.getByRole('button', { name: /a\.ts/ }).first().click();

    const tab = window.getByTestId('diff-tab');
    await expect(tab.locator('.monaco-diff-editor')).toHaveCount(1);
    // Вкладка открыта — сжимаем окно, как приёмка: 800×500, правый сайдбар остаётся.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect.poll(() => window.evaluate(() => window.innerWidth)).toBe(800);
    // Узкая область, как у приёмки (450–520 px): все кнопки в одну строку не входят.
    expect((await tab.boundingBox())?.width ?? Infinity).toBeLessThan(560);
    // Панель — родитель группы «Inline / Side by side».
    const toolbar = tab.getByRole('radio', { name: 'Inline' }).locator('xpath=../..');
    const buttons = [
      tab.getByRole('radio', { name: 'Inline' }),
      tab.getByRole('radio', { name: 'Side by side' }),
      tab.getByRole('button', { name: 'Collapse all' }),
      tab.getByRole('button', { name: 'Expand all' }),
      tab.getByRole('button', { name: 'Wrap lines' }),
      tab.getByRole('button', { name: /^Send all unsent/ }),
      tab.getByRole('button', { name: 'Choose recipient' }),
      tab.getByRole('radio', { name: 'List' }),
      tab.getByRole('radio', { name: 'Tree' }),
    ];
    const bar = await toolbar.boundingBox();
    if (bar === null) throw new Error('нет панели');
    for (const button of buttons) {
      const box = await button.boundingBox();
      if (box === null) throw new Error(`нет кнопки ${String(button)}`);
      const inside = box.x >= bar.x - 0.5 && box.y >= bar.y - 0.5 && box.x + box.width <= bar.x + bar.width + 0.5 && box.y + box.height <= bar.y + bar.height + 0.5;
      expect(inside, `${String(button)} ${JSON.stringify(box)} вне ${JSON.stringify(bar)}`).toBe(true);
    }
    // Прокрутки нет: всё видно без неё.
    expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // List / Tree прижаты вправо и на второй строке.
    const tree = await buttons[8]?.boundingBox();
    expect(bar.x + bar.width - ((tree?.x ?? 0) + (tree?.width ?? 0))).toBeLessThan(16);
  });
});
