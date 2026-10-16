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
 * Агент открывает страницу в браузере своего чата и своей комнаты (этап B2, часть 2, спека
 * 2026-10-07-browser-devtools-agent-design.md, 3.10, 5.1, 5.2 и приёмка этапа B2 в разделе 12): инструмент `browser_open`
 * настоящего `parley-mcp` через настоящий эндпоинт хоста и настоящее окно.
 * - без аргументов страница уходит в браузер единственной комнаты сессии, `own: true` — в браузер её чата; человек
 *   видит страницу у себя, а когда вид хозяина не на экране — тост «S01 opened …»;
 * - `room`, где сессия не участник, — `access_denied`, ничего не открывается; своя комната по `room` — принимается;
 * - тот же адрес с другим #фрагментом не открывает вторую страницу: ответ называет прежнюю;
 * - предел страниц панели — `bad_request` с советом закрыть одну;
 * - рамка (5.2): фокус клавиатуры, активная вкладка и вид человека не меняются; токен канала лежит в конфиге MCP, а не в
 *   окружении процесса агента, адрес канала — 127.0.0.1.
 *
 * Агент — заглушка `stub-echo-agent.mjs`: строка `STUB_MCP browser_open {json}` в её терминале зовёт инструмент
 * настоящего `parley-mcp`, поднятого по `--mcp-config` запуска, ровно как это делает Claude Code; результат читается из
 * журнала `STUB_MCP_LOG`. Страница — свой сервер на 127.0.0.1; её загрузку тесты не ждут: `browser_open` не ждёт тоже.
 *
 * Пункты приёмки, которых здесь нет, закрыты unit-тестами: канал слушает только 127.0.0.1 (`hooks/hook-server.test.ts`,
 * `core/src/mcp/context.test.ts`), общий выключатель (`main/browser/agent-ops.test.ts`), токены сессий и отзыв
 * (`host/src/agent/browser-endpoint.test.ts`).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Предел страниц панели (спека, раздел 8). */
const PANEL_PAGES = 5;

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

interface Launch {
  argv: string[];
  env: Record<string, string>;
}

const readLines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);

