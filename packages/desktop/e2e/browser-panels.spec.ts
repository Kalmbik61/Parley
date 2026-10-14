import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Браузер чата и браузер комнаты (этап B2, часть 1, спека 2026-10-07-browser-devtools-agent-design.md, 3.10 и 4.11) — панель
 * справа от вида хозяина, только для человека:
 * - у Chat сессии и у комнаты кнопка «Browser» открывает панель справа от вида; страница грузится, адресная строка новой
 *   страницы в фокусе; Select кладёт чип хозяину панели (в поле Chat сессии, в поле комнаты); меню «To» в панели нет;
 * - панель переживает перезагрузку окна: открыта, страница та же;
 * - вид уже 720 px (окно 800×500) — панель встаёт поверх вида целиком, «Back to chat» и «Back to room» возвращают; окно
 *   стало шире — та же панель встаёт рядом; длинные названия сессии, комнаты и адреса не ломают полоску; закрытая панель
 *   остаётся нормального размера (страница не схлопывается);
 * - «⋯ → Move to browser of…» у вкладки человека переносит страницу в панель выбранной сессии, вкладка закрывается.
 *
 * Страница — свой сервер на 127.0.0.1. Клики в госте — sendInputEvent main: доверенные, как у человека. Вид Chat есть только
 * при известной версии claude: тесты включают пробу версий (`PARLEY_SKIP_VERSION_PROBE: ''`, как chat-view.spec.ts).
 *
 * DPR: весь файл при одном масштабе — общим для спеков переключателем `E2E_DPR=2 pnpm exec playwright test
 * e2e/browser-panels.spec.ts` (1 или 2). Снимки экрана — в `test-results/browser-panels/` (не коммитятся).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/browser-panels');
/** Изолированный мир скриптов выбора — `PICK_WORLD_ID` в `main/browser/design-mode.ts`. */
const PICK_WORLD_ID = 1001;
/** Допуск сравнения краёв: границы блоков в Chromium бывают дробными. */
const EDGE = 1;
const FORCED_DPR = ['1', '2'].includes(process.env.E2E_DPR ?? '') ? Number(process.env.E2E_DPR) : undefined;
const LONG_SESSION = `backend ${'x'.repeat(60)}`;
const LONG_ROOM = `review ${'y'.repeat(70)}`;
const LONG_PATH = `/long/${'z'.repeat(120)}`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Panel page</title>
<style>
  body{font:14px system-ui,sans-serif;margin:16px}
  .save{box-sizing:border-box;width:96px;height:40px;border:0;border-radius:0;padding:8px 16px;color:#fff;background:rgb(20,71,230)}
</style></head>
<body><main><h1>Panel page</h1>
  <button id="save" class="save" type="button" onclick="document.body.dataset.saved = '1'">Save</button>
  <p>A paragraph for the page in the browser panel.</p>
</main></body></html>`;

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body), { method, params })) as T;
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL())
      .filter((url) => url !== 'about:blank'),
  );
}

async function menu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, action) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', action);
  }, id);
}

/** Окно в фокусе: снимок `capturePage` у не сфокусированного окна бывает пустым. */
async function focusWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
}

async function setSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), size);
}

/** Доверенный клик в центр элемента гостя. */
async function clickInGuest(app: ElectronApplication, url: string, selector: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, [u, s]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      if (guest === undefined) throw new Error(`нет гостя ${u}`);
      const point = (await guest.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
      )) as { x: number; y: number };
      guest.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      guest.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    [url, selector] as const,
  );
}

/** Скрипт выбора в изолированном мире 1001 гостя: взведён ли он и ждёт клика человека. */
async function pickArmed(app: ElectronApplication, url: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, [u, world]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      return guest === undefined ? null : guest.executeJavaScriptInIsolatedWorld(world as number, [{ code: "typeof globalThis.__parleyPickCancel === 'function'" }]);
    },
    [url, PICK_WORLD_ID] as const,
  );
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what}: узла нет на экране`);
  return box;
}

