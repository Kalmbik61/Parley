import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Редактор Monaco на собранном окне с `file://` (кусок 7.3b, тест 11): `pnpm dev:desktop` отдаёт
 * окно с `http://localhost`, и воркеры там создаются иначе, поэтому проверка воркеров и CSP —
 * только здесь. Клик по файлу в «Files» показывает его текст в Monaco; ни ошибок и
 * предупреждений `console`, ни `pageerror`, ни нарушений CSP (`securitypolicyviolation`), ни
 * «Could not create web worker» (Monaco молча ушёл бы в главный поток). Дальше — ⌘S пишет файл, а
 * правка «агента» на диске при несохранённых правках даёт баннер, а не перетирается.
 * Сценарии превью дописывает 7.5.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** Пробелы и кириллица в имени: путь модели Monaco без `%`-кодов, иначе воркер TS её не находит. */
const CYRILLIC = 'мой файл с пробелами.ts';
/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'e'.repeat(252)}.ts`;

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('редактор файла на собранном окне', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-editor-'));
    base = await makeTempProject('editor');
    project = path.join(base, 'project');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(project, 'src', CYRILLIC), 'export const b = 2;\n');
    await writeFile(path.join(project, LONG_FILE), 'long\n');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test('Files → a.ts: Monaco с текстом, воркеры без ошибок и нарушений CSP; ⌘S пишет; правка на диске — баннер', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    expect(await window.evaluate(() => location.protocol)).toBe('file:');

    await call(window, 'works.create', { projectPath: project, title: 'editor', goal: '' });
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();

    // С этого места — всё, что скажет окно: Monaco грузится по клику (ленивый чанк).
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

    await sidebar.getByText('src', { exact: true }).click();
    await sidebar.getByText('a.ts', { exact: true }).click();
    const editor = window.locator('.monaco-editor').first();
    await expect(editor.locator('.view-lines')).toContainText('export const a = 1;');

    // Воркер языка TS поднимается на первой модели: даём ему время сказать, если не смог.
    await window.waitForTimeout(1500);

    // ⌘S в Monaco — запись с диска открытого mtime.
    await editor.locator('.view-lines').click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// edited\n');
    const tab = window.locator('[role="tab"][data-tab-id="file:p:src/a.ts"]');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await window.keyboard.press('Meta+S');
    await expect(tab.locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// edited\n');

    // Правка человека не сохранена, а «агент» переписал файл: баннер, диск не тронут.
    await window.keyboard.type('// mine');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await writeFile(path.join(project, 'src', 'a.ts'), 'agent\n');
    const banner = window.getByTestId('disk-change-banner');
    await expect(banner).toContainText('File changed on disk (probably by the agent)');
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('agent\n');
    // «Reload» — текст с диска, правка человека отброшена его решением; буфер чистый.
    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(banner).toHaveCount(0);
    await expect(editor.locator('.view-lines')).toContainText('agent');
    await expect(tab.locator('[data-dirty-dot]')).toHaveCount(0);

    await sidebar.getByText(CYRILLIC, { exact: true }).click();
    await expect(window.locator('.monaco-editor .view-lines').first()).toContainText('export const b = 2;');
    await window.waitForTimeout(1500);

    const violations = await window.evaluate(() => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations);
    expect(violations).toEqual([]);
    expect(problems.filter((line) => line.includes('Could not create web worker'))).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('окно 800×500, имя на 255 символов: баннер изменения на диске и его кнопки не вылезают за окно', async () => {
    test.setTimeout(60_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'editor-narrow', goal: '' });
    // 800 px: рядом с левым сайдбаром правому нет места (раунд main-r2, п. 7) — левый прячем.
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.keyboard.press('Meta+B');
    await window.getByTestId('right-sidebar').locator(`[data-tree-path="${LONG_FILE}"]`).click();
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('long');
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('mine');
    await writeFile(path.join(project, LONG_FILE), 'agent\n');
    const banner = window.getByTestId('disk-change-banner');
    await expect(banner).toBeVisible();

    const overflow = await banner.evaluate((el) => {
      const problems: string[] = [];
      const box = el.getBoundingClientRect();
      if (box.right > window.innerWidth + 0.5) problems.push(`banner right ${Math.round(box.right)} > ${window.innerWidth}`);
      if (el.scrollWidth > el.clientWidth) problems.push(`banner scrollWidth ${el.scrollWidth} > ${el.clientWidth}`);
      for (const node of el.querySelectorAll('button, span')) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.right > box.right + 0.5) problems.push(`${node.textContent ?? ''} right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
      }
      if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
      return problems;
    });
    expect(overflow).toEqual([]);
    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(banner).toHaveCount(0);
  });
});
