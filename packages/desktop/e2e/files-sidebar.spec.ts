import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Правый сайдбар и вкладка «Файлы» на собранном окне (кусок 7.2): дерево корня проекта из
 * `/private/var/folders/…`, имя файла и папки на 255 символов, название работы на 120 — в окне
 * 800×500 и в широком ничего не вылезает за край сайдбара, длинное обрезано многоточием. Клик по
 * файлу открывает вкладку с его текстом (временное тело до 7.3b), ⌘L прячет сайдбар.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const LONG_TITLE = `files-sidebar-${'W'.repeat(106)}`;
/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'f'.repeat(252)}.ts`;
const LONG_DIR = 'd'.repeat(255);

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

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
      home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-files-sidebar-'));
      base = await makeTempProject('files-sidebar');
      project = path.join(base, 'a-rather-long-project-folder-name-for-files-sidebar');
      await mkdir(path.join(project, 'src'), { recursive: true });
      await mkdir(path.join(project, LONG_DIR));
      await writeFile(path.join(project, LONG_FILE), 'long\n');
      await writeFile(path.join(project, 'src', 'app.ts'), 'export const answer = 42;\n');
    });

    test.afterEach(async () => {
      await app?.close().catch(() => {});
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
      await expect(window.getByTestId('file-text')).toHaveText('export const answer = 42;\n');
      await expect(window.getByText("Couldn't show layout")).toHaveCount(0);
      expect(await overflowOf(window)).toEqual([]);

      await window.keyboard.press('Meta+L');
      await expect(sidebar).toHaveCount(0);
      await window.keyboard.press('Meta+Shift+E');
      await expect(window.getByTestId('right-sidebar')).toBeVisible();
    });
  });
}
