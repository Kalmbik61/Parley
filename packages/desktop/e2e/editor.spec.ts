import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Редактор Monaco на собранном окне с `file://` (кусок 7.3b, тест 11): `pnpm dev:desktop` отдаёт
 * окно с `http://localhost`, и воркеры там создаются иначе, поэтому проверка воркеров и CSP —
 * только здесь. Клик по файлу в «Files» показывает его текст в Monaco; ни ошибок и
 * предупреждений `console`, ни `pageerror`, ни нарушений CSP (`securitypolicyviolation`), ни
 * «Could not create web worker» (Monaco молча ушёл бы в главный поток). Дальше — ⌘S пишет файл, а
 * правка «агента» на диске при несохранённых правках даёт баннер, а не перетирается.
 *
 * Превью (кусок 7.5, тесты 9–11): Markdown открывается превью, «Code» — Monaco того же буфера;
 * «Keep mine» и ⌘S — вопрос перезаписи; картинка и PDF из дерева — превью без ошибок `console`,
 * `pageerror` и нарушений CSP, ⌘F в PDF. Ссылки превью `http(s)` — вкладка встроенного браузера
 * (fix-7.5, спека 10.6) со страницей своего сервера на 127.0.0.1; журнал `PARLEY_SHELL` пуст —
 * браузер человека не открывается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** Пробелы и кириллица в имени: путь модели Monaco без `%`-кодов, иначе воркер TS её не находит. */
const CYRILLIC = 'мой файл с пробелами.ts';
/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'e'.repeat(252)}.ts`;

/** Markdown превью: заголовок, ссылка наружу (свой сервер теста) и картинка из корня (Blob, `img-src blob:`). */
const notesText = (origin: string): string => `# Notes\n\nSee [site](${origin}/notes).\n\n![logo](./logo.png)\n`;