test.describe('агент открывает страницу в браузере чата и комнаты (этап B2, часть 2)', () => {
  test.setTimeout(120_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let mcpLog: string;
  let argvLog: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-agent-open');
    project = await makeTempProject('browser-agent-open');
    mcpLog = path.join(home, 'mcp.jsonl');
    argvLog = path.join(home, 'argv.jsonl');
    // Правила проекта уже есть: без них первая сессия кладёт PARLEY.md и показывает свой тост.
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Agent page</title><h1>Agent page</h1>'));
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
      STUB_ARGV_LOG: argvLog,
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

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-agent-open', goal: '' });
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
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { electronApp, window, lead, workId, roomId, foreignRoomId, workKey };
  }

  type Opened = Awaited<ReturnType<typeof openApp>>;

  /** `browser_open` агента `lead`: строка `STUB_MCP` в его терминал, результат инструмента — из журнала заглушки. */
  async function agentOpens({ window, lead, workId }: Opened, args: Record<string, unknown>): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: lead }, `STUB_MCP browser_open ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 30_000 }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(lead);
    expect(entry.tool).toBe('browser_open');
    return entry;
  }

  /** Панель хозяина: `session:<id>` или `room:<id>`. */
  const panelOf = (window: Page, owner: string) => window.locator(`[data-testid="browser-panel"][data-panel-owner="${owner}"]`);

  /** Открывает вкладку комнаты кликом по её строке в сайдбаре (действие человека). */
  async function openRoom(window: Page, workKey: string, roomId: string): Promise<void> {
    await window.locator(`[data-work-key="${workKey}"]:not([role="tab"]) [data-room-row="${roomId}"] > div`).first().click();
    await expect(window.locator('[data-room-panel]')).toBeVisible();
  }

  /** Всё, что агент менять не вправе: активные вкладки окна и то, где стоит фокус клавиатуры. */
  async function humanState(window: Page): Promise<{ tabs: string[]; focus: string }> {
    return window.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]')).map((tab) => `${tab.dataset['workKey']}|${tab.dataset['tabId']}|${tab.dataset['active']}`);
      const el = document.activeElement as HTMLElement | null;
      const focus = el === null ? 'none' : `${el.tagName}|${el.id}|${el.getAttribute('aria-label') ?? ''}|${el.dataset['testid'] ?? ''}`;
      return { tabs, focus };
    });
  }

  test('без аргументов страница уходит в браузер единственной комнаты, own: true — в браузер чата; вид хозяина не на экране — тост', async () => {
    const opened = await openApp();
    const { window, roomId, lead, workKey } = opened;

    // Вид комнаты не открыт: страница встаёт в её панель, человек получает тост и остаётся в Chat (спека 5.1, 5.2).
    const first = await agentOpens(opened, { url: `${origin}/room-page` });
    expect(first.isError, first.text).toBe(false);
    expect(first.text).toContain(`the browser of room ${roomId}`);
    expect(first.text).toMatch(/Opened t\d+:/);
    await expect(window.getByText(`S01 opened ${new URL(origin).host}`)).toBeVisible();
    await expect(window.getByTestId('chat-view')).toBeVisible();
    // Панель в DOM остаётся (страницы переживают уход вида), но скрыта: человеку она не показана.
    await expect(panelOf(window, `room:${roomId}`)).toBeHidden();

    // Вид чата на экране: страница встаёт в его панель, она открывается сама.
    const own = await agentOpens(opened, { url: `${origin}/chat-page`, own: true });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain('your own chat');
    const chatPanel = panelOf(window, `session:${lead}`);
    await expect(chatPanel).toBeVisible();
    await expect(chatPanel.getByRole('tab')).toHaveCount(1);

    // Комната, когда человек её откроет, показывает страницу агента в своей панели.
    await openRoom(window, workKey, roomId);
    const roomPanel = panelOf(window, `room:${roomId}`);
    await expect(roomPanel).toBeVisible();
    await expect(roomPanel.getByRole('tab')).toHaveCount(1);
  });

  test('room, где сессия не участник, — access_denied и ничего не открывается; своя комната по id принимается', async () => {
    const opened = await openApp();
    const { window, foreignRoomId, roomId, lead } = opened;

    const denied = await agentOpens(opened, { url: `${origin}/x`, room: foreignRoomId });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/^access_denied:/);
    await expect(window.getByTestId('browser-panel')).toHaveCount(0);
    await expect(window.getByText(/S01 opened/)).toHaveCount(0);

    // Совместно own и room — bad_request: куда открыть, агент называет одним способом.
    const both = await agentOpens(opened, { url: `${origin}/x`, room: roomId, own: true });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/^bad_request:/);

    const accepted = await agentOpens(opened, { url: `${origin}/room-page`, room: roomId });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.text).toContain(`the browser of room ${roomId}`);
    await expect(panelOf(window, `session:${lead}`)).toHaveCount(0);
  });

  test('тот же адрес с другим #фрагментом не открывает вторую страницу: ответ называет прежнюю, в панели одна вкладка', async () => {
    const opened = await openApp();
    const { window, lead } = opened;

    const first = await agentOpens(opened, { url: `${origin}/app#one`, own: true });
    expect(first.isError, first.text).toBe(false);
    const id = /Opened (t\d+):/.exec(first.text)?.[1];
    expect(id, first.text).toBeDefined();
    const panel = panelOf(window, `session:${lead}`);
    await expect(panel.getByRole('tab')).toHaveCount(1);

    const again = await agentOpens(opened, { url: `${origin}/app#two`, own: true });
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toContain(`Page ${id} `);
    expect(again.text).toContain('no new page was opened');
    await expect(panel.getByRole('tab')).toHaveCount(1);

    // Другой путь — уже другая страница.
    const other = await agentOpens(opened, { url: `${origin}/other`, own: true });
    expect(other.isError, other.text).toBe(false);
    await expect(panel.getByRole('tab')).toHaveCount(2);
  });

  test('предел страниц панели: шестая — bad_request с советом закрыть одну, в панели пять вкладок; после закрытия одной страница открывается', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const panel = panelOf(window, `session:${lead}`);

    for (let i = 0; i < PANEL_PAGES; i += 1) {
      const result = await agentOpens(opened, { url: `${origin}/p${i}`, own: true });
      expect(result.isError, result.text).toBe(false);
    }
    await expect(panel.getByRole('tab')).toHaveCount(PANEL_PAGES);

    const over = await agentOpens(opened, { url: `${origin}/p-over`, own: true });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/^bad_request:/);
    expect(over.text).toContain('close one');
    await expect(panel.getByRole('tab')).toHaveCount(PANEL_PAGES);

    // Повтор уже открытой страницы в полной панели предел не трогает.
    const reused = await agentOpens(opened, { url: `${origin}/p0#again`, own: true });
    expect(reused.isError, reused.text).toBe(false);
    expect(reused.text).toContain('no new page was opened');

    await panel.getByRole('tab').first().getByRole('button', { name: /^Close/ }).click();
    await expect(panel.getByRole('tab')).toHaveCount(PANEL_PAGES - 1);
    const again = await agentOpens(opened, { url: `${origin}/p-over`, own: true });
    expect(again.isError, again.text).toBe(false);
    await expect(panel.getByRole('tab')).toHaveCount(PANEL_PAGES);
  });

  test('рамка 5.2: агент не меняет фокус клавиатуры, активные вкладки и вид человека, адресную строку не берёт', async () => {
    const opened = await openApp();
    const { window, lead, roomId } = opened;
    const chat = window.getByTestId('chat-view');
    const field = chat.getByRole('textbox', { name: 'Message to Claude' });
    await field.click();
    await expect(field).toBeFocused();
    const before = await humanState(window);

    // В браузер чата (панель закрыта — откроется), в браузер комнаты (вид не на экране) и повтор.
    for (const args of [{ url: `${origin}/one`, own: true }, { url: `${origin}/two`, room: roomId }, { url: `${origin}/one#again`, own: true }]) {
      const result = await agentOpens(opened, args);
      expect(result.isError, result.text).toBe(false);
    }
    await expect(panelOf(window, `session:${lead}`)).toBeVisible();

    await expect(chat).toBeVisible();
    await expect(field).toBeFocused();
    await expect(window.getByRole('textbox', { name: 'Address' })).not.toBeFocused();
    expect(await humanState(window)).toEqual(before);
  });

  test('токен канала лежит в конфиге MCP, а не в окружении процесса агента; адрес канала — 127.0.0.1', async () => {
    const opened = await openApp();
    const { lead } = opened;
    await expect.poll(async () => (await readLines<Launch>(argvLog)).filter((launch) => launch.env['PARLEY_SESSION_ID'] === lead).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const launch = (await readLines<Launch>(argvLog)).filter((item) => item.env['PARLEY_SESSION_ID'] === lead).at(-1) as Launch;

    // Ни токена, ни адреса канала в окружении процесса агента: его команды Bash не могут их прочитать.
    expect(Object.keys(launch.env).filter((key) => key.includes('AGENT_TOKEN') || key.includes('AGENT_URL'))).toEqual([]);
    const at = launch.argv.indexOf('--mcp-config');
    expect(at, 'у запуска нет --mcp-config').toBeGreaterThan(-1);
    const server = (JSON.parse(await readFile(launch.argv[at + 1] as string, 'utf8')) as { mcpServers: { parley: { env: Record<string, string> } } }).mcpServers.parley;
    expect(server.env['PARLEY_AGENT_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    expect(server.env['PARLEY_AGENT_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/browser$/);
  });
});
