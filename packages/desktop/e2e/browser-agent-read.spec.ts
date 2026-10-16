import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Агент читает страницы браузера своего чата и своих комнат (этап C, спека 2026-10-07-browser-devtools-agent-design.md,
 * 3.10, 5.1, 5.2, 6): инструменты `browser_tabs`, `browser_console`, `browser_network`, `browser_screenshot` настоящего
 * `parley-mcp` через настоящий эндпоинт хоста и настоящее окно (каркас — `browser-agent-open.spec.ts`).
 * - страницы панели чата и панели комнаты; консоль, сеть с маской секретов на настоящей странице, снимок 375×812;
 * - снимок страницы закрытой панели комнаты и возврат размера человека;
 * - чужой хозяин: страница чата другой сессии и комнаты, где сессия не участник, недоступна;
 * - пауза панели («Pause agents») и перезагрузка окна: реестр восстанавливается, пауза сохраняется.
 *
 * Страницы встают в панели через `browser_open`: ответ окна называет страницу `bp-…`, вкладок человека здесь нет.
 * Блок `image` ответа проверяют юнит-тесты core: заглушка агента журналит только текст, поэтому здесь — путь и PNG из файла.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const SECRETS = ['SECRET123', 'SECRET-AUTH', 'hunter2', 'S3SS10N'];

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body), { method, params })) as T;
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

/** JS в мире страницы гостя — только у теста: окну и агенту этого не дано. Адрес гостя — точный. */
async function guestEval<T>(app: ElectronApplication, url: string, code: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [u, c]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL() === u);
      return guest === undefined ? null : ((await guest.executeJavaScript(c)) as unknown);
    },
    [url, code] as const,
  ) as Promise<T | null>;
}

