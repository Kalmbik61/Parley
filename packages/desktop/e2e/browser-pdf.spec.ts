import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * PDF во встроенном браузере (план 2026-10-19, P0). Открытие PDF в `<webview>` грузит подкадром просмотрщик
 * Chromium — `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`. Страж отказывал ему и звал `stop()`
 * в `did-start-navigation`; `stop()` в этот момент падает по CHECK в браузерном процессе Electron 44.4.5 (SIGTRAP),
 * и вместе с гостем закрывался весь Parley. Теперь страж пускает ровно этот origin подкадром (`guard.ts`).
 *
 * Положительные сценарии идут через настоящую вкладку (меню → адресная строка → ссылка в гостя): падение
 * воспроизводилось именно там. Отрицательные — `<webview>`, вставленный в окно руками, как в `browser-guard.spec.ts`.
 * Инспектор (журнал консоли и сети) стоит на госте всегда: страж зовёт `inspect` до первой загрузки, так что каждый
 * сценарий идёт с прикреплённым отладчиком; журнал проверяется отдельно.
 *
 * Внешних сайтов нет — только свой сервер на 127.0.0.1. Настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
const DOC = readFileSync(path.join(dirname, 'fixtures/doc.pdf'));
const DOC_3P = readFileSync(path.join(dirname, 'fixtures/doc-3p.pdf'));

const PAGES: Record<string, string> = {
  '/':
    '<!doctype html><title>Links</title>' +
    '<a id="direct" href="/doc-3p.pdf">direct</a> ' +
    '<a id="blank" href="/doc-3p.pdf" target="_blank">blank</a> ' +
    '<a id="redirect" href="/redirect">redirect</a> ' +
    '<a id="broken" href="/broken.pdf">broken</a> ' +
    '<a id="missing" href="/missing.pdf">missing</a>',
  '/plain': '<!doctype html><title>Plain neighbor</title><p>still works</p>',
  '/embed': '<!doctype html><title>Embed</title><embed src="/doc.pdf" type="application/pdf" width="600" height="600">',
  // Страница пытается сама встроить просмотрщик: ресурсы расширения не web-accessible, Chromium такой подкадр отвергает.
  '/viewer-iframe': `<!doctype html><title>Viewer iframe</title><iframe src="${PDF_VIEWER}index.html"></iframe>`,
  '/file-iframe': '<!doctype html><title>File iframe</title><iframe src="file:///etc/hosts"></iframe>',
};

function servePdf(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, { 'content-type': 'application/pdf' }).end(body);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  if (pathname === '/doc.pdf') return servePdf(res, DOC);
  if (pathname === '/doc-3p.pdf') return servePdf(res, DOC_3P);
  if (pathname === '/broken.pdf') return servePdf(res, Buffer.from('%PDF-1.4\nthis is not a pdf'));
  if (pathname === '/missing.pdf') {
    // 404 с телом: страница ошибки сервера — обычный HTML, просмотрщик ей не нужен.
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Not found</title><p>no such file</p>');
    return;
  }
  if (pathname === '/redirect') {
    res.writeHead(302, { location: '/doc.pdf' }).end();
    return;
  }
  const page = PAGES[pathname];
  if (page === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
}

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

/** Главный процесс жив и отвечает: после падения Parley `evaluate` бросает, а процесс уже вышел. */
async function expectAlive(app: ElectronApplication): Promise<void> {
  expect(app.process().exitCode, 'процесс Electron вышел').toBeNull();
  expect(await app.evaluate(() => process.pid)).toBeGreaterThan(0);
}

interface Guest {
  id: number;
  url: string;
  /** Адреса всех фреймов гостя, главный первым. */
  frames: string[];
}

async function guests(app: ElectronApplication): Promise<Guest[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => ({ id: c.id, url: c.getURL(), frames: c.mainFrame.framesInSubtree.map((frame) => frame.url) })),
  );
}

