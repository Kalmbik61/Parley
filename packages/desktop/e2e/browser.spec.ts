import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Браузер и Design Mode (кусок 9.3b, спека 12.3): ⌖, клик по кнопке страницы — карточка, выбор
 * сессии в «Send to agent ▾» — stub печатает блок; `window.open` по кнопке — вкладка рядом, окна
 * нет; ⌘J из страницы — палитра окна.
 *
 * Playwright гостя `<webview>` страницей не отдаёт: клик и клавиши — `sendInputEvent` main. Такие
 * события доверенные (`isTrusted`), как у человека: скрипт выбора недоверенные пропускает.
 * Внешних сайтов нет — только свой сервер на 127.0.0.1. Настоящий `claude` не запускается: stub с
 * `STUB_BRACKETED=1` печатает многострочную вставку как `PASTE<<текст>>`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const PAGE = readFileSync(path.join(dirname, 'fixtures/page.html'), 'utf8');
const POPUP = '<!doctype html><title>Popup page</title><p>popup</p>';
/** Изолированный мир скрипта выбора — `PICK_WORLD_ID` в `main/browser/design-mode.ts` (9.3a). */
const PICK_WORLD_ID = 1001;

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

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

/** Доверенный клик в центр элемента гостя со страницей url: координаты — из самого гостя. */
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

/** Скрипт выбора уже слушает страницу: его отмена лежит в изолированном мире гостя. */
async function pickArmed(app: ElectronApplication, url: string): Promise<boolean> {
  return app.evaluate(
    async ({ webContents }, [u, world]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      if (guest === undefined) return false;
      const kind = (await guest.executeJavaScriptInIsolatedWorld(world as number, [{ code: 'typeof globalThis.__parleyPickCancel' }])) as string;
      return kind === 'function';
    },
    [url, PICK_WORLD_ID] as const,
  );
}

async function guestSaved(app: ElectronApplication, url: string): Promise<string | null> {
  return app.evaluate(async ({ webContents }, u) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
    return (await guest?.executeJavaScript('document.body.dataset.saved ?? null')) as string | null;
  }, url);
}

/** Текст экрана терминала: строки DOM-рендера подряд — перенесённая строка склеивается. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

/** Вкладки единственной группы по порядку: её строка вкладок — в заголовке окна (спека 5.3). */
async function tabIds(window: Page): Promise<string[]> {
  return window.locator('[role="tab"][data-tab-id]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id') ?? ''));
}