/** Страница слева от панели, обе на одной высоте и вплотную: панель — «справа от вида» (спека 4.11). */
function expectBeside(view: Box, panel: Box, what: string): void {
  expect(view.x + view.width, `${what}: вид заходит под панель`).toBeLessThanOrEqual(panel.x + EDGE);
  expect(panel.x - (view.x + view.width), `${what}: между видом и панелью зазор`).toBeLessThanOrEqual(EDGE);
  expect(Math.abs(panel.y - view.y), `${what}: панель и вид на разной высоте`).toBeLessThanOrEqual(EDGE);
  expect(Math.abs(panel.height - view.height), `${what}: панель и вид разной высоты`).toBeLessThanOrEqual(EDGE);
}

/** Панель закрывает вид целиком (узкий вид, спека 4.11). */
function expectCovers(view: Box, panel: Box, what: string): void {
  expect(panel.x, `${what}: слева`).toBeLessThanOrEqual(view.x + EDGE);
  expect(panel.y, `${what}: сверху`).toBeLessThanOrEqual(view.y + EDGE);
  expect(panel.x + panel.width, `${what}: справа`).toBeGreaterThanOrEqual(view.x + view.width - EDGE);
  expect(panel.y + panel.height, `${what}: снизу`).toBeGreaterThanOrEqual(view.y + view.height - EDGE);
}

