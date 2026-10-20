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
 * Агент управляет страницами браузера своего чата и своих комнат (этап D, план 2026-10-20-browser-agent-control-plan.md,
 * задача 22a): `browser_snapshot`, `browser_action`, `browser_wait_for`, `browser_navigate`, `browser_resize` настоящего
 * `parley-mcp` через настоящий эндпоинт хоста и настоящее окно (каркас — `browser-agent-read.spec.ts`).
 * - поток формы: ввод, клик, ожидание, select, check; секреты в консоли и сети — маской;
 * - ввод агента не попадает в поле человека и не трогает окно (Фокус ревью 1), в том числе пока человек печатает в своей
 *   вкладке браузера;
 * - скрытая страница, которую человек видел, принимает ввод; ни разу не показанная — `tab_hidden` (Фокус ревью 2);
 * - переходы и устаревшая ссылка, размер, занятость (Annotate), Stop и «Pause agents» посреди операции (Фокус ревью 8).
 *
 * Ввод человека — только мышью и клавиатурой Playwright по окну: это модель CDP окна, не клавиатура ОС. `blur` страницы
 * не проверяется: под Playwright гость его не видит (спайк 2026-10-20).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

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


/** Изолированный мир скриптов выбора — `PICK_WORLD_ID` в `main/browser/design-mode.ts`. */
const PICK_WORLD_ID = 1001;

/** Код в изолированном мире 1001 гостя: ждёт ли скрипт выбора или меток клика человека. */
async function inWorld(app: ElectronApplication, url: string, code: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, [u, world, source]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      return guest === undefined ? null : guest.executeJavaScriptInIsolatedWorld(world as number, [{ code: source as string }]);
    },
    [url, PICK_WORLD_ID, code] as const,
  );
}