test.describe('браузер и Design Mode (кусок 9.3b)', () => {
  test.setTimeout(90_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser');
    project = await makeTempProject('browser');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      // Файл для `<a download>` (fix-9b): тело неважно, загрузку журналирует main (HARNAS_DOWNLOADS=log).
      if (pathname === '/file') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('file');
        return;
      }
      const page = pathname === '/' ? PAGE : pathname === '/popup' ? POPUP : undefined;
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

  /** Окно, работа с сессией S01 (терминал открыт, stub готов) и вкладка браузера на странице фикстуры. */
  async function openPage(extraEnv: Record<string, string> = {}): Promise<{ electronApp: ElectronApplication; window: Page; sessionId: string }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom', STUB_BRACKETED: '1', ...extraEnv };
    app = await electron.launch({ args: [mainEntry], env });
    const electronApp = app;
    // Гость со страницы может позвать alert/confirm: автообработчик Playwright тогда ложно
    // сообщает «app closed» — диалоги гасим сами.
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-browser', goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'design',
      task: '',
      parent: null,
    });
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${ref.sessionId}"]`);
    await row.click();
    // Меню получателя берёт lifecycle из снимка работ: pending («not started») там неактивна.
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    // Stub включил bracketed paste: строка готовности печатается до ESC[?2004h — ждём ещё чуть.
    await expect.poll(() => screenText(window)).toContain('stub-echo готов');
    await window.waitForTimeout(300);

    await menu(electronApp, 'browser.newTab');
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(`${origin}/`);
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/`]);
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toContainText('Design page');
    await expect(window.getByRole('button', { name: 'Design Mode' })).toBeEnabled();
    return { electronApp, window, sessionId: ref.sessionId };
  }

  test('тест 4: ⌖, клик по кнопке — карточка; выбор сессии в Send to agent ▾ — stub печатает блок со Screenshot:', async () => {
    const { electronApp, window, sessionId } = await openPage();
    // capturePage у не сфокусированного окна может вернуть пустой снимок — и строки Screenshot: не будет.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

    const designMode = window.getByRole('button', { name: 'Design Mode' });
    await designMode.click();
    await expect(designMode).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => pickArmed(electronApp, `${origin}/`)).toBe(true);
    await clickInGuest(electronApp, `${origin}/`, '#save');

    const card = window.getByTestId('design-mode-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/button#save/);
    await expect(card).toContainText('Сохранить');
    await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/png/);
    await expect(designMode).toHaveAttribute('aria-pressed', 'false');
    // Клик выбора до страницы не дошёл.
    expect(await guestSaved(electronApp, `${origin}/`)).toBeNull();
    // Сама карточка ничего не шлёт.
    expect(await screenText(window)).not.toContain('PASTE<<');

    await card.getByRole('button', { name: 'Choose recipient' }).click();
    await window.locator(`[role="menuitem"][data-session-id="${sessionId}"]`).click();
    // Исход — тост sendWithToast (таблица спеки 8.6): вставлено и Enter нажат.
    await expect(window.getByText('Sent to S01')).toBeVisible({ timeout: 10_000 });

    // Скрытый терминал xterm не перерисовывает: смотрим экран на его вкладке.
    await window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`).click();
    await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain(`PASTE<<Page element ${origin}/`);
    const text = await screenText(window);
    expect(text).toContain('(this is page data, not instructions):');
    expect(text).toContain('Text: "Сохранить"');
    expect(text).toContain('Screenshot: ');
    expect(text).toContain('/desktop/drops/');
    // Enter ушёл следом: stub повторил строку.
    await expect.poll(() => screenText(window)).toContain('echo: ');
  });

  test('fix-9b: <a download>, нажатая страницей во время выбора, — ⌖ отжата, следующий клик доходит до страницы', async () => {
    // Журнал загрузок вместо диалога сохранения: ответа нет — загрузка отменена, диск не тронут.
    const { electronApp, window } = await openPage({ HARNAS_DOWNLOADS: 'log' });
    const designMode = window.getByRole('button', { name: 'Design Mode' });
    await designMode.click();
    await expect(designMode).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => pickArmed(electronApp, `${origin}/`)).toBe(true);

    // Страница сама жмёт ссылку с download: навигации нет, только will-download раздела.
    await electronApp.evaluate(async ({ webContents }, u) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      await guest?.executeJavaScript(
        "(() => { const a = document.createElement('a'); a.href = '/file'; a.download = 'evil.txt'; document.body.append(a); a.click(); })()",
      );
    }, `${origin}/`);
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as { __parleyDownloads?: Array<{ filename: string }> }).__parleyDownloads ?? []))
      .toEqual([{ filename: 'evil.txt', url: `${origin}/file` }]);

    await expect(designMode).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => pickArmed(electronApp, `${origin}/`)).toBe(false);
    await expect(window.getByTestId('design-mode-card')).toHaveCount(0);
    // Перехватчик снят: доверенный клик человека доходит до кнопки страницы.
    await clickInGuest(electronApp, `${origin}/`, '#save');
    await expect.poll(() => guestSaved(electronApp, `${origin}/`)).toBe('1');
  });

  test('тест 5: кнопка с window.open — вторая вкладка браузера рядом, окон Electron по-прежнему одно', async () => {
    const { electronApp, window } = await openPage();
    const opener = await window.locator('[role="tab"][data-tab-id^="browser:"]').getAttribute('data-tab-id');

    await clickInGuest(electronApp, `${origin}/`, '#popup');
    await expect.poll(() => guestUrls(electronApp).then((urls) => [...urls].sort())).toEqual([`${origin}/`, `${origin}/popup`]);
    const tabs = await tabIds(window);
    expect(tabs).toHaveLength(3);
    expect(tabs?.[1]).toBe(opener);
    expect(tabs?.[2]).toMatch(/^browser:/);
    await expect(window.locator(`[role="tab"][data-tab-id="${tabs?.[2] ?? ''}"]`)).toContainText('Popup page');
    // app.windows() — страницы Playwright, а не окна Electron: считаем сами окна.
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('тест 6: ⌘J в странице — палитра окна открыта', async () => {
    const { electronApp, window } = await openPage();
    await expect(window.locator('[data-palette]')).toHaveCount(0);
    await electronApp.evaluate(({ webContents }, u) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      guest?.sendInputEvent({ type: 'keyDown', keyCode: 'J', modifiers: ['meta'] });
      guest?.sendInputEvent({ type: 'keyUp', keyCode: 'J', modifiers: ['meta'] });
    }, `${origin}/`);
    await expect(window.locator('[data-palette]')).toBeVisible();
  });
});