async function guestAt(app: ElectronApplication, url: string): Promise<Guest | undefined> {
  return (await guests(app)).find((guest) => guest.url === url);
}

const hasViewer = (guest: Guest | undefined): boolean => guest?.frames.some((url) => url.startsWith(PDF_VIEWER)) === true;

/**
 * Сколько разных цветов в снимке гостя (уменьшенном): пустая белая или прозрачная панель даёт один. -1 — снимка пока
 * нет: до первого кадра гостя `capturePage` отказывает (UnknownVizError), и опрос просто идёт дальше.
 */
async function paintedColors(app: ElectronApplication, guestId: number): Promise<number> {
  return app.evaluate(async ({ webContents }, id) => {
    try {
      const image = await webContents.fromId(id)?.capturePage();
      if (image === undefined) return -1;
      const bitmap = new Uint8Array(image.resize({ width: 300 }).toBitmap());
      return new Set(new Uint32Array(bitmap.buffer)).size;
    } catch {
      return -1;
    }
  }, guestId);
}

/** Видимая поверхность вкладки браузера: Back, Forward и Reload окна (в шапке) — не её кнопки. */
const surface = (window: Page): Locator =>
  window.locator('div[data-tab-id^="browser:"]:not([role="tab"])').filter({ visible: true });

/** Выполняет код в госте с жестом человека — иначе `target=_blank` и переходы по ссылкам гасит Chromium. */
async function inGuest<T>(app: ElectronApplication, guestId: number, code: string): Promise<T> {
  return app.evaluate(({ webContents }, [id, source]) => webContents.fromId(id as number)?.executeJavaScript(source as string, true), [
    guestId,
    code,
  ] as const) as Promise<T>;
}

/** Вставляет `<webview>` раздела браузера в DOM окна руками, как в `browser-guard.spec.ts`: страница стартует сразу с адреса. */
async function insertWebview(window: Page, src: string): Promise<void> {
  await window.evaluate((address) => {
    const view = document.createElement('webview');
    view.setAttribute('partition', 'persist:harnas-browser');
    view.setAttribute('src', address);
    view.setAttribute('data-e2e', 'webview');
    view.style.cssText = 'position:fixed;right:0;bottom:0;width:480px;height:320px;';
    document.body.appendChild(view);
  }, src);
}