const FORM_HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Form page</title><h1>Form page</h1>
<label>Name <input id="name" aria-label="Name" autocomplete="off"></label><div id="echo"></div>
<button id="save">Save</button><div id="status"></div>
<label>Color <select id="color" aria-label="Color"><option>Red</option><option>Blue</option></select></label>
<label><input type="checkbox" id="agree"> Agree</label>
<script>
document.getElementById('name').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value; });
document.getElementById('save').addEventListener('click', () => { setTimeout(() => { document.getElementById('status').textContent = 'Saved'; }, 300); });
console.error('token=SECRET5');
fetch('/api/me?access_token=SECRET6').catch(() => {});
</script>`;

test.describe('агент управляет страницами браузера чата и комнаты (этап D, 22a)', () => {
  test.setTimeout(150_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-agent-control');
    project = await makeTempProject('browser-agent-control');
    mcpLog = path.join(home, 'mcp.jsonl');
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/api/me')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"no session"}');
      } else if (url.startsWith('/next')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Next page</title><h1>Next page</h1>');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(FORM_HTML);
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
  async function openApp(launchArgs: string[] = []) {
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
    const electronApp = await electron.launch({ args: [mainEntry, ...launchArgs], env });
    app = electronApp;
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    // Будильник печатал бы в терминал заглушки указатели на письма, склеиваясь со строками вызовов.
    await call(window, 'wake.pause', {});

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-agent-control', goal: '' });
    const create = async (label: string): Promise<string> =>
      (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null })).ref.sessionId;
    const lead = await create('lead');
    const second = await create('second');
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${lead}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    // Заглушка включает bracketed paste после готовности: дать ей догрузиться, чтобы Chat не мигнул терминалом.
    await window.waitForTimeout(800);
    const roomId = (await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: 'own-room', members: [lead, second], lead, quiet: true })).roomId;
    // Как в browser-agent-read.spec.ts: `owners` канала берутся из снимка работ хоста, а он отстаёт от `rooms.create`.
    await expect(window.locator(`[data-work-key="${workKey}"] [data-room-row="${roomId}"]`).first()).toBeVisible();
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { electronApp, window, lead, second, workId, roomId, workKey };
  }

  type Opened = Awaited<ReturnType<typeof openApp>>;

  /** Инструмент агента `session`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
  async function agentTool({ window, workId }: Opened, session: string, tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: session }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 40_000 }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(session);
    expect(entry.tool).toBe(tool);
    return entry;
  }

  /** `browser_open` и id открытой страницы из ответа (инструмент ждёт загрузку). */
  async function openPage(opened: Opened, session: string, args: Record<string, unknown>): Promise<string> {
    const result = await agentTool(opened, session, 'browser_open', args);
    expect(result.isError, result.text).toBe(false);
    const id = /Opened (t\d+):/.exec(result.text)?.[1];
    expect(id, result.text).toBeDefined();
    return id as string;
  }

  const panelOf = (window: Page, owner: string) => window.locator(`[data-testid="browser-panel"][data-panel-owner="${owner}"]`);

  /** Панель чата открыта и показывает активную страницу: человек её видел (`seen`). `browser_open` панель открывает, но тест на это не полагается. */
  async function showPanel(window: Page, lead: string) {
    const panel = panelOf(window, `session:${lead}`);
    if (!(await panel.isVisible())) await window.getByRole('button', { name: 'Browser', exact: true }).first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="browser-field"]:visible')).toHaveCount(1);
    return panel;
  }

  /** Ссылка `eN` из `browser_snapshot` по роли и имени. */
  async function refOf(opened: Opened, session: string, tab: string, role: string, name: string): Promise<string> {
    const snapshot = await agentTool(opened, session, 'browser_snapshot', { tab, interactiveOnly: true });
    expect(snapshot.isError, snapshot.text).toBe(false);
    const ref = new RegExp(`\\[ref=(e\\d+)\\] ${role} "${name}"`).exec(snapshot.text)?.[1];
    expect(ref, snapshot.text).toBeDefined();
    return ref as string;
  }

  /** Всё, что агент менять не вправе: активные вкладки окна, фокус клавиатуры и фокус окна. */
  async function humanState(window: Page): Promise<{ tabs: string[]; focus: string; windowFocused: boolean }> {
    return window.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]')).map((tab) => `${tab.dataset['workKey']}|${tab.dataset['tabId']}|${tab.dataset['active']}`);
      const el = document.activeElement as HTMLElement | null;
      const focus = el === null ? 'none' : `${el.tagName}|${el.id}|${el.getAttribute('aria-label') ?? ''}|${el.dataset['testid'] ?? ''}`;
      return { tabs, focus, windowFocused: document.hasFocus() };
    });
  }

  const echoOf = (opened: Opened, url: string): Promise<string | null> => guestEval<string>(opened.electronApp, url, "document.getElementById('echo').textContent");

  test('поток формы: ввод, клик, ожидание, select, check; секреты консоли и сети — маской', async () => {
    const opened = await openApp();
    const { window, lead, electronApp } = opened;
    const url = `${origin}/form`;
    const tab = await openPage(opened, lead, { url, own: true });
    await showPanel(window, lead);

    const name = await refOf(opened, lead, tab, 'textbox', 'Name');
    const typed = await agentTool(opened, lead, 'browser_action', { tab, action: 'type', ref: name, text: 'Ann' });
    expect(typed.isError, typed.text).toBe(false);
    expect(typed.text).toContain('Typed 3 characters');
    expect(await echoOf(opened, url)).toBe('Ann');

    const save = await refOf(opened, lead, tab, 'button', 'Save');
    const clicked = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: save });
    expect(clicked.isError, clicked.text).toBe(false);
    const waited = await agentTool(opened, lead, 'browser_wait_for', { tab, text: 'Saved' });
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.text).toContain('The text appeared');

    const color = await refOf(opened, lead, tab, 'combobox', 'Color');
    const selected = await agentTool(opened, lead, 'browser_action', { tab, action: 'select', ref: color, value: 'Blue' });
    expect(selected.isError, selected.text).toBe(false);
    expect(await guestEval<string>(electronApp, url, "document.getElementById('color').value")).toBe('Blue');

    const agree = await refOf(opened, lead, tab, 'checkbox', 'Agree');
    const checked = await agentTool(opened, lead, 'browser_action', { tab, action: 'check', ref: agree });
    expect(checked.isError, checked.text).toBe(false);
    expect(await guestEval<boolean>(electronApp, url, "document.getElementById('agree').checked")).toBe(true);

    // Секреты консоли и сети — маской, и на странице 127.0.0.1, и вообще.
    let consoleText = '';
    await expect
      .poll(async () => (consoleText = (await agentTool(opened, lead, 'browser_console', { tab })).text), { timeout: 20_000 })
      .toContain('<redacted>');
    expect(consoleText).not.toContain('SECRET5');
    let network = '';
    await expect
      .poll(async () => (network = (await agentTool(opened, lead, 'browser_network', { tab })).text), { timeout: 20_000 })
      .toContain('/api/me');
    expect(network).not.toContain('SECRET6');
    expect(network).toContain('<redacted>');
  });

  test('ввод агента не попадает в поле человека и не трогает окно (Фокус ревью 1)', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const url = `${origin}/form`;
    const tab = await openPage(opened, lead, { url, own: true });
    await showPanel(window, lead);
    const name = await refOf(opened, lead, tab, 'textbox', 'Name');
    const save = await refOf(opened, lead, tab, 'button', 'Save');

    const field = window.getByTestId('chat-view').getByRole('textbox', { name: 'Message to Claude' });
    await field.click();
    await window.keyboard.type('hello');
    await expect(field).toHaveValue('hello');
    const before = await humanState(window);

    const typed = await agentTool(opened, lead, 'browser_action', { tab, action: 'type', ref: name, text: 'agent-text' });
    expect(typed.isError, typed.text).toBe(false);
    expect(await echoOf(opened, url)).toBe('agent-text');
    await expect(field).toHaveValue('hello');
    expect(await humanState(window)).toEqual(before);

    // Следующие нажатия человека идут в Chat, а не в страницу.
    await window.keyboard.type(' world');
    await expect(field).toHaveValue('hello world');
    expect(await echoOf(opened, url)).toBe('agent-text');

    // Клик агента уводит фокус окна на <webview> (спайк В3); по концу операции окно возвращает его.
    const clicked = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: save });
    expect(clicked.isError, clicked.text).toBe(false);
    await window.keyboard.type('!');
    await expect(field).toHaveValue('hello world!');
    const after = await humanState(window);
    expect(after.focus).toBe(before.focus);
    expect(after.tabs).toEqual(before.tabs);
    expect(after.windowFocused).toBe(before.windowFocused);
  });

  test('человек в своей вкладке браузера, агент в странице панели: тексты не смешиваются, фокус человека остаётся у него', async () => {
    // Фокус человека в `<webview>` его вкладки, страница агента скрыта: `node.focus()` поверх другого гостя фокус ввода
    // Chromium не переводит, и текст агента уходил в страницу человека. Окно переводит фокус между гостями через себя
    // (`blur` прежнего `<webview>`) — туда и обратно (`agent-activity.ts`).
    // Параллельную печать человека (`human_busy`) E2E не проверяет: клавиатура Playwright не порождает `before-input-event`
    // ни у окна, ни у гостя (проба 2026-10-20), поэтому тишину клавиатуры закрывают юнит-тесты `human-typing.test.ts`,
    // `agent-ops-control.test.ts`. Здесь — то, что видно снаружи: пауза человека, ввод агента, продолжение человека.
    const opened = await openApp();
    const { window, lead, electronApp } = opened;
    const agentUrl = `${origin}/form?agent`;
    const humanUrl = `${origin}/form?human`;
    const tab = await openPage(opened, lead, { url: agentUrl, own: true });
    await showPanel(window, lead);
    const name = await refOf(opened, lead, tab, 'textbox', 'Name');
    const save = await refOf(opened, lead, tab, 'button', 'Save');
    /** Адрес гостя, на `<webview>` которого стоит фокус окна; `null` — фокус не на `<webview>`. */
    const focusedGuest = (): Promise<string | null> =>
      window.evaluate(() => {
        const el = document.activeElement as (HTMLElement & { getURL?: () => string }) | null;
        return el?.tagName === 'WEBVIEW' ? (el.getURL?.() ?? null) : null;
      });

    // Вкладка браузера человека: «+» → «New browser tab» → адрес.
    await window.getByRole('button', { name: 'Open…' }).first().click();
    await window.locator('[data-palette] [role="option"]', { hasText: 'New browser tab' }).click();
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(humanUrl);
    await address.press('Enter');
    await expect.poll(() => echoOf(opened, humanUrl)).toBe('');

    // Человек переходит в свою страницу (фокус окна — на её <webview>) и печатает в поле. Не мышью Playwright: сразу после
    // загрузки гостя её нажатие нередко достаётся окну, а не гостю, и клавиши уходят в окно (проба 2026-10-20: 6 из 8
    // прогонов, ещё до ввода агента). Фокус на <webview> ставит `focus()` элемента в окне — путь Chromium «окно → гость», как
    // после клика человека (`locator.focus()` Playwright <webview> не фокусирует); поле внутри гостя — скрипт теста; клавиши — Playwright.
    const view = window.locator('webview:visible');
    await expect(view).toHaveCount(1);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    await view.evaluate((element) => (element as HTMLElement).focus());
    await guestEval(electronApp, humanUrl, "document.getElementById('name').focus()");
    await expect.poll(() => guestEval<string>(electronApp, humanUrl, 'document.activeElement.id')).toBe('name');
    await window.waitForTimeout(500);
    await window.keyboard.type('human-');
    await expect.poll(() => echoOf(opened, humanUrl)).toBe('human-');
    expect(await focusedGuest()).toBe(humanUrl);
    const before = await humanState(window);

    // Пауза человека дольше тишины клавиатуры; агент вводит в свою страницу.
    await window.waitForTimeout(1500);
    const typed = await agentTool(opened, lead, 'browser_action', { tab, action: 'type', ref: name, text: 'agent-line' });
    expect(typed.isError, typed.text).toBe(false);
    expect(typed.text).toContain('Typed 10 characters');
    expect(await echoOf(opened, agentUrl)).toBe('agent-line');
    expect(await echoOf(opened, humanUrl)).toBe('human-');

    // Фокус человека вернулся в его страницу: продолжение набора идёт туда же, а не в страницу агента.
    expect(await focusedGuest()).toBe(humanUrl);
    expect(await humanState(window)).toEqual(before);
    await window.keyboard.type('1234');
    await expect.poll(() => echoOf(opened, humanUrl)).toBe('human-1234');
    expect(await echoOf(opened, agentUrl)).toBe('agent-line');

    // Клик агента одалживает фокус так же (спайк В3): после него нажатия человека — снова в его страницу.
    await window.waitForTimeout(1500);
    const clicked = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: save });
    expect(clicked.isError, clicked.text).toBe(false);
    await expect.poll(() => guestEval<string>(electronApp, agentUrl, "document.getElementById('status').textContent")).toBe('Saved');
    expect(await focusedGuest()).toBe(humanUrl);
    expect(await humanState(window)).toEqual(before);
    await window.keyboard.type('5');
    await expect.poll(() => echoOf(opened, humanUrl)).toBe('human-12345');
    expect(await echoOf(opened, agentUrl)).toBe('agent-line');
  });

  test('скрытая страница, которую человек видел, принимает ввод; ни разу не показанная — tab_hidden (Фокус ревью 2)', async () => {
    const opened = await openApp();
    const { window, lead, roomId } = opened;
    const firstUrl = `${origin}/form?first`;
    const secondUrl = `${origin}/form?second`;
    const first = await openPage(opened, lead, { url: firstUrl, own: true });
    const second = await openPage(opened, lead, { url: secondUrl, own: true });
    const panel = await showPanel(window, lead);
    await expect(panel.getByRole('tab')).toHaveCount(2);

    // Человек видит обе страницы: активна вторая, затем снова первая.
    await panel.getByRole('tab').nth(1).click();
    await expect(panel.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('tab').nth(0).click();
    await expect(panel.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true');
    const name = await refOf(opened, lead, second, 'textbox', 'Name');

    const field = window.getByTestId('chat-view').getByRole('textbox', { name: 'Message to Claude' });
    await field.click();
    const before = await humanState(window);
    const typed = await agentTool(opened, lead, 'browser_action', { tab: second, action: 'type', ref: name, text: 'hidden-text' });
    expect(typed.isError, typed.text).toBe(false);
    expect(typed.text).toContain('Typed 11 characters');
    expect(await echoOf(opened, secondUrl)).toBe('hidden-text');
    expect(await echoOf(opened, firstUrl)).toBe('');
    await expect(panel.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true');
    expect(await humanState(window)).toEqual(before);
    await window.keyboard.type('x');
    await expect(field).toHaveValue('x');
    expect(first).not.toBe(second);

    // Страница комнаты, чью панель человек не открывал, ни разу не показана: ввод — tab_hidden, символов нет.
    const roomUrl = `${origin}/form?room`;
    const roomTab = await openPage(opened, lead, { url: roomUrl, room: roomId });
    await expect(panelOf(window, `room:${roomId}`)).toBeHidden();
    const roomName = await refOf(opened, lead, roomTab, 'textbox', 'Name');
    const refused = await agentTool(opened, lead, 'browser_action', { tab: roomTab, action: 'type', ref: roomName, text: 'nobody-sees' });
    expect(refused.isError, refused.text).toBe(true);
    expect(refused.text).toMatch(/^tab_hidden:/);
    expect(await echoOf(opened, roomUrl)).toBe('');
  });

  test('переходы и устаревшая ссылка: navigate, stale_ref, back (Фокус ревью 8)', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const url = `${origin}/form`;
    const tab = await openPage(opened, lead, { url, own: true });
    await showPanel(window, lead);
    const save = await refOf(opened, lead, tab, 'button', 'Save');

    const moved = await agentTool(opened, lead, 'browser_navigate', { tab, url: `${origin}/next` });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.text).toContain(`Loaded ${tab}`);
    expect(moved.text).toContain('Next page');

    const stale = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: save });
    expect(stale.isError, stale.text).toBe(true);
    expect(stale.text).toMatch(/^stale_ref:/);

    const back = await agentTool(opened, lead, 'browser_navigate', { tab, back: true });
    expect(back.isError, back.text).toBe(false);
    expect(back.text).toContain(`${origin}/form`);
    const tabs = (await agentTool(opened, lead, 'browser_tabs')).text;
    expect(tabs).toContain(`${tab}  your chat  ${origin}/form`);
  });

  test('размер: пресет mobile-m ставит 375 × 812 и подпись у человека, fit снимает эмуляцию', async () => {
    const opened = await openApp();
    const { window, lead, electronApp } = opened;
    const url = `${origin}/form`;
    const tab = await openPage(opened, lead, { url, own: true });
    const panel = await showPanel(window, lead);

    const resized = await agentTool(opened, lead, 'browser_resize', { tab, preset: 'mobile-m' });
    expect(resized.isError, resized.text).toBe(false);
    await expect.poll(() => guestEval<number>(electronApp, url, 'innerWidth')).toBe(375);
    await expect(panel.getByTestId('viewport-label')).toContainText('375 × 812');

    const fit = await agentTool(opened, lead, 'browser_resize', { tab, fit: true });
    expect(fit.isError, fit.text).toBe(false);
    await expect.poll(() => guestEval<number>(electronApp, url, 'innerWidth')).toBeGreaterThan(375);
    await expect(panel.getByTestId('viewport-label')).toHaveCount(0);
  });

  test('занятость: при Annotate действие — human_busy, метка не добавлена, чтение работает', async () => {
    const opened = await openApp();
    const { window, lead, electronApp } = opened;
    const url = `${origin}/form`;
    const tab = await openPage(opened, lead, { url, own: true });
    const panel = await showPanel(window, lead);
    const save = await refOf(opened, lead, tab, 'button', 'Save');

    const annotate = panel.getByRole('button', { name: 'Annotate' });
    await annotate.click();
    await expect(annotate).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => inWorld(electronApp, url, 'globalThis.__parleyAnnotate?.waiting() === true')).toBe(true);

    const busy = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: save });
    expect(busy.isError, busy.text).toBe(true);
    expect(busy.text).toMatch(/^human_busy:/);
    expect(await inWorld(electronApp, url, 'globalThis.__parleyAnnotate?.count() ?? 0')).toBe(0);
    const read = await agentTool(opened, lead, 'browser_console', { tab });
    expect(read.isError, read.text).toBe(false);
  });

  test('Stop и «Pause agents» посреди wait_for: операция оборвана, панель на паузе, «Resume agents» её снимает (Фокус ревью 8)', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const tab = await openPage(opened, lead, { url: `${origin}/form`, own: true });
    const panel = await showPanel(window, lead);

    // Stop на значке агента.
    const pending = agentTool(opened, lead, 'browser_wait_for', { tab, text: 'Never' });
    const badge = panel.getByTestId('agent-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.getByRole('button', { name: 'Stop' }).click();
    const stopped = await pending;
    expect(stopped.isError, stopped.text).toBe(true);
    expect(stopped.text).toMatch(/^access_denied:/);
    expect(stopped.text).toContain('paused by the human');
    await expect(panel).toHaveAttribute('data-agents-paused', 'true');
    const after = await agentTool(opened, lead, 'browser_console', { tab });
    expect(after.isError, after.text).toBe(true);
    expect(after.text).toMatch(/^access_denied:/);

    const toggle = async (item: string): Promise<void> => {
      await panel.getByRole('button', { name: 'More browser actions' }).click();
      await window.getByRole('menuitem', { name: item }).click();
    };
    await toggle('Resume agents');
    await expect(panel).not.toHaveAttribute('data-agents-paused', 'true');
    const resumed = await agentTool(opened, lead, 'browser_console', { tab });
    expect(resumed.isError, resumed.text).toBe(false);

    // «Pause agents» из меню «⋯» посреди ожидания.
    const waiting = agentTool(opened, lead, 'browser_wait_for', { tab, text: 'Never' });
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await toggle('Pause agents');
    const paused = await waiting;
    expect(paused.isError, paused.text).toBe(true);
    expect(paused.text).toMatch(/^access_denied:/);
    await expect(panel).toHaveAttribute('data-agents-paused', 'true');
  });
});
