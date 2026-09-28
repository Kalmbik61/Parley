import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Правый сайдбар и вкладка «Файлы» на собранном окне (кусок 7.2): дерево корня проекта из
 * `/private/var/folders/…`, имя файла и папки на 255 символов, название работы на 120 — в окне
 * 800×500 и в широком ничего не вылезает за край сайдбара, длинное обрезано многоточием. Клик по
 * файлу открывает вкладку с его текстом (Monaco с 7.3b), ⌘L прячет сайдбар.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const LONG_TITLE = `files-sidebar-${'W'.repeat(106)}`;
/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'f'.repeat(252)}.ts`;
const LONG_DIR = 'd'.repeat(255);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Что вылезло за правый край правого сайдбара или окна — пустой список, если ничего. */
async function overflowOf(window: Page): Promise<string[]> {
  return window.getByTestId('right-sidebar').evaluate((el) => {
    const problems: string[] = [];
    const box = el.getBoundingClientRect();
    if (box.right > window.innerWidth + 0.5) problems.push(`sidebar right ${Math.round(box.right)} > window ${window.innerWidth}`);
    if (el.scrollWidth > el.clientWidth) problems.push(`sidebar scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
    for (const node of el.querySelectorAll('[data-tree-path], [role="combobox"], button, [role="tab"]')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > box.right + 0.5) {
        problems.push(`${node.tagName.toLowerCase()} «${(node.textContent ?? '').slice(0, 20)}» right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
      }
    }
    return problems;
  });
}

for (const size of [
  { width: 800, height: 500 },
  { width: 1600, height: 1000 },
]) {
  test.describe(`правый сайдбар «Файлы», окно ${size.width}x${size.height}`, () => {
    let home: string;
    let base: string;
    let project: string;
    let app: ElectronApplication | null = null;

    test.beforeEach(async () => {
      home = await makeTempHome('files-sidebar');
      base = await makeTempProject('files-sidebar');
      project = path.join(base, 'a-rather-long-project-folder-name-for-files-sidebar');
      await mkdir(path.join(project, 'src'), { recursive: true });
      await mkdir(path.join(project, LONG_DIR));
      await writeFile(path.join(project, LONG_FILE), 'long\n');
      await writeFile(path.join(project, 'src', 'app.ts'), 'export const answer = 42;\n');
    });

    test.afterEach(async () => {
      await stopApp(app);
      app = null;
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    });

    test('длинные имена обрезаны, ничего не вылезает; клик открывает текст файла; ⌘L прячет сайдбар', async () => {
      test.setTimeout(60_000);
      const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), size);
      await expect(window.getByTestId('landing')).toBeVisible();

      await call(window, 'works.create', { projectPath: project, title: LONG_TITLE, goal: '' });
      // 800 px: рядом с левым сайдбаром правому нет места (раунд main-r2, п. 7) — левый прячем.
      if (size.width < 1000) {
        await expect(window.getByTestId('app-shell')).toBeVisible();
        await window.keyboard.press('Meta+B');
      }
      const sidebar = window.getByTestId('right-sidebar');
      await expect(sidebar).toBeVisible();
      await expect(sidebar.getByRole('tab', { name: 'Files' })).toBeVisible();
      await expect(sidebar.getByRole('combobox')).toContainText('Project');

      const longFile = sidebar.locator(`[data-tree-path="${LONG_FILE}"]`);
      await expect(longFile).toBeVisible();
      await expect(longFile).toHaveAttribute('title', LONG_FILE);
      await expect(sidebar.locator(`[data-tree-path="${LONG_DIR}"]`)).toBeVisible();
      expect(await overflowOf(window)).toEqual([]);

      await sidebar.getByText('src', { exact: true }).click();
      await sidebar.getByText('app.ts', { exact: true }).click();
      await expect(window.locator('.monaco-editor .view-lines').first()).toContainText('export const answer = 42;');
      await expect(window.getByText("Couldn't show layout")).toHaveCount(0);
      expect(await overflowOf(window)).toEqual([]);

      await window.keyboard.press('Meta+L');
      await expect(sidebar).toHaveCount(0);
      await window.keyboard.press('Meta+Shift+E');
      await expect(window.getByTestId('right-sidebar')).toBeVisible();
    });
  });
}

/** Ширина центра — видимого контейнера активной работы. */
async function centerWidth(window: Page): Promise<number> {
  return window.evaluate(() => {
    const shown = [...document.querySelectorAll<HTMLElement>('[data-work-container]')].find((el) => el.style.visibility !== 'hidden');
    return shown?.getBoundingClientRect().width ?? 0;
  });
}

// Раунд main-r2, п. 7 (ревью 7.2-A, Important 3): оба сайдбара по умолчанию на 800 px оставляли
// центру ~170 px. Правый не оставляет центру меньше reserveCenter; не влезает — скрыт на время.
test.describe('правый сайдбар не отнимает центр, окно 800x500', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('files-sidebar');
    project = await makeTempProject('files-sidebar-center');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('центр ≥ 240 px, правый скрыт на время; ⌘L — тост; окно шире — сайдбар вернулся', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    const setSize = (width: number, height: number): Promise<unknown> =>
      electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), { width, height });
    await setSize(800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();

    await call(window, 'works.create', { projectPath: project, title: LONG_TITLE, goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect.poll(() => centerWidth(window)).toBeGreaterThanOrEqual(240);
    await expect(window.getByTestId('right-sidebar')).toHaveCount(0);

    await window.keyboard.press('Meta+L');
    await expect(window.getByText('Not enough room for the right sidebar')).toBeVisible();
    await expect(window.getByTestId('right-sidebar')).toHaveCount(0);

    await setSize(1400, 900);
    await expect(window.getByTestId('right-sidebar')).toBeVisible();
    expect(await centerWidth(window)).toBeGreaterThanOrEqual(320);
  });
});
