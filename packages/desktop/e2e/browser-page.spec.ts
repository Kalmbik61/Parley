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
 * Страница в окне (кусок 9.2b, спека 7.2, 9.6, 12.2): фокус гостя делает группу страницы активной,
 * ⌘W, ⌘F и ⌘+ из страницы идут её вкладке, `window.open` открывает вкладку рядом с открывателем.
 * Только настоящий Electron: jsdom не знает ни `<webview>`, ни `focus` его `WebContents`.
 *
 * Ввод в гостя — `sendInputEvent` main (page.keyboard Playwright шлёт события окну, не гостю).
 * Внешних сайтов нет — только свой сервер на 127.0.0.1. Настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>Dev page</title><p>needle one</p><p>needle two</p>',
  '/popup': '<!doctype html><title>Popup page</title><p>popup</p>',
};

let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function menu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, action) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', action);
  }, id);
}

/** Нажатие в гостя со страницей prefix — как его увидел бы before-input-event от человека. */
async function pressInGuest(app: ElectronApplication, prefix: string, keyCode: string, modifiers: string[]): Promise<void> {
  await app.evaluate(
    ({ webContents }, [p, k, m]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(p as string));
      const mods = m as Array<'meta'>;
      guest?.sendInputEvent({ type: 'keyDown', keyCode: k as string, modifiers: mods });
      guest?.sendInputEvent({ type: 'keyUp', keyCode: k as string, modifiers: mods });
    },
    [prefix, keyCode, modifiers] as const,
  );
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

async function zoomOf(app: ElectronApplication, prefix: string): Promise<number | null> {
  return app.evaluate(({ webContents }, p) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(p));
    return guest === undefined ? null : guest.getZoomLevel();
  }, prefix);
}

/** Вкладки по группам видимой раскладки (две группы — строки в самих группах). */
async function groupTabs(window: Page): Promise<string[][]> {
  return window.evaluate(() =>
    [...document.querySelectorAll('[data-work-container]:not([style*="hidden"]) [data-group-id]')].map((group) =>
      [...group.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('data-tab-id') ?? ''),
    ),
  );
}

test.describe('страница в окне (кусок 9.2b)', () => {
  test.setTimeout(90_000);
  let home: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-page');
    project = await makeTempProject('browser-page');
    server = createServer((req, res) => {
      const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('клик в страницу левой группы — ⌘W из неё закрывает её вкладку; ⌘F — поиск, ⌘+ — масштаб; window.open — вкладка рядом', async () => {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const electronApp = app;
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-page', goal: '' });
    const create = async (label: string): Promise<string> =>
      (
        await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label,
          task: '',
          parent: null,
        })
      ).ref.sessionId;
    const s1 = await create('one');
    const s2 = await create('two');
    const workKey = `${project} ${workId}`;
    await window.locator(`[data-work-key="${workKey}"] [data-session-id="${s1}"]`).click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${s1}"]`)).toBeVisible();

    // Страница в первой группе.
    await menu(electronApp, 'browser.newTab');
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(`${origin}/`);
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/`]);
    const pageTab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(pageTab).toContainText('Dev page');
    const pageTabId = await pageTab.getAttribute('data-tab-id');

    // Вторая группа справа с терминалом S02 — она активная.
    await menu(electronApp, 'group.splitRight');
    await window.getByRole('dialog').getByRole('option', { name: /S02 two/ }).click();
    await expect.poll(() => groupTabs(window)).toEqual([[`terminal:${s1}`, pageTabId], [`terminal:${s2}`]]);

    // Клик в страницу: DOM окна его не видит — группу делает активной browser:focus гостя.
    // Окно E2E, запущенное в фоне, macOS ключевым не делает (isFocused() — false), и focus гостя
    // Electron тогда не шлёт. Клик — настоящий, а focus его WebContents — тот, что Electron дал бы
    // в ключевом окне: так проверяется путь страж → browser:focus → активная группа. Сам focus
    // от клика — живая проверка приёмки 9.2b.
    await window.locator('webview').click({ position: { x: 40, y: 40 } });
    await electronApp.evaluate(({ webContents }, p) => {
      webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(p))?.emit('focus');
    }, `${origin}/`);
    await pressInGuest(electronApp, `${origin}/`, 'W', ['meta']);
    await expect.poll(() => groupTabs(window)).toEqual([[`terminal:${s1}`], [`terminal:${s2}`]]);
    await expect.poll(() => guestUrls(electronApp)).toEqual([]);

    // Снова страница — в первой группе (она осталась активной после ⌘W); ⌘F, ⌘+ и window.open из неё.
    await menu(electronApp, 'browser.newTab');
    await address.fill(`${origin}/`);
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/`]);
    await window.locator('webview').click({ position: { x: 40, y: 40 } });

    await pressInGuest(electronApp, `${origin}/`, 'F', ['meta']);
    const find = window.getByRole('search', { name: 'Find in page' });
    await expect(find).toBeVisible();
    await find.getByPlaceholder('Find…').fill('needle');
    // Совпадений два; какое из них текущее, решает Chromium от места клика в странице.
    await expect(find).toContainText(/[12]\/2/);
    await find.getByPlaceholder('Find…').press('Escape');
    await expect(find).toHaveCount(0);

    await pressInGuest(electronApp, `${origin}/`, '=', ['meta']);
    await expect.poll(() => zoomOf(electronApp, `${origin}/`)).toBe(1);
    await pressInGuest(electronApp, `${origin}/`, '0', ['meta']);
    await expect.poll(() => zoomOf(electronApp, `${origin}/`)).toBe(0);

    // window.open по жесту человека в странице: вкладка сразу за открывателем, в его группе, активная.
    await electronApp.evaluate(async ({ webContents }, p) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(p));
      await guest?.executeJavaScript(`window.open('/popup'); true`, true);
    }, `${origin}/`);
    await expect.poll(() => guestUrls(electronApp).then((urls) => [...urls].sort())).toEqual([`${origin}/`, `${origin}/popup`]);
    const tabs = await groupTabs(window);
    const first = tabs[0] ?? [];
    expect(tabs[1]).toEqual([`terminal:${s2}`]);
    expect(first).toHaveLength(3);
    expect(first[0]).toBe(`terminal:${s1}`);
    expect(first[1]).toMatch(/^browser:/);
    expect(first[2]).toMatch(/^browser:/);
    await expect(window.locator(`[role="tab"][data-tab-id="${first[2]}"]`)).toContainText('Popup page');
    await expect(window.locator(`[role="tab"][data-tab-id="${first[2]}"]`)).toHaveAttribute('data-active', 'true');
  });
});