/** PNG 3×2 px: картинка превью и её размер «3 × 2 px». */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Строка: байт фильтра и RGB на пиксель.
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array.from({ length: width * 3 }, () => 200)])));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PDF в одну страницу: текст Helvetica (стандартный шрифт без встраивания) и ссылка URI. */
function makePdf(uri: string): Buffer {
  const content = 'BT /F1 24 Tf 72 700 Td (Hello parley PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Annot /Subtype /Link /Rect [72 560 400 620] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('редактор файла на собранном окне', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;
  // Сервер страниц для ссылок превью: вкладка браузера грузит его, а не чужой сайт.
  let server: Server;
  let origin: string;
  let notes: string;

  test.beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Linked page</title><p>linked</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    notes = notesText(origin);
    home = await makeTempHome('editor');
    base = await makeTempProject('editor');
    project = path.join(base, 'project');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(project, 'src', CYRILLIC), 'export const b = 2;\n');
    await writeFile(path.join(project, LONG_FILE), 'long\n');
    await writeFile(path.join(project, 'notes.md'), notes);
    await writeFile(path.join(project, 'logo.png'), makePng(3, 2));
    await writeFile(path.join(project, 'doc.pdf'), makePdf(`${origin}/parley`));
  });

  /** Окно 1400×900 с работой над проектом; с этого места — сборщик ошибок и нарушений CSP. */
  async function launch(title: string): Promise<{ electronApp: ElectronApplication; window: Page; problems: string[] }> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    expect(await window.evaluate(() => location.protocol)).toBe('file:');
    await call(window, 'works.create', { projectPath: project, title, goal: '' });
    await expect(window.getByTestId('right-sidebar')).toBeVisible();
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
    return { electronApp, window, problems };
  }

  const cspViolations = (window: Page): Promise<string[]> =>
    window.evaluate(() => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations);

  const shellLog = (electronApp: ElectronApplication): Promise<unknown[]> =>
    electronApp.evaluate(() => [...((globalThis as { __parleyShell?: unknown[] }).__parleyShell ?? [])]);

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Адреса страниц `<webview>` — гостей вкладок браузера. */
  const guestUrls = (electronApp: ElectronApplication): Promise<string[]> =>
    electronApp.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((c) => c.getType() === 'webview')
        .map((c) => c.getURL()),
    );

  test('Files → a.ts: Monaco с текстом, воркеры без ошибок и нарушений CSP; ⌘S пишет; правка на диске — баннер', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
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
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
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

  // Раунд fix-7.3b (ревью 7.3b-B, Critical): сборка сжимала `#ffffff` в `#fff`, Monaco не принимал
  // короткий hex в `editor.background` — в светлой теме редактор не открывался вовсе. Тема — из
  // палитры (nativeTheme main), без эмуляции colorScheme; системная тема машины не влияет.
  test('светлая тема: Monaco с текстом; смена темы при открытом файле; ⌘S, ⌘D и ⌘W на живом окне', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') problems.push(`console.${message.type()}: ${message.text()}`);
    });
    const isDark = (): Promise<boolean> => window.evaluate(() => document.documentElement.classList.contains('dark'));
    const pickTheme = async (label: 'Theme: dark' | 'Theme: light'): Promise<void> => {
      await window.keyboard.press('Meta+J');
      await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
      await window.keyboard.type(label);
      await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(label);
      await window.keyboard.press('Enter');
      await expect(window.locator('[data-palette]')).toHaveCount(0);
    };
    /** Фон редактора — фон токена `--editor-surface` текущей темы: лист центра `--sheet` (светлая #f9f4ed, тёмная #0b0a09). */
    const editorBackground = (): Promise<string> =>
      window.locator('.monaco-editor .monaco-editor-background').first().evaluate((el) => getComputedStyle(el).backgroundColor);

    await pickTheme('Theme: light');
    await expect.poll(isDark).toBe(false);

    await call(window, 'works.create', { projectPath: project, title: 'editor-light', goal: '' });
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByText('src', { exact: true }).click();
    await sidebar.getByText('a.ts', { exact: true }).click();
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('export const a = 1;');
    await expect(window.getByText("Editor didn't load")).toHaveCount(0);
    expect(await editorBackground()).toBe('rgb(249, 244, 237)');

    // Смена темы при открытом файле — в обе стороны: редактор следует, текст на месте.
    await pickTheme('Theme: dark');
    await expect.poll(isDark).toBe(true);
    await expect.poll(editorBackground).toBe('rgb(11, 10, 9)');
    await expect(lines).toContainText('export const a = 1;');
    await pickTheme('Theme: light');
    await expect.poll(isDark).toBe(false);
    await expect.poll(editorBackground).toBe('rgb(249, 244, 237)');
    await expect(lines).toContainText('export const a = 1;');
    await expect(window.getByText("Editor didn't load")).toHaveCount(0);

    // Правка → ⌘S пишет.
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// saved\n');
    const tabSel = '[role="tab"][data-tab-id="file:p:src/a.ts"]';
    const tabs = window.locator(tabSel);
    await expect(tabs.first().locator('[data-dirty-dot]')).toBeVisible();
    await window.keyboard.press('Meta+S');
    await expect(tabs.first().locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// saved\n');

    // Несохранённая правка, вторая вкладка файла рядом, затем ⌘D с вкладкой a.ts (в редакторе ⌘D —
    // Monaco, поэтому через меню, как `shell.spec`). Вкладка файла в работе одна (id по пути), и
    // ⌘D переносит её в новую группу: тело монтируется заново, правка — из буфера стора.
    await window.keyboard.type('// mine');
    await expect(tabs.first().locator('[data-dirty-dot]')).toBeVisible();
    await sidebar.getByText(CYRILLIC, { exact: true }).click();
    await expect(lines).toContainText('export const b = 2;');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'group.splitRight'));
    await window.getByRole('dialog').getByRole('option', { name: /a\.ts/ }).first().click();
    await expect.poll(() => window.locator('[data-group-id]').count()).toBe(2);
    await expect(tabs).toHaveCount(1);
    const bodies = window.locator('.monaco-editor .view-lines');
    await expect(bodies).toHaveCount(2);
    await expect(bodies.filter({ hasText: '// mine' })).toHaveCount(1);
    await expect(tabs.locator('[data-dirty-dot]')).toBeVisible();

    // Закрытие другой группы (её чистый файл, ⌘W) — без вопроса, сплит схлопнулся, правка жива.
    const dialog = window.getByRole('dialog');
    await window.locator(`[role="tab"][data-tab-id="file:p:src/${CYRILLIC}"]`).click();
    await window.keyboard.press('Meta+W');
    await expect(window.locator(`[role="tab"][data-tab-id="file:p:src/${CYRILLIC}"]`)).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => window.locator('[data-group-id]').count()).toBe(1);
    await expect(tabs.locator('[data-dirty-dot]')).toBeVisible();
    await expect(window.locator('.monaco-editor .view-lines').first()).toContainText('// mine');

    // ⌘W последней вкладки с правкой — вопрос; Cancel оставляет, Don't save закрывает, диск прежний.
    await window.locator('.monaco-editor .view-lines').first().click();
    await window.keyboard.press('Meta+W');
    await expect(dialog).toContainText('Save changes to a.ts?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tabs).toHaveCount(1);
    await window.locator('.monaco-editor .view-lines').first().click();
    await window.keyboard.press('Meta+W');
    await expect(dialog).toContainText('Save changes to a.ts?');
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await expect(tabs).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// saved\n');

    expect(problems).toEqual([]);
  });

  test('7.5 тест 9: notes.md — превью; ссылка наружу — вкладка браузера, журнал shell пуст; Code, правка, ⌘S — диск изменён, ни баннера, ни Reloaded from disk', async () => {
    test.setTimeout(90_000);
    const { electronApp, window, problems } = await launch('preview-md');
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.getByText('notes.md', { exact: true }).click();
    const tab = window.locator('[role="tab"][data-tab-id="file:p:notes.md"]');
    await expect(tab).toBeVisible();
    const preview = window.getByTestId('markdown-preview');
    await expect(preview.getByRole('heading', { name: 'Notes' })).toBeVisible();
    // Картинка из корня — Blob, CSP `img-src blob:` её пускает.
    const logo = preview.locator('img[alt="logo"]');
    await expect(logo).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3);

    // http(s) — вкладка встроенного браузера рядом (fix-7.5), страница своего сервера; системный
    // браузер не зовётся (журнал пуст), окно на месте.
    await preview.getByText('site', { exact: true }).click();
    const browserTab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(browserTab).toHaveCount(1);
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/notes`]);
    await expect(browserTab).toContainText('Linked page');
    expect(await shellLog(electronApp)).toEqual([]);
    expect(await window.evaluate(() => location.protocol)).toBe('file:');
    await tab.click();

    await window.getByRole('radio', { name: 'Code' }).click();
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('# Notes');
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('edited line');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await window.keyboard.press('Meta+S');
    await expect(tab.locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'notes.md'), 'utf8')).toBe(`${notes}edited line`);
    // Своя запись — не «правка агента»: слежение её видит, но ни баннера, ни плашки.
    await window.waitForTimeout(1500);
    await expect(window.getByTestId('disk-change-banner')).toHaveCount(0);
    await expect(window.getByText('Reloaded from disk')).toHaveCount(0);

    await window.getByRole('radio', { name: 'Preview' }).click();
    await expect(preview.getByText('edited line')).toBeVisible();

    expect(await cspViolations(window)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('7.5 тест 10: правка без сохранения, запись на диск — баннер; Keep mine и ⌘S — вопрос; Overwrite — на диске буфер', async () => {
    test.setTimeout(90_000);
    const { window, problems } = await launch('preview-keep');
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.getByText('src', { exact: true }).click();
    await sidebar.getByText('a.ts', { exact: true }).click();
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('export const a = 1;');
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// mine');
    const tab = window.locator('[role="tab"][data-tab-id="file:p:src/a.ts"]');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();

    await writeFile(path.join(project, 'src', 'a.ts'), 'agent\n');
    const banner = window.getByTestId('disk-change-banner');
    await expect(banner).toContainText('File changed on disk (probably by the agent)');
    await banner.getByRole('button', { name: 'Keep mine' }).click();
    await expect(banner).toHaveCount(0);

    await lines.click();
    await window.keyboard.press('Meta+S');
    const dialog = window.getByRole('dialog');
    await expect(dialog).toContainText('File changed on disk after you opened it. Overwrite the changes on disk?');
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('agent\n');
    await dialog.getByRole('button', { name: 'Overwrite' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tab.locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// mine');
    expect(problems).toEqual([]);
  });

  test('Compare и закрытие сравнения любым путём — ни pageerror, ни console.error; баннер, правка и undo на месте (fix-7-accept п. 1)', async () => {
    test.setTimeout(120_000);
    const { electronApp, window, problems } = await launch('compare-close');
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.getByText('src', { exact: true }).click();
    await sidebar.getByText('a.ts', { exact: true }).click();
    const tab = window.locator('[role="tab"][data-tab-id="file:p:src/a.ts"]');
    const firstLines = window.locator('.monaco-editor:visible .view-lines').first();
    await expect(firstLines).toContainText('export const a = 1;');
    await firstLines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// mine');
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    await writeFile(path.join(project, 'src', 'a.ts'), 'agent\n');
    await expect(window.getByTestId('disk-change-banner')).toContainText('File changed on disk (probably by the agent)');
    // Всё о файле — в теле с баннером: после переноса в сплит рядом второй редактор.
    const body = window.locator('[data-group-body]').filter({ has: window.getByTestId('disk-change-banner') });
    const banner = body.getByTestId('disk-change-banner');
    const lines = body.locator('.monaco-editor:visible .view-lines').first();
    const compare = body.getByTestId('file-compare');
    const closeCompare = body.getByTestId('file-body').getByRole('button', { name: 'Close', exact: true });
    const openCompare = async (): Promise<void> => {
      await banner.getByRole('button', { name: 'Compare' }).click();
      await expect(compare.locator('.monaco-diff-editor')).toBeVisible();
      await expect(compare).toContainText('agent');
    };
    /** Сравнение закрыто: конфликт не решён — баннер виден, правка буфера на месте. */
    const expectBack = async (): Promise<void> => {
      await expect(compare).toHaveCount(0);
      await expect(banner).toBeVisible();
      await expect(lines).toContainText('// mine');
      await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    };
    // Дать Monaco досказать ошибку размонтирования, если она будет.
    const settle = (): Promise<void> => window.waitForTimeout(300);

    // 1. Compare на баннере → Close в шапке тела.
    await openCompare();
    await closeCompare.click();
    await expectBack();
    await settle();
    expect(problems).toEqual([]);

    // Undo обычного редактора пережил сравнение: ⌘Z снимает правку, ⇧⌘Z возвращает.
    await lines.click();
    await window.keyboard.press('Meta+Z');
    await expect(lines).not.toContainText('// mine');
    await window.keyboard.press('Meta+Shift+Z');
    await expect(lines).toContainText('// mine');

    // 2. Повторный Compare того же файла → Close.
    await openCompare();
    await closeCompare.click();
    await expectBack();

    // 3. ⌘S → конфликт → диалог перезаписи → Compare → Close; снова диалог → Cancel.
    await lines.click();
    await window.keyboard.press('Meta+S');
    const dialog = window.getByRole('dialog');
    await expect(dialog).toContainText('Overwrite the changes on disk?');
    await dialog.getByRole('button', { name: 'Compare' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(compare.locator('.monaco-diff-editor')).toBeVisible();
    await closeCompare.click();
    await expectBack();
    await settle();
    expect(problems).toEqual([]);

    // 4. Смена активной вкладки во время сравнения и обратно.
    await openCompare();
    await sidebar.getByText(CYRILLIC, { exact: true }).click();
    await expect(window.locator('.monaco-editor:visible .view-lines').first()).toContainText('export const b = 2;');
    await tab.click();
    if ((await compare.count()) > 0) await closeCompare.click();
    await expectBack();
    await settle();
    expect(problems).toEqual([]);

    // 5. Перенос вкладки в другую группу во время сравнения (тело монтируется заново).
    await openCompare();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'group.splitRight'));
    await window.getByRole('dialog').getByRole('option', { name: /a\.ts/ }).first().click();
    await expect.poll(() => window.locator('[data-group-id]').count()).toBe(2);
    await tab.click();
    if ((await compare.count()) > 0) await closeCompare.click();
    await expectBack();
    await settle();
    expect(problems).toEqual([]);

    // 6. Закрытие вкладки во время сравнения: вопрос → Cancel — вкладка и сравнение на месте; Don't save — закрыта.
    await openCompare();
    await tab.click();
    await window.keyboard.press('Meta+W');
    await expect(dialog).toContainText('Save changes to a.ts?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(tab).toHaveCount(1);
    await expect(compare).toHaveCount(1);
    await tab.click();
    await window.keyboard.press('Meta+W');
    await expect(dialog).toContainText('Save changes to a.ts?');
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await expect(tab).toHaveCount(0);
    await settle();
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('agent\n');
    expect(problems).toEqual([]);
  });

  test('7.5 тест 11: .png и .pdf из дерева — превью; ⌘F в PDF, ссылка PDF — вкладка браузера; данные pdf.js локально; ни ошибок, ни CSP', async () => {
    test.setTimeout(90_000);
    const { electronApp, window, problems } = await launch('preview-bin');
    const sidebar = window.getByTestId('right-sidebar');

    await sidebar.getByText('logo.png', { exact: true }).click();
    const image = window.getByTestId('image-preview');
    await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect(image.getByText('3 × 2 px')).toBeVisible();
    await image.getByRole('radio', { name: '100%' }).click();
    await expect(image.getByText('3 × 2 px')).toBeVisible();

    await sidebar.getByText('doc.pdf', { exact: true }).click();
    const pdf = window.getByTestId('pdf-preview');
    await expect(pdf.locator('.page canvas').first()).toBeVisible();
    await expect(pdf.locator('.textLayer').first()).toContainText('Hello parley PDF');

    // ⌘F — своя полоса поиска превью; подсветка совпадения в слое текста; Esc закрывает.
    await pdf.click({ position: { x: 20, y: 20 } });
    await window.keyboard.press('Meta+F');
    const find = pdf.getByPlaceholder('Find…');
    await expect(find).toBeFocused();
    await window.keyboard.type('parley');
    await expect(pdf.locator('.textLayer .highlight').first()).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(find).toHaveCount(0);

    // Ссылка аннотации: без href, клик — вкладка встроенного браузера (fix-7.5), журнал shell пуст,
    // окно не уходит со своей страницы.
    const link = pdf.locator('.annotationLayer .linkAnnotation a').first();
    await expect(link).not.toHaveAttribute('href', /./);
    await link.click();
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(1);
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/parley`]);
    expect(await shellLog(electronApp)).toEqual([]);
    expect(await window.evaluate(() => location.protocol)).toBe('file:');

    // cMap и стандартный шрифт читаются окном из сборки по file:// — CSP `connect-src 'self'` пускает.
    const sizes = await window.evaluate(async () => {
      const read = (relative: string): Promise<number> =>
        new Promise((resolve) => {
          const request = new XMLHttpRequest();
          request.open('GET', new URL(relative, document.baseURI).href);
          request.responseType = 'arraybuffer';
          request.onloadend = () => resolve((request.response as ArrayBuffer | null)?.byteLength ?? -1);
          request.send();
        });
      return [await read('pdfjs/cmaps/UniJIS-UCS2-H.bcmap'), await read('pdfjs/standard_fonts/FoxitSymbol.pfb')];
    });
    expect(sizes[0]).toBeGreaterThan(0);
    expect(sizes[1]).toBeGreaterThan(0);
    // Шрифтов Liberation (GPL) в сборке нет (fix-7.5): Helvetica без встраивания pdf.js рисует
    // системным шрифтом — текст страницы выше виден, ни ошибок, ни предупреждений.
    const fonts = await readdir(path.resolve(dirname, '../out/renderer/pdfjs/standard_fonts'));
    expect(fonts.filter((name) => /liberation/i.test(name))).toEqual([]);
    expect(fonts).toContain('LICENSE_FOXIT');

    await window.waitForTimeout(1000);
    expect(await cspViolations(window)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('fix-8.4b п. 1: сплит двух разных файлов — ⌘S и ⌥Z действуют на редактор в фокусе, а не на последний смонтированный', async () => {
    test.setTimeout(90_000);
    // Длинная строка без переноса — ⌥Z видно по числу визуальных строк.
    const long = `export const text = '${'word '.repeat(120)}';\n`;
    await writeFile(path.join(project, 'src', 'alpha.ts'), long);
    await writeFile(path.join(project, 'src', 'beta.ts'), long);
    const { electronApp, window, problems } = await launch('editor-split');
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.getByText('src', { exact: true }).click();
    // alpha, потом beta в той же группе (alpha уходит в фон), затем ⌘D с alpha: alpha монтируется
    // заново и становится последним смонтированным, а фокус — у beta (как в пробе линзы B).
    await sidebar.getByText('alpha.ts', { exact: true }).click();
    await expect(window.locator('.monaco-editor[data-uri$="alpha.ts"] .view-lines')).toContainText('export const text');
    await sidebar.getByText('beta.ts', { exact: true }).click();
    await expect(window.locator('.monaco-editor[data-uri$="beta.ts"] .view-lines')).toContainText('export const text');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'group.splitRight'));
    await window.getByRole('dialog').getByRole('option', { name: /alpha\.ts/ }).first().click();
    await expect.poll(() => window.locator('[data-group-id]').count()).toBe(2);
    const alpha = window.locator('.monaco-editor[data-uri$="alpha.ts"]');
    const beta = window.locator('.monaco-editor[data-uri$="beta.ts"]');
    await expect(alpha).toHaveCount(1);
    await expect(beta).toHaveCount(1);
    const alphaTab = window.locator('[role="tab"][data-tab-id="file:p:src/alpha.ts"]');
    const betaTab = window.locator('[role="tab"][data-tab-id="file:p:src/beta.ts"]');
    const wrapped = (editor: typeof alpha): Promise<number> => editor.locator('.view-line').count();
    // `.view-lines` длинной строки шире группы: середина — под соседней, клик — у начала строки.

    // ⌘S в beta — пишет beta, alpha на диске не тронут.
    await beta.locator('.view-lines').click({ position: { x: 20, y: 5 } });
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// beta');
    await expect(betaTab.locator('[data-dirty-dot]')).toBeVisible();
    await window.keyboard.press('Meta+S');
    await expect(betaTab.locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'beta.ts'), 'utf8')).toBe(`${long}// beta`);
    expect(await readFile(path.join(project, 'src', 'alpha.ts'), 'utf8')).toBe(long);

    // ⌘S в alpha — пишет alpha.
    await alpha.locator('.view-lines').click({ position: { x: 20, y: 5 } });
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// alpha');
    await expect(alphaTab.locator('[data-dirty-dot]')).toBeVisible();
    await window.keyboard.press('Meta+S');
    await expect(alphaTab.locator('[data-dirty-dot]')).toHaveCount(0);
    expect(await readFile(path.join(project, 'src', 'alpha.ts'), 'utf8')).toBe(`${long}// alpha`);
    expect(await readFile(path.join(project, 'src', 'beta.ts'), 'utf8')).toBe(`${long}// beta`);

    // ⌥Z в beta — перенос у beta, у alpha прежний; потом ⌥Z в alpha — у alpha.
    const alphaBefore = await wrapped(alpha);
    const betaBefore = await wrapped(beta);
    await beta.locator('.view-lines').click({ position: { x: 20, y: 5 } });
    await window.keyboard.press('Alt+KeyZ');
    await expect.poll(() => wrapped(beta)).toBeGreaterThan(betaBefore);
    expect(await wrapped(alpha)).toBe(alphaBefore);
    await alpha.locator('.view-lines').click({ position: { x: 20, y: 5 } });
    await window.keyboard.press('Alt+KeyZ');
    await expect.poll(() => wrapped(alpha)).toBeGreaterThan(alphaBefore);
    // ⌥Z не напечатал «Ω» ни в одном файле.
    await expect(alphaTab.locator('[data-dirty-dot]')).toHaveCount(0);
    await expect(betaTab.locator('[data-dirty-dot]')).toHaveCount(0);

    expect(problems).toEqual([]);
  });
});