test.describe('PDF во встроенном браузере (P0)', () => {
  test.setTimeout(90_000);
  let home: string;
  let project: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-pdf');
    project = await makeTempProject('browser-pdf');
    server = createServer(route);
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

  /** Окно с работой и одной сессией: вкладке браузера нужна активная группа. */
  const launch = async (): Promise<Page> => {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-pdf', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'agent',
      task: '',
      parent: null,
    });
    await window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${created.ref.sessionId}"]`).click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${created.ref.sessionId}"]`)).toBeVisible();
    return window;
  };

  /** Новая вкладка браузера с адресом — как её открывает человек. */
  const openPage = async (window: Page, url: string): Promise<Guest> => {
    if (app === null) throw new Error('приложение не запущено');
    await menu(app, 'browser.newTab');
    const address = window.locator('input[aria-label="Address"]:focus');
    await expect(address).toBeVisible();
    await address.fill(url);
    await address.press('Enter');
    const electronApp = app;
    await expect.poll(() => guestAt(electronApp, url)).toBeDefined();
    const guest = await guestAt(electronApp, url);
    if (guest === undefined) throw new Error(`нет гостя ${url}`);
    return guest;
  };

  test('ссылка на PDF: просмотрщик открылся, Parley жив; reload, назад, закрытие и повторное открытие', async () => {
    const window = await launch();
    const electronApp = app as ElectronApplication;

    // Соседняя вкладка: она должна остаться рабочей на всём пути.
    const neighbor = await openPage(window, `${origin}/plain`);
    const page = await openPage(window, `${origin}/`);
    await expect.poll(() => paintedColors(electronApp, page.id)).toBeGreaterThan(1);

    await inGuest(electronApp, page.id, `document.getElementById('direct').click(); true`);
    const pdfUrl = `${origin}/doc-3p.pdf`;
    await expect.poll(async () => hasViewer(await guestAt(electronApp, pdfUrl)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);
    await expect.poll(() => paintedColors(electronApp, page.id), { timeout: 20_000 }).toBeGreaterThan(8);

    // Инспектор: журнал сети гостя записал сам PDF, захват включён.
    const snapshot = await window.evaluate((id) => window.parley.browser.devtoolsSnapshot(id), page.id);
    expect(snapshot.capture).not.toBe('unavailable');
    expect(snapshot.network.some((entry) => entry.url === pdfUrl && entry.status === 200)).toBe(true);

    // Reload: документ создан заново (маркер пропал), просмотрщик поднимается снова, процесс жив.
    await inGuest(electronApp, page.id, `window.__e2eMarker = 1; true`);
    expect(await inGuest(electronApp, page.id, 'window.__e2eMarker')).toBe(1);
    await surface(window).getByRole('button', { name: 'Reload' }).click();
    await expect.poll(() => inGuest(electronApp, page.id, 'window.__e2eMarker'), { timeout: 20_000 }).toBeUndefined();
    await expect.poll(async () => hasViewer(await guestAt(electronApp, pdfUrl)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);

    // Назад — на страницу ссылок, вперёд — снова в просмотрщик.
    await surface(window).getByRole('button', { name: 'Back' }).click();
    await expect.poll(async () => (await guestAt(electronApp, `${origin}/`)) !== undefined).toBe(true);
    await expectAlive(electronApp);
    await surface(window).getByRole('button', { name: 'Forward' }).click();
    await expect.poll(async () => hasViewer(await guestAt(electronApp, pdfUrl)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);

    // Закрыли вкладку с PDF и открыли заново: процесс жив, просмотрщик снова на месте.
    await menu(electronApp, 'tab.close');
    await expect.poll(async () => (await guests(electronApp)).some((guest) => guest.url === pdfUrl)).toBe(false);
    await expectAlive(electronApp);
    await menu(electronApp, 'tab.reopen');
    await expect.poll(async () => hasViewer(await guestAt(electronApp, pdfUrl)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);

    // Соседняя вкладка отвечает.
    const alive = await guestAt(electronApp, `${origin}/plain`);
    expect(alive?.id).toBe(neighbor.id);
    expect(await inGuest<string>(electronApp, neighbor.id, 'document.title')).toBe('Plain neighbor');
  });

  test('target=_blank и редирект 302 на PDF: просмотрщик открылся, Parley жив', async () => {
    const window = await launch();
    const electronApp = app as ElectronApplication;
    const page = await openPage(window, `${origin}/`);

    // target=_blank: вкладка рядом, страница-открыватель на месте.
    await inGuest(electronApp, page.id, `document.getElementById('blank').click(); true`);
    const pdfUrl = `${origin}/doc-3p.pdf`;
    await expect.poll(async () => (await guests(electronApp)).filter((guest) => guest.url === pdfUrl).length).toBe(1);
    const popup = await guestAt(electronApp, pdfUrl);
    expect(popup?.id).not.toBe(page.id);
    await expect.poll(async () => hasViewer(await guestAt(electronApp, pdfUrl)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);
    expect((await guestAt(electronApp, `${origin}/`))?.id).toBe(page.id);
    // Снимок — только у видимой вкладки: у скрытой `capturePage` падает.
    await expect.poll(() => paintedColors(electronApp, popup?.id ?? -1), { timeout: 20_000 }).toBeGreaterThan(8);

    // 302 на PDF: закрыли вкладку-попап, в первой переход кончается тем же просмотрщиком.
    await menu(electronApp, 'tab.close');
    await expect.poll(async () => (await guests(electronApp)).some((guest) => guest.url === pdfUrl)).toBe(false);
    await inGuest(electronApp, page.id, `document.getElementById('redirect').click(); true`);
    const docUrl = `${origin}/doc.pdf`;
    await expect.poll(async () => hasViewer(await guestAt(electronApp, docUrl)), { timeout: 20_000 }).toBe(true);
    expect((await guestAt(electronApp, docUrl))?.id).toBe(page.id);
    await expectAlive(electronApp);
    await expect.poll(() => paintedColors(electronApp, page.id), { timeout: 20_000 }).toBeGreaterThan(8);
  });

  test('страница с <embed src=doc.pdf>: просмотрщик встроен подкадром, Parley жив', async () => {
    const window = await launch();
    const electronApp = app as ElectronApplication;
    const page = await openPage(window, `${origin}/embed`);
    await expect.poll(async () => hasViewer(await guestAt(electronApp, `${origin}/embed`)), { timeout: 20_000 }).toBe(true);
    await expectAlive(electronApp);
    await expect.poll(() => paintedColors(electronApp, page.id), { timeout: 20_000 }).toBeGreaterThan(8);
    expect(await inGuest<string>(electronApp, page.id, 'document.title')).toBe('Embed');
  });

  test('страница сама встраивает просмотрщик или file: подкадром: подкадр не грузится, Parley жив, страницы работают', async () => {
    const window = await launch();
    const electronApp = app as ElectronApplication;
    const viewerPage = `${origin}/viewer-iframe`;
    const filePage = `${origin}/file-iframe`;
    await insertWebview(window, viewerPage);
    await insertWebview(window, filePage);
    await expect.poll(async () => (await guests(electronApp)).length).toBe(2);
    // Отказ Chromium (ресурсы расширения не web-accessible) и страж (`file:`) приходят асинхронно: ждём, а не сверяем сразу.
    await window.waitForTimeout(2000);

    for (const url of [viewerPage, filePage]) {
      const guest = await guestAt(electronApp, url);
      expect(guest, url).toBeDefined();
      expect(hasViewer(guest), url).toBe(false);
      expect(guest?.frames.some((frame) => frame.startsWith('file:')), url).toBe(false);
      expect(await inGuest<string>(electronApp, guest?.id ?? -1, 'document.title')).toBeTruthy();
    }
    await expectAlive(electronApp);
  });

  test('повреждённый PDF и 404: ошибка остаётся в самой странице, Parley жив, вкладки работают', async () => {
    const window = await launch();
    const electronApp = app as ElectronApplication;

    // Битый PDF открывает просмотрщик (ошибку рисует он сам): не падение окна и не заглушка Parley.
    const broken = await openPage(window, `${origin}/broken.pdf`);
    await expect.poll(async () => hasViewer(await guestAt(electronApp, broken.url)), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => paintedColors(electronApp, broken.id), { timeout: 20_000 }).toBeGreaterThan(1);
    await expect(window.getByTestId('browser-crashed')).toHaveCount(0);
    await expect(window.getByTestId('browser-load-failed')).toHaveCount(0);
    await expectAlive(electronApp);

    // 404 на «.pdf»: страница ошибки сервера как есть, без просмотрщика.
    const missing = await openPage(window, `${origin}/missing.pdf`);
    await expect.poll(() => inGuest<string>(electronApp, missing.id, 'document.title')).toBe('Not found');
    expect(hasViewer(await guestAt(electronApp, missing.url))).toBe(false);
    await expect(window.getByTestId('browser-crashed')).toHaveCount(0);
    await expectAlive(electronApp);

    // После обоих окно по-прежнему открывает обычную страницу.
    const plain = await openPage(window, `${origin}/plain`);
    await expect.poll(() => inGuest<string>(electronApp, plain.id, 'document.title')).toBe('Plain neighbor');
  });
});
