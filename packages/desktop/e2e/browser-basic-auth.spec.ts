import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * HTTP basic-auth во встроенном браузере: сервер отвечает 401 + `WWW-Authenticate: Basic realm="Stand"`, пока нет верной пары.
 * - адрес `http://admin:s3cret@127.0.0.1:PORT/` в адресной строке открывает страницу; в строке и в layouts.json пароля нет;
 * - без пары над вкладкой появляется запрос: неверный пароль — запрос снова со строкой ошибки, верный — страница, Cancel — 401;
 * - агент: `browser_open` с `user:pass@` открывает страницу, ответ и раскладка без пароля; вкладка, ждущая запрос человека,
 *   отвечает агенту подсказкой (`browser_open`, `browser_snapshot`), а не зависанием.
 * Сервер свой, на 127.0.0.1; ввод человека — настоящий клик и набор в окне. Настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const USER = 'admin';
const PASSWORD = 's3cret';
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body), { method, params })) as T;
}

async function menu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, action) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', action);
  }, id);
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

async function guestTitle(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().find((c) => c.getType() === 'webview')?.getTitle() ?? null);
}

interface McpResult {
  session: string;
  tool: string;
  isError: boolean;
  text: string;
}

const readLines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);

test.describe('HTTP basic-auth во встроенном браузере', () => {
  test.setTimeout(120_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;
  /** Заголовки Authorization, пришедшие на защищённую страницу, по порядку: по ним видно, что пароль не ушёл куда не надо. */
  let seen: Array<string | undefined>;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-basic-auth');
    project = await makeTempProject('browser-basic-auth');
    mcpLog = path.join(home, 'mcp.jsonl');
    seen = [];
    server = createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(404).end();
        return;
      }
      seen.push(req.headers.authorization);
      if (req.headers.authorization === GOOD) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Stand</title><h1>Protected</h1>');
        return;
      }
      res
        .writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'www-authenticate': 'Basic realm="Stand"' })
        .end('<!doctype html><title>Denied</title><h1>Denied</h1>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function openApp() {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: path.join(home, 'no-codex'),
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_BRACKETED: '1',
      STUB_MCP_LOG: mcpLog,
      PARLEY_SKIP_VERSION_PROBE: '',
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    // 800×500: наименьшее окно, в котором оверлей обязан помещаться.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'wake.pause', {});
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-basic-auth', goal: '' });
    const lead = (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'lead', task: '', parent: null })).ref.sessionId;
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${lead}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    await window.waitForTimeout(800);
    return { electronApp, window, lead, workId };
  }

  /** Вкладка браузера человека и адрес в ней. */
  async function humanOpens(electronApp: ElectronApplication, window: Page, url: string): Promise<void> {
    await menu(electronApp, 'browser.newTab');
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(url);
    await address.press('Enter');
  }

  async function layoutsText(): Promise<string> {
    return readFile(path.join(home, 'desktop', 'layouts.json'), 'utf8').catch(() => '');
  }

  test('адрес с user:pass@ в адресной строке открывает страницу; в строке и в layouts.json пароля нет', async () => {
    const { electronApp, window } = await openApp();
    await humanOpens(electronApp, window, `http://${USER}:${PASSWORD}@${origin.slice('http://'.length)}/`);
    await expect.poll(() => guestTitle(electronApp), { timeout: 20_000 }).toBe('Stand');
    expect(await guestUrls(electronApp)).toEqual([`${origin}/`]);
    await expect(window.getByRole('textbox', { name: 'Address' })).toHaveValue(`${origin}/`);
    await expect(window.getByTestId('browser-auth')).toHaveCount(0);
    // Сервер получил пару ровно один раз: первый запрос шёл без заголовка, ответ на 401 — с ним.
    expect(seen).toEqual([undefined, GOOD]);
    await expect.poll(async () => (await layoutsText()).includes(`${origin}/`), { timeout: 10_000 }).toBe(true);
    expect(await layoutsText()).not.toContain(PASSWORD);
  });

  test('без пары — запрос над вкладкой: неверный пароль показывает его снова с ошибкой, верный открывает страницу; Cancel оставляет 401', async () => {
    const { electronApp, window } = await openApp();
    await humanOpens(electronApp, window, `${origin}/`);
    const prompt = window.getByTestId('browser-auth');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText(new URL(origin).host);
    await expect(prompt).toContainText('Realm: Stand');
    await expect(window.getByLabel('Password')).toHaveAttribute('type', 'password');
    // В 800×500 карточка целиком в окне, без прокрутки страницы.
    const box = await prompt.locator('form').boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? -1) + (box?.height ?? 0)).toBeLessThanOrEqual(500);
    expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(800);

    await window.getByLabel('Username').fill(USER);
    await window.getByLabel('Password').fill('wrong');
    await window.getByLabel('Password').press('Enter');
    await expect(prompt.getByRole('alert')).toHaveText('Wrong username or password. Try again.', { timeout: 15_000 });

    await window.getByLabel('Username').fill(USER);
    await window.getByLabel('Password').fill(PASSWORD);
    await window.getByLabel('Password').press('Enter');
    await expect.poll(() => guestTitle(electronApp), { timeout: 20_000 }).toBe('Stand');
    await expect(window.getByTestId('browser-auth')).toHaveCount(0);

    // Cancel: другой защищённый путь — снова запрос (Chromium кэширует пару для realm, поэтому новая вкладка, а не тот же путь).
    await humanOpens(electronApp, window, `http://localhost:${new URL(origin).port}/`);
    await expect(window.getByTestId('browser-auth')).toBeVisible({ timeout: 20_000 });
    await window.getByLabel('Username').press('Escape');
    await expect(window.getByTestId('browser-auth')).toHaveCount(0);
    await expect.poll(() => guestTitle(electronApp), { timeout: 20_000 }).not.toBeNull();
    expect(await layoutsText()).not.toContain(PASSWORD);
  });

  /** Инструмент `browser_*` агента `lead`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
  async function agentTool({ window, lead, workId }: { window: Page; lead: string; workId: string }, tool: string, args: Record<string, unknown>): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: lead }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 40_000 }).toBeGreaterThan(before);
    return (await readLines<McpResult>(mcpLog))[before] as McpResult;
  }

  test('агент: browser_open с user:pass@ открывает страницу без пароля в ответе и раскладке; вкладка с запросом отвечает подсказкой, а не зависанием', async () => {
    const opened = await openApp();
    const { electronApp } = opened;

    const withPair = await agentTool(opened, 'browser_open', { url: `http://${USER}:${PASSWORD}@${origin.slice('http://'.length)}/`, own: true });
    expect(withPair.isError, withPair.text).toBe(false);
    expect(withPair.text).not.toContain(PASSWORD);
    await expect.poll(() => guestTitle(electronApp), { timeout: 20_000 }).toBe('Stand');
    await expect.poll(async () => (await layoutsText()).includes(`${origin}/`), { timeout: 10_000 }).toBe(true);
    expect(await layoutsText()).not.toContain(PASSWORD);

    // Без пары: вкладка ждёт человека, агент получает подсказку в пределах обычного срока.
    const started = Date.now();
    const bare = await agentTool(opened, 'browser_open', { url: `http://localhost:${new URL(origin).port}/other`, own: true });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.text).toContain('HTTP basic auth');
    expect(bare.text).not.toContain(PASSWORD);
    expect(Date.now() - started).toBeLessThan(30_000);
    const tab = /Opened (t\d+):/.exec(bare.text)?.[1];
    expect(tab, bare.text).toBeDefined();

    const snapshot = await agentTool(opened, 'browser_snapshot', { tab });
    expect(snapshot.isError, snapshot.text).toBe(false);
    expect(snapshot.text).toContain('HTTP basic auth');
  });
});
