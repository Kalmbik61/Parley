import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

/**
 * Спайк куска 9.1 (спека 12.2) — постоянным тестом. Внешних сайтов нет: только свой сервер на
 * 127.0.0.1. Вкладки браузера ещё нет (9.2a), поэтому `<webview>` вставляется в окно руками —
 * так же, как его вставил бы чужой код из DevTools.
 *
 * Положительный контроль обязателен: без него отказы ниже прошли бы и со сломанным стражем
 * (например, если бы ни один `<webview>` не прикреплялся вовсе).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>guest ok</title><p>hello from the guest page</p>',
  // Три пути к диску из страницы: подфрейм, навигация главного фрейма и window.open.
  '/evil':
    '<!doctype html><title>evil</title><iframe id="f" src="file:///etc/hosts"></iframe><script>' +
    'setTimeout(() => { window.open("file:///etc/hosts"); window.open("about:blank"); window.open("/popup"); }, 100);' +
    'setTimeout(() => { location.href = "file:///etc/hosts"; }, 300);' +
    '</script>',
  '/popup': '<!doctype html><title>popup</title>',
};

async function guestCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((c) => c.getType() === 'webview').length);
}

/** Вставляет `<webview>` в DOM окна; атрибуты — как есть. */
async function insertWebview(window: Page, attrs: Record<string, string>): Promise<void> {
  await window.evaluate((a) => {
    const view = document.createElement('webview');
    for (const [name, value] of Object.entries(a)) view.setAttribute(name, value);
    view.setAttribute('data-e2e', 'webview');
    view.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:200px;';
    document.body.appendChild(view);
  }, attrs);
}

/** Выполняет код в госте с адресом, начинающимся с prefix (только тест: у рендерера такого права нет). */
async function inGuest<T>(app: ElectronApplication, prefix: string, code: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, { prefix, code }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      if (guest === undefined) throw new Error(`no guest at ${prefix}`);
      return guest.executeJavaScript(code) as Promise<unknown>;
    },
    { prefix, code },
  ) as Promise<T>;
}