test.describe('браузер чата и браузер комнаты (этап B2, часть 1)', () => {
  test.setTimeout(120_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-panels');
    project = await makeTempProject('browser-panels');
    // Правила проекта уже есть: без них первая сессия кладёт PARLEY.md и показывает тост «Parley added PARLEY.md … Open».
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/' || pathname.startsWith('/long/')) return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      res.writeHead(404).end();
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

  /** Окно, работа с двумя сессиями и комнатой; Chat ведущей сессии на экране. */
  async function openApp(options: { size?: { width: number; height: number }; long?: boolean; dpr?: number }) {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: path.join(home, 'no-codex'),
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_BRACKETED: '1',
      // Проба версий включена: у claude есть вид Chat.
      PARLEY_SKIP_VERSION_PROBE: '',
    };
    const dpr = options.dpr ?? FORCED_DPR;
    const electronApp = await electron.launch({ args: dpr === undefined ? [mainEntry] : [mainEntry, `--force-device-scale-factor=${dpr}`], env });
    app = electronApp;
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await electronApp.firstWindow();
    await setSize(electronApp, options.size ?? { width: 1400, height: 900 });
    await expect(window.getByTestId('landing')).toBeVisible();
    const screenDpr = await window.evaluate(() => globalThis.devicePixelRatio);
    if (dpr !== undefined) expect(screenDpr).toBe(dpr);
    test.info().annotations.push({ type: 'dpr', description: String(screenDpr) });

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-panels', goal: '' });
    const create = (label: string): Promise<{ ref: { sessionId: string } }> =>
      call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null });
    const lead = (await create(options.long === true ? LONG_SESSION : 'lead')).ref.sessionId;
    const second = (await create('second')).ref.sessionId;
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${lead}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    // Stub включил bracketed paste после готовности: дать ему догрузиться, чтобы Chat не мигнул терминалом.
    await window.waitForTimeout(800);
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: options.long === true ? LONG_ROOM : 'e2e-room',
      members: [lead, second],
      lead,
      quiet: true,
    });
    await expect(window.getByTestId('chat-view')).toBeVisible();
    await focusWindow(electronApp);
    return { electronApp, window, lead, roomId, workKey, screenDpr };
  }

  /** Открывает вкладку комнаты кликом по её строке в сайдбаре. */
  async function openRoom(window: Page, workKey: string, roomId: string): Promise<void> {
    await window.locator(`[data-work-key="${workKey}"]:not([role="tab"]) [data-room-row="${roomId}"] > div`).first().click();
    await expect(window.locator('[data-room-panel]')).toBeVisible();
  }

  /**
   * Адрес в адресной строке панели: новая страница берёт фокус. `pages` — сколько страниц с этим адресом живо в окне: закрытая
   * панель страницы не выгружает, и страница прежней панели остаётся рядом.
   */
  async function loadPage(electronApp: ElectronApplication, window: Page, url: string, pages = 1): Promise<void> {
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(url);
    await address.press('Enter');
    await expect.poll(async () => (await guestUrls(electronApp)).filter((guest) => guest === url).length).toBe(pages);
    await expect(window.getByRole('button', { name: 'Select' })).toBeEnabled();
  }

  /** Select в панели: режим взведён, клик по кнопке страницы — чип у хозяина (тост «added to …»). */
  async function selectSave(electronApp: ElectronApplication, window: Page, url: string, toast: string): Promise<void> {
    const select = window.getByRole('button', { name: 'Select' });
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => pickArmed(electronApp, url)).toBe(true);
    await focusWindow(electronApp);
    await clickInGuest(electronApp, url, '#save');
    await expect(window.getByText(toast)).toBeVisible();
  }

  async function screenshot(window: Page, name: string, dpr: number): Promise<void> {
    await window.screenshot({ path: path.join(shots, `${name}-dpr${dpr}.png`) });
  }

  test('панель у чата: справа от Chat, страница грузится, Select кладёт чип в чат, панель переживает перезагрузку окна', async () => {
    const { electronApp, window, screenDpr } = await openApp({});
    const url = `${origin}/`;
    const chat = window.getByTestId('chat-view');
    const toggle = window.getByTestId('browser-panel-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    const panel = window.getByTestId('browser-panel');
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expectBeside(await boxOf(chat, 'Chat'), await boxOf(panel, 'панель'), 'чат');
    // Хозяин панели назван в полоске; меню «To» в панели нет — цель закреплена за хозяином.
    await expect(panel.getByTestId('browser-panel-owner')).toHaveText('S01 lead');
    await expect(panel.getByRole('button', { name: /^To:/ })).toHaveCount(0);

    await loadPage(electronApp, window, url);
    await screenshot(window, 'chat-wide-loaded', screenDpr);
    await selectSave(electronApp, window, url, '1 element added to S01');
    await expect(chat.locator('[data-testid="chat-attachments"] [data-context-kind="element"]')).toHaveCount(1);

    // Раскладка ушла на диск (тишина 500 мс): панель, её страница и ширина.
    const layouts = path.join(home, 'desktop', 'layouts.json');
    await expect.poll(async () => (await readFile(layouts, 'utf8').catch(() => '')).includes(`"url": "${url}"`)).toBe(true);
    await window.reload();
    await expect(window.getByTestId('chat-view')).toBeVisible();
    await expect(window.getByTestId('browser-panel')).toBeVisible();
    await expect(window.getByTestId('browser-panel-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => guestUrls(electronApp)).toEqual([url]);
    expectBeside(await boxOf(window.getByTestId('chat-view'), 'Chat после перезагрузки'), await boxOf(window.getByTestId('browser-panel'), 'панель после перезагрузки'), 'после перезагрузки');

    // Кнопка прячет панель, страницы остаются: вид снова на всю ширину.
    await window.getByTestId('browser-panel-toggle').click();
    await expect(window.getByTestId('browser-panel')).toBeHidden();
    await expect(window.getByTestId('chat-view')).toBeVisible();
  });

  test('панель у комнаты: справа от комнаты, страница грузится, Select кладёт чип в поле комнаты', async () => {
    const { electronApp, window, roomId, workKey, screenDpr } = await openApp({});
    await openRoom(window, workKey, roomId);
    const view = window.locator('[data-room-panel]');
    await window.getByTestId('browser-panel-toggle').click();
    const panel = window.getByTestId('browser-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-panel-owner', `room:${roomId}`);
    await expect(panel.getByTestId('browser-panel-owner')).toHaveText('e2e-room');
    expectBeside(await boxOf(view, 'комната'), await boxOf(panel, 'панель'), 'комната');

    const url = `${origin}/`;
    await loadPage(electronApp, window, url);
    await screenshot(window, 'room-wide-loaded', screenDpr);
    await selectSave(electronApp, window, url, '1 element added to e2e-room');
    await expect(window.locator('[data-room-attachments] [data-context-kind="element"]')).toHaveCount(1);
  });

  test('панель у терминала сессии: терминал уступает ей ширину, на узком виде остаётся на всю ширину под панелью', async () => {
    const { electronApp, window, lead, screenDpr } = await openApp({});
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect(window.getByTestId('terminal-body')).toBeVisible();
    const terminal = window.locator(`[data-surface-layer] [data-tab-id="terminal:${lead}"]`);
    const body = window.locator('[data-group-body]');
    const fullTerminal = await boxOf(terminal, 'терминал без панели');
    expect(Math.abs(fullTerminal.width - (await boxOf(body, 'тело группы')).width), 'терминал без панели не на всю ширину группы').toBeLessThanOrEqual(EDGE);

    await window.getByTestId('browser-panel-toggle').click();
    const panel = window.getByTestId('browser-panel');
    await expect(panel).toBeVisible();
    // Терминал уступил панели ровно её ширину: правый край у левого края панели, высота прежняя.
    await expect.poll(async () => (await boxOf(terminal, 'терминал')).x + (await boxOf(terminal, 'терминал')).width <= (await boxOf(panel, 'панель')).x + EDGE).toBe(true);
    const narrowed = await boxOf(terminal, 'терминал рядом с панелью');
    const panelBox = await boxOf(panel, 'панель');
    expect(Math.abs(narrowed.x + narrowed.width - panelBox.x), 'между терминалом и панелью зазор').toBeLessThanOrEqual(EDGE);
    expect(narrowed.height).toBeCloseTo(fullTerminal.height, 0);
    await screenshot(window, 'terminal-wide', screenDpr);

    // Окно сузилось до 800×500: панель поверх вида целиком, а терминал под ней не сжат — pty не получает ресайза.
    await setSize(electronApp, { width: 800, height: 500 });
    await expect.poll(async () => (await boxOf(panel, 'панель')).x <= (await boxOf(body, 'тело группы')).x + EDGE).toBe(true);
    expectCovers(await boxOf(body, 'тело группы'), await boxOf(panel, 'панель'), 'терминал');
    const covered = await boxOf(terminal, 'терминал под панелью');
    expect(Math.abs(covered.width - (await boxOf(body, 'тело группы')).width), 'терминал под панелью сжат').toBeLessThanOrEqual(EDGE);
    await screenshot(window, 'terminal-narrow', screenDpr);
    await panel.getByRole('button', { name: 'Back to chat' }).click();
    await expect(panel).toBeHidden();
  });

  test('800×500 с длинными названиями: панель поверх вида целиком, «Back to chat» и «Back to room» возвращают, шире окно — панель рядом', async () => {
    const { electronApp, window, roomId, workKey, screenDpr } = await openApp({ size: { width: 800, height: 500 }, long: true });
    const url = `${origin}${LONG_PATH}`;
    const chat = window.getByTestId('chat-view');
    await window.getByTestId('browser-panel-toggle').click();
    const panel = window.locator('[data-testid="browser-panel"][data-panel-owner^="session:"]');
    await expect(panel).toBeVisible();
    expectCovers(await boxOf(chat, 'Chat'), await boxOf(panel, 'панель'), 'чат');
    await loadPage(electronApp, window, url);
    const strip = panel.getByTestId('browser-panel-strip');
    // Полоска влезает: длинный хозяин режется многоточием, прокрутки вбок нет; кнопки на месте.
    const owner = panel.getByTestId('browser-panel-owner');
    await expect(owner).toContainText('S01 backend');
    expect(await owner.evaluate((node) => node.scrollWidth > node.clientWidth), 'длинный хозяин не обрезан').toBe(true);
    expect(await strip.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'полоска шире панели').toBe(true);
    await expect(panel.getByRole('button', { name: 'Add a page' })).toBeVisible();
    await screenshot(window, 'chat-narrow', screenDpr);

    // Чат под панелью недоступен (inert), «Back to chat» прячет панель.
    expect(await chat.evaluate((node) => node.closest('[inert]') !== null)).toBe(true);
    await panel.getByRole('button', { name: 'Back to chat' }).click();
    await expect(panel).toBeHidden();
    expect(await chat.evaluate((node) => node.closest('[inert]') !== null)).toBe(false);
    // Закрытая панель держит запасной размер (у неё нет участка в виде хозяина): страница не схлопывается до нуля.
    const closed = await boxOf(panel, 'закрытая панель');
    expect(closed.width, 'закрытая панель схлопнулась по ширине').toBeGreaterThanOrEqual(300);
    expect(closed.height, 'закрытая панель схлопнулась по высоте').toBeGreaterThanOrEqual(300);

    // Комната: та же панель-поверх с «Back to room»; длинное название комнаты — в полоске и в шапке.
    await openRoom(window, workKey, roomId);
    await window.getByTestId('browser-panel-toggle').click();
    // Панель чата закрыта, но жива (её страница не выгружается): у каждого хозяина своя панель в слое.
    const roomPanel = window.locator(`[data-testid="browser-panel"][data-panel-owner="room:${roomId}"]`);
    await expect(roomPanel).toBeVisible();
    expectCovers(await boxOf(window.locator('[data-room-panel]'), 'комната'), await boxOf(roomPanel, 'панель комнаты'), 'комната');
    await loadPage(electronApp, window, url, 2);
    await expect(roomPanel.getByRole('button', { name: 'Back to room' })).toBeVisible();
    expect(await roomPanel.getByTestId('browser-panel-strip').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'полоска комнаты шире панели').toBe(true);
    await screenshot(window, 'room-narrow', screenDpr);

    // Окно стало шире 720 px вида: панель встаёт рядом с видом, кнопка «Back» исчезает.
    await setSize(electronApp, { width: 1400, height: 900 });
    await expect(roomPanel.getByRole('button', { name: 'Back to room' })).toHaveCount(0);
    await expect.poll(async () => {
      const view = await boxOf(window.locator('[data-room-panel]'), 'комната');
      const side = await boxOf(roomPanel, 'панель комнаты');
      return side.x >= view.x + view.width - EDGE;
    }).toBe(true);
    await screenshot(window, 'room-wide-long', screenDpr);
  });
  test('«Move to browser of…»: страница вкладки человека переезжает в панель чата, вкладка закрывается', async () => {
    const { electronApp, window, lead } = await openApp({});
    await menu(electronApp, 'browser.newTab');
    const url = `${origin}/`;
    await loadPage(electronApp, window, url);
    const tab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(tab).toHaveCount(1);

    await window.getByRole('button', { name: 'More browser actions' }).click();
    await window.getByTestId('browser-move-to').click();
    await window.locator(`[role="menuitem"][data-owner-key="session:${lead}"]`).click();
    await expect(window.getByText('Moved to the browser of S01')).toBeVisible();

    // Вкладки больше нет, а Chat снова на экране с открытой панелью: страница та же, `<webview>` один.
    await expect(tab).toHaveCount(0);
    await expect(window.getByTestId('chat-view')).toBeVisible();
    const panel = window.getByTestId('browser-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await expect.poll(() => guestUrls(electronApp)).toEqual([url]);
    expectBeside(await boxOf(window.getByTestId('chat-view'), 'Chat'), await boxOf(panel, 'панель'), 'после переноса');
    // ⌘⇧T вкладку не возвращает: страница переехала, а не закрыта.
    await window.keyboard.press('Meta+Shift+T');
    await expect(tab).toHaveCount(0);
  });
});