/** Ширина и высота PNG из заголовка IHDR. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const PAGE_HTML = `<!doctype html><title>Agent page</title><h1>Agent page</h1><img src="/missing.png">
<script>
console.error('boom from page');
console.warn('careful from page');
fetch('/api/settings?token=SECRET123&page=2', {
  method: 'POST',
  headers: { Authorization: 'Bearer SECRET-AUTH', 'Content-Type': 'application/json' },
  body: '{"user":{"name":"ann","password":"hunter2"}}',
});
</script>`;

test.describe('агент читает страницы браузера чата и комнаты (этап C)', () => {
  test.setTimeout(150_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-agent-read');
    project = await makeTempProject('browser-agent-read');
    mcpLog = path.join(home, 'mcp.jsonl');
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url.startsWith('/api/settings')) {
        req.resume();
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"db down","session":"S3SS10N"}');
      } else if (url.startsWith('/missing.png')) {
        res.writeHead(404).end();
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
      }
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

  /** Окно, работа с тремя сессиями и двумя комнатами: в `roomId` ведущая сессия участник, в `foreignRoomId` — нет. Chat ведущей на экране. */
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
            // Проба версий включена: у claude есть вид Chat.
      PARLEY_SKIP_VERSION_PROBE: '',
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    // Будильник печатал бы в терминал заглушки указатели на письма, склеиваясь со строками вызовов.
    await call(window, 'wake.pause', {});

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-agent-read', goal: '' });
    const create = async (label: string): Promise<string> =>
      (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null })).ref.sessionId;
    const lead = await create('lead');
    const second = await create('second');
    const third = await create('third');
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${lead}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    // Заглушка включает bracketed paste после готовности: дать ей догрузиться, чтобы Chat не мигнул терминалом.
    await window.waitForTimeout(800);
    const room = async (title: string, members: string[]): Promise<string> =>
      (await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title, members, lead: members[0], quiet: true })).roomId;
    const roomId = await room('own-room', [lead, second]);
    const foreignRoomId = await room('foreign-room', [second, third]);
    // Как в browser-agent-open.spec.ts: `owners` канала берутся из снимка работ хоста, а он отстаёт от `rooms.create`; окно рисует
    // комнату из того же снимка.
    await expect(window.locator(`[data-work-key="${workKey}"] [data-room-row="${roomId}"]`).first()).toBeVisible();
    await expect(window.locator(`[data-work-key="${workKey}"] [data-room-row="${foreignRoomId}"]`).first()).toBeVisible();
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { electronApp, window, lead, second, workId, roomId, foreignRoomId, workKey };
  }

  type Opened = Awaited<ReturnType<typeof openApp>>;

  /** Инструмент агента `session`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
  async function agentTool({ window, workId }: Opened, session: string, tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: session }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 30_000 }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(session);
    expect(entry.tool).toBe(tool);
    return entry;
  }

  /** `browser_open` и id открытой страницы из ответа. */
  async function openPage(opened: Opened, session: string, args: Record<string, unknown>): Promise<string> {
    const result = await agentTool(opened, session, 'browser_open', args);
    expect(result.isError, result.text).toBe(false);
    const id = /Opened (t\d+):/.exec(result.text)?.[1];
    expect(id, result.text).toBeDefined();
    return id as string;
  }

  /** Список страниц, пока в нём не станет `count` загруженных (страницу загружает окно само). */
  async function tabsLoaded(opened: Opened, session: string, count: number): Promise<string> {
    let text = '';
    await expect
      .poll(
        async () => {
          text = (await agentTool(opened, session, 'browser_tabs')).text;
          return text.split('(loaded').length - 1;
        },
        { timeout: 40_000, intervals: [500] },
      )
      .toBe(count);
    return text;
  }

  const panelOf = (window: Page, owner: string) => window.locator(`[data-testid="browser-panel"][data-panel-owner="${owner}"]`);


  test('чтение страниц чата и комнаты: tabs, console, network с маской, снимок 375×812', async () => {
    const opened = await openApp();
    const { window, electronApp, lead, roomId } = opened;
    const chatId = await openPage(opened, lead, { url: `${origin}/`, own: true });
    const roomPageId = await openPage(opened, lead, { url: `${origin}/?room`, room: roomId });

    const tabs = await tabsLoaded(opened, lead, 2);
    expect(tabs).toContain(`${chatId}  your chat  ${origin}/`);
    expect(tabs).toContain(`${roomPageId}  room ${roomId}  ${origin}/?room`);
    expect(tabs).toContain('localhost');
    expect(tabs).toContain('title: Agent page');

    // Консоль: по умолчанию ошибки, warning — только по просьбе.
    await expect
      .poll(async () => (await agentTool(opened, lead, 'browser_console', { tab: chatId })).text, { timeout: 20_000 })
      .toContain('boom from page');
    expect((await agentTool(opened, lead, 'browser_console', { tab: chatId })).text).not.toContain('careful from page');
    const warnings = (await agentTool(opened, lead, 'browser_console', { tab: chatId, level: 'warning' })).text;
    expect(warnings).toContain('boom from page');
    expect(warnings).toContain('careful from page');

    // Сеть: упавший запрос и картинка; секретов нет ни в списке, ни в деталях.
    let list = '';
    await expect
      .poll(async () => (list = (await agentTool(opened, lead, 'browser_network', { tab: chatId })).text), { timeout: 20_000 })
      .toMatch(/POST 500 \S*\/api\/settings/);
    expect(list).toContain('/missing.png');
    const failedId = /^(\d+\.\d+)\s.*\/api\/settings/m.exec(list)?.[1];
    expect(failedId, list).toBeDefined();
    const detail = (await agentTool(opened, lead, 'browser_network', { tab: chatId, requestId: failedId })).text;
    expect(detail).toContain('Authorization: <redacted>');
    expect(detail).toContain('db down');
    for (const secret of SECRETS) {
      expect(list, secret).not.toContain(secret);
      expect(detail, secret).not.toContain(secret);
    }

    // Снимок 375×812: PNG ровно такого размера, размер человека вернулся.
    const chatUrl = `${origin}/`;
    const widthBefore = await guestEval<number>(electronApp, chatUrl, 'innerWidth');
    expect(widthBefore).not.toBeNull();
    const shot = await agentTool(opened, lead, 'browser_screenshot', { tab: chatId, width: 375, height: 812 });
    expect(shot.isError, shot.text).toBe(false);
    const file = /File: (\S+\.png)/.exec(shot.text)?.[1];
    expect(file, shot.text).toBeDefined();
    expect(file).toContain(path.join(home, 'desktop', 'drops'));
    expect(shot.text).toContain('375×812 CSS px, emulated');
    expect(await pngSize(file as string)).toEqual({ width: 375, height: 812 });
    await expect.poll(() => guestEval<number>(electronApp, chatUrl, 'innerWidth')).toBe(widthBefore);

    // Страница закрытой панели комнаты: снимок получается, панель остаётся скрытой.
    await expect(panelOf(window, `room:${roomId}`)).toBeHidden();
    const hidden = await agentTool(opened, lead, 'browser_screenshot', { tab: roomPageId });
    expect(hidden.isError, hidden.text).toBe(false);
    expect(hidden.text).toMatch(/File: \S+\.png/);
    await expect(panelOf(window, `room:${roomId}`)).toBeHidden();
  });

  test('чужой хозяин: страница чата другой сессии и комнаты без участия недоступны, в списке их нет', async () => {
    const opened = await openApp();
    const { second, lead, foreignRoomId } = opened;
    const foreignChat = await openPage(opened, second, { url: `${origin}/second`, own: true });
    const foreignRoom = await openPage(opened, second, { url: `${origin}/foreign-room`, room: foreignRoomId });
    const own = await openPage(opened, lead, { url: `${origin}/`, own: true });

    const tabs = await tabsLoaded(opened, lead, 1);
    expect(tabs).toContain(`${own}  your chat`);
    expect(tabs).not.toContain('/second');
    expect(tabs).not.toContain('/foreign-room');
    for (const tab of [foreignChat, foreignRoom]) {
      const denied = await agentTool(opened, lead, 'browser_console', { tab });
      expect(denied.isError, `${tab}: ${denied.text}`).toBe(true);
      expect(denied.text, tab).toMatch(/^(access_denied|no_tab):/);
    }
  });

  test('пауза панели и перезагрузка окна: реестр восстанавливается, пауза сохраняется', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const id = await openPage(opened, lead, { url: `${origin}/`, own: true });
    const panel = panelOf(window, `session:${lead}`);
    await expect(panel).toBeVisible();
    await tabsLoaded(opened, lead, 1);

    const toggle = async (item: string): Promise<void> => {
      await panel.getByRole('button', { name: 'More browser actions' }).click();
      await window.getByRole('menuitem', { name: item }).click();
    };

    await toggle('Pause agents');
    await expect(panel).toHaveAttribute('data-agents-paused', 'true');
    expect((await agentTool(opened, lead, 'browser_tabs')).text).toContain('No pages are open');
    const paused = await agentTool(opened, lead, 'browser_console', { tab: id });
    expect(paused.isError).toBe(true);
    expect(paused.text).toMatch(/^access_denied:/);
    expect(paused.text).toContain('paused by the human');

    await toggle('Resume agents');
    await expect(panel).not.toHaveAttribute('data-agents-paused', 'true');
    await tabsLoaded(opened, lead, 1);

    // Перезагрузка окна: реестр забыт main и наполнен заново раскладкой.
    await window.reload();
    await expect(panelOf(window, `session:${lead}`)).toBeVisible({ timeout: 30_000 });
    await tabsLoaded(opened, lead, 1);

    // Пауза, включённая до перезагрузки, после неё остаётся.
    await toggle('Pause agents');
    await expect(panel).toHaveAttribute('data-agents-paused', 'true');
    await window.reload();
    await expect(panelOf(window, `session:${lead}`)).toHaveAttribute('data-agents-paused', 'true', { timeout: 30_000 });
    expect((await agentTool(opened, lead, 'browser_tabs')).text).toContain('No pages are open');
  });
});