test.describe('клетка встроенного браузера (кусок 9.1, спайк)', () => {
  // Ожидания отказов (по 1,5 с) и два гостя под нагрузкой соседних прогонов не укладываются в 30 с.
  test.setTimeout(60_000);
  let home: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  const launch = async (): Promise<ElectronApplication> => {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, HARNAS_HOME: home } });
    return app;
  };

  test.beforeEach(async () => {
    home = await makeTempHome('browser');
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
    // Хост без pid-файла (ещё стартует) stopHost тоже находит — ждать его не нужно.
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('webview раздела прикрепляется при CSP окна, чужое и file: — нет; навигация, окна и мост — по стражу', async () => {
    const app = await launch();
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    await window.evaluate(() => {
      const opened: unknown[] = [];
      (globalThis as { __openTabs?: unknown[] }).__openTabs = opened;
      window.harnas.browser.onOpenTab((e) => opened.push(e));
    });

    // Положительный контроль: раздел наш, адрес http — страница отрисовалась, без Node.
    await insertWebview(window, {
      partition: 'persist:harnas-browser',
      src: `${origin}/`,
      webpreferences: 'nodeIntegration=yes, contextIsolation=no, sandbox=no',
      preload: 'file:///tmp/harnas-e2e-no-such-preload.js',
    });
    await expect.poll(() => guestCount(app)).toBe(1);
    await expect.poll(() => inGuest<string>(app, `${origin}/`, 'document.title').catch(() => '')).toBe('guest ok');
    expect(await inGuest<string>(app, `${origin}/`, 'typeof require + "," + typeof process')).toBe('undefined,undefined');
    // Атрибут webpreferences просил Node и preload — страж их снял (sanitizeWebviewAttach).
    const prefs = await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
      const p = guest?.getLastWebPreferences();
      return {
        nodeIntegration: p?.nodeIntegration,
        contextIsolation: p?.contextIsolation,
        sandbox: p?.sandbox,
        webviewTag: p?.webviewTag,
        disableDialogs: p?.disableDialogs,
        preload: p?.preload ?? null,
      };
    });
    expect(prefs).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      disableDialogs: true,
      preload: null,
    });

    // Отказы: без раздела, чужой раздел, file: и вложенный <webview> в госте (webviewTag гостя выключен).
    await insertWebview(window, { src: `${origin}/` });
    await insertWebview(window, { partition: 'persist:other', src: `${origin}/` });
    await insertWebview(window, { partition: 'persist:harnas-browser', src: 'file:///etc/hosts' });
    await window.waitForTimeout(1500);
    expect(await guestCount(app)).toBe(1);

    // Страница с тремя путями к диску: ничего из file: не загрузилось, вкладка — только для http.
    // allowpopups — как у вкладки (спека 12.2): без него Electron гасит window.open до обработчика.
    await insertWebview(window, { partition: 'persist:harnas-browser', src: `${origin}/evil`, allowpopups: '' });
    await expect.poll(() => guestCount(app)).toBe(2);
    await window.waitForTimeout(1500);
    const evil = await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      return {
        url: guest?.getURL() ?? null,
        frames: guest?.mainFrame.framesInSubtree.map((frame) => frame.url) ?? [],
      };
    }, `${origin}/evil`);
    expect(evil.url).toBe(`${origin}/evil`);
    expect(evil.frames.some((url) => url.startsWith('file:'))).toBe(false);
    const opened = await window.evaluate(() => (globalThis as { __openTabs?: unknown[] }).__openTabs);
    expect(opened).toHaveLength(1);
    expect(opened?.[0]).toMatchObject({ url: `${origin}/popup` });
    expect(await guestCount(app)).toBe(2);

    // Мост: find по живому гостю, масштаб только у него, DevTools окна — отказ bad_request.
    const guestId = await app.evaluate(({ webContents }, prefix) => {
      return webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === prefix)?.id ?? -1;
    }, `${origin}/`);
    expect(guestId).toBeGreaterThan(0);
    const found = await window.evaluate((id) => window.harnas.browser.find(id, 'hello', true), guestId);
    expect(found.matches).toBe(1);
    await window.evaluate((id) => window.harnas.browser.zoom(id, 1), guestId);
    expect(
      await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomLevel(), guestId),
    ).toBe(1);
    const denied = await window.evaluate(async () => {
      try {
        await window.harnas.browser.openDevTools(1);
        return 'opened';
      } catch (error) {
        return String((error as Error).message);
      }
    });
    expect(denied).toContain('bad_request');
    await window.evaluate(() => window.harnas.browser.clearData());
  });

  /**
   * Перенос из 6.1a: ⌃Tab страница оставляет себе (спека 9.6), а keyUp ⌃ из гостя окну не
   * приходит. Цикл MRU, начатый в окне, всё равно кончается: фокус, ушедший в <webview>, даёт
   * окну `blur`, а его `installKeyHandler` слушает как конец цикла (endMruCycle).
   */
  test('фокус в госте — blur окна; keyUp Control гостя до окна не доходит', async () => {
    const app = await launch();
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

    await insertWebview(window, { partition: 'persist:harnas-browser', src: `${origin}/` });
    await expect.poll(() => inGuest<string>(app, `${origin}/`, 'document.title').catch(() => '')).toBe('guest ok');
    await window.evaluate(() => {
      const log: string[] = [];
      (globalThis as { __log?: string[] }).__log = log;
      window.addEventListener('blur', () => log.push('blur'));
      window.addEventListener('keyup', (e) => log.push(`keyup:${e.key}`), true);
    });

    await window.evaluate(() => (document.querySelector('webview[data-e2e]') as HTMLElement).focus());
    await expect.poll(() => window.evaluate(() => (globalThis as { __log?: string[] }).__log)).toEqual(['blur']);
    expect(await inGuest<boolean>(app, `${origin}/`, 'document.hasFocus()')).toBe(true);

    await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      guest?.sendInputEvent({ type: 'keyDown', keyCode: 'Control', modifiers: ['control'] });
      guest?.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    }, `${origin}/`);
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => (globalThis as { __log?: string[] }).__log)).toEqual(['blur']);
  });
});
