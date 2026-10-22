import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Окно принимает события main и после загрузки вкладки браузера. Признак «страница окна загружена»
 * (`loadedWindows` в `main/index.ts`) решает, дойдёт ли до окна `app:focus-target` (клик по уведомлению macOS) и
 * `app:update-available`. Загрузка `<webview>` (как и любого подкадра страницы окна) даёт webContents окна
 * `did-start-loading`, а `did-finish-load` — нет: признак снимался насовсем, и клик по уведомлению откладывался
 * в цели, которых живое окно уже не читает, — окно поднималось, а сессия не открывалась.
 *
 * Сценарий: вкладка браузера загрузила страницу, терминал сессии оказался под ней, ход сессии закончился —
 * уведомление в журнале main (`PARLEY_NOTIFICATIONS=log`); запись журнала кликается так же, как настоящее уведомление
 * (`attention.spec.ts`). Внешних сайтов нет — только свой сервер на 127.0.0.1; настоящий `claude` не запускается.
 * Проверка `app:update-available` в E2E недоступна: проверка версий идёт только у собранного окна.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const PAGE = '<!doctype html><title>Dev page</title><p>dev page</p>';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Адреса страниц гостей `<webview>` — то, что окно загрузило во вкладках браузера. */
async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code (`attention.spec.ts`). */
async function hookEvent(project: string, workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.parley', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
}

async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, body, silent }) => ({
      title,
      body,
      silent,
    })),
  );
}

/** Фокус ввода — в скрытом поле xterm терминала этой сессии в контейнере этой работы. */
async function terminalFocused(window: Page, workKey: string, sessionId: string): Promise<boolean> {
  return window.evaluate(
    ([key, id]) => {
      const active = document.activeElement;
      return (
        active !== null &&
        active.classList.contains('xterm-helper-textarea') &&
        active.closest(`[data-work-container="${key}"] [data-tab-id="terminal:${id}"]`) !== null
      );
    },
    [workKey, sessionId] as const,
  );
}

test.describe('окно принимает события main после загрузки вкладки браузера', () => {
  test.setTimeout(90_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('window-ready');
    project = await makeTempProject('window-ready');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
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

  test('страница загружена в <webview>, терминал сессии под вкладкой браузера: клик по уведомлению о конце хода открывает терминал и фокусирует его', async () => {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_NOTIFICATIONS: 'log' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    // Работа с сессией; клик по строке сессии открывает её терминал.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-ready', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'agent',
      task: '',
      parent: null,
    });
    const sessionId = created.ref.sessionId;
    const workKey = `${project} ${workId}`;
    const sessionRow = window.locator(`[data-work-key="${workKey}"]:not([role="tab"]) [data-session-id="${sessionId}"]`);
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();
    const terminalTab = window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`);
    await expect(terminalTab).toHaveAttribute('data-active', 'true');

    // «+» → «New browser tab» → адрес: страница встаёт в <webview>, вкладка браузера — на виду.
    await window.getByRole('button', { name: 'Open…' }).first().click();
    await window.locator('[data-palette] [role="option"]', { hasText: 'New browser tab' }).click();
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(origin.replace('http://', ''));
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp), { timeout: 15_000 }).toEqual([`${origin}/`]);
    const browserTab = window.locator('[role="tab"][data-tab-id^="browser:"]');
    await expect(browserTab).toContainText('Dev page', { timeout: 15_000 });
    await expect(browserTab).toHaveAttribute('data-active', 'true');
    // Терминал сессии открыт, но не на виду: уведомление о конце хода не погасится «сессия видна».
    await expect(terminalTab).not.toHaveAttribute('data-active', 'true');

    // Ход сессии: сначала окно видит working (первое значение — база без уведомления, спека 7.4), затем Stop.
    const rowOf = `[data-work-key="${workKey}"]:not([role="tab"]) [data-session-id="${sessionId}"]`;
    await hookEvent(project, workId, sessionId, { hook_event_name: 'UserPromptSubmit' });
    await expect(window.locator(`${rowOf} [data-state="working"]`)).toHaveCount(1, { timeout: 10_000 });
    await hookEvent(project, workId, sessionId, { hook_event_name: 'Stop' });
    await expect
      .poll(() => loggedNotes(electronApp), { timeout: 10_000 })
      .toContainEqual({ title: 'e2e-ready · S01 agent — finished', body: '', silent: true });

    // Клик по записи журнала делает то же, что клик по настоящему уведомлению: main поднимает окно и шлёт ему цель.
    await electronApp.evaluate(() => {
      const log = (globalThis as { __parleyNotifications?: Array<{ title: string; click(): void }> }).__parleyNotifications ?? [];
      log.filter((note) => note.title.startsWith('e2e-ready')).at(-1)?.click();
    });
    await expect(
      terminalTab,
      'цель клика не дошла до окна: после загрузки <webview> main не считает страницу окна загруженной',
    ).toHaveAttribute('data-active', 'true', { timeout: 10_000 });
    await expect.poll(() => terminalFocused(window, workKey, sessionId), { timeout: 5_000 }).toBe(true);
  });
});
