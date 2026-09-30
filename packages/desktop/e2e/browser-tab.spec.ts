import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вкладка браузера (кусок 9.2a, спека 12.1): «+» строки вкладок → палитра «Открыть…» → «New browser
 * tab» → заглушка с фокусом в адресной строке → адрес → `<webview>` со страницей; заголовок и
 * favicon страницы — во вкладке. Проверка на настоящем Electron: jsdom не знает ни `<webview>`, ни
 * `session.fetch`, ни CSP окна.
 *
 * Внешних сайтов нет — только свой сервер на 127.0.0.1. Настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

// PNG 1×1 — favicon страницы того же origin.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>Dev page</title><link rel="icon" href="/favicon.png"><p>dev page</p>',
  '/next': '<!doctype html><title>Next page</title><p>next</p>',
  // Значок своего origin отвечает 302 на другой локальный сервер (fix-9, SSRF).
  '/redir': '<!doctype html><title>Redirect page</title><link rel="icon" href="/redir-icon.png"><p>redir</p>',
};

let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

test.describe('вкладка браузера (кусок 9.2a)', () => {
  test.setTimeout(60_000);
  let home: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;
  // Второй сервер — «чужой локальный сервис»: обращений к нему быть не должно.
  let other: Server;
  let otherHits = 0;
  let redirIconHits = 0;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-tab');
    project = await makeTempProject('browser-tab');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/redir-icon.png') {
        redirIconHits += 1;
        res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/secret.png` }).end();
        return;
      }
      if (pathname === '/favicon.png') {
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      }
      const page = PAGES[pathname];
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    otherHits = 0;
    redirIconHits = 0;
    other = createServer((_req, res) => {
      otherHits += 1;
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  test('«+» → New browser tab → адрес: страница в webview, заголовок и favicon во вкладке; переход — loadURL в том же узле', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    // Работа с сессией; клик по строке сессии делает работу активной и открывает её терминал.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-browser', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'agent',
      task: '',
      parent: null,
    });
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${created.ref.sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${created.ref.sessionId}"]`)).toBeVisible();

    // «+» — палитра «Открыть…»; в ней без набора — «New browser tab».
    await window.getByRole('button', { name: 'Open…' }).first().click();
    const option = window.locator('[data-palette] [role="option"]', { hasText: 'New browser tab' });
    await expect(option).toBeVisible();
    await option.click();
    await expect(window.locator('[data-palette]')).toHaveCount(0);

    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await expect(window.locator('webview')).toHaveCount(0);
    const browserTab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(browserTab).toContainText('New tab');

    await address.fill(origin.replace('http://', ''));
    await address.press('Enter');

    const view = window.locator('webview');
    await expect(view).toHaveCount(1);
    await expect(view).toHaveAttribute('allowpopups', /.*/);
    const viewHandle = await view.elementHandle();
    await expect.poll(() => guestUrls(app as ElectronApplication)).toEqual([`${origin}/`]);
    await expect(browserTab).toContainText('Dev page');
    // Favicon: main скачал его сессией раздела и отдал окну как data: — CSP окна его пускает.
    const favicon = browserTab.locator('img');
    await expect(favicon).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => favicon.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);

    // Адресная строка живой страницы — loadURL в том же госте (src <webview> пишет сам Electron
    // адресом коммита — его окно не трогает): узел прежний, гость один, адрес — в раскладке.
    await address.fill(`${origin}/next`);
    await address.press('Enter');
    await expect(browserTab).toContainText('Next page');
    await expect.poll(() => guestUrls(app as ElectronApplication)).toEqual([`${origin}/next`]);
    expect(await view.evaluate((node, handle) => node === handle, viewHandle)).toBe(true);
    await expect(address).toHaveValue(`${origin}/next`);
  });

  test('значок отвечает 302 на другой сервер: main за редиректом не идёт, значка нет (fix-9, SSRF)', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-browser', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'agent',
      task: '',
      parent: null,
    });
    const row = window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${created.ref.sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await window.getByRole('button', { name: 'Open…' }).first().click();
    await window.locator('[data-palette] [role="option"]', { hasText: 'New browser tab' }).click();
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(`${origin}/redir`);
    await address.press('Enter');

    const browserTab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(browserTab).toContainText('Redirect page');
    // main запросил значок своего origin (получил 302) — и дальше не пошёл.
    await expect.poll(() => redirIconHits).toBeGreaterThanOrEqual(1);
    await window.waitForTimeout(1000);
    expect(otherHits).toBe(0);
    await expect(browserTab.locator('img')).toHaveCount(0);
  });
});
