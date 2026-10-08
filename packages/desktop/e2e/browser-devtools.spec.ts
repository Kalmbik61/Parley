import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Консоль, сеть и размеры вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, раздел 10: E2E 1, 5, 7).
 * - Страница своего сервера пишет в консоль, бросает исключение и отказ промиса, ходит за 500 с JSON (POST с телом),
 *   за 404 и на чужой origin без CORS: панель показывает всё это, счётчики верны, тело 500 читается, тело запроса — во
 *   вкладке Payload; ⌘⌥I и ⌘⌥J работают из страницы. Стиль и картинка из HTML видны в сети с первой загрузки, без
 *   перезагрузки; «назад» после неё неактивна (спайк 0.1, вариант D).
 * - Mobile M даёт странице `innerWidth` 375 и переживает перезапуск окна.
 * - 800×500 при DPR 1 и 2 с длинными адресом, работой и сессией: строка, панель (Console с длинным сообщением, Network
 *   с деталями, низкая панель в 120 px), меню размеров и Mobile M при открытой панели не вылезают за края; ручка
 *   панели тянется мышью поверх настоящего `<webview>` и не оставляет оверлей.
 * Внешних сайтов нет — два своих сервера на 127.0.0.1 (второй — «чужой origin» для CORS). Настоящий `claude` не
 * запускается. Ввод в гостя — `sendInputEvent` main, как в `browser-page.spec.ts`. Снимки — `test-results/browser-devtools/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/browser-devtools');
/** Название работы и ярлык сессии — по 60 символов (Фокус ревью 2). */
const LONG_TITLE = `devtools-workspace-${'w'.repeat(41)}`;
const LONG_LABEL = `devtools-session-${'s'.repeat(43)}`;
/** Высота панели не ниже этого (`DEVTOOLS_PANEL.minHeight`). */
const PANEL_MIN_PX = 120;

/**
 * Страница: консоль всех уровней, исключение, отказ промиса, 500 (POST с телом), 404 и CORS; значок — data:, без лишнего
 * запроса. Стиль и картинка из HTML (оба 200, счётчик ошибок не меняют) проверяют подресурсы первой загрузки (спайк 0.1).
 * `meta viewport` — как у любой мобильной вёрстки: в эмуляции `mobile` без него Chromium берёт ширину раскладки 980, а не
 * 375 (спайк 0.5, первая версия без метки). Длинная страница (`/long/…`) пишет ещё и сообщение в 300 знаков без пробелов: строка консоли обязана его перенести.
 */
function devtoolsPage(corsOrigin: string, long: boolean): string {
  return `<!doctype html><title>Devtools page</title><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css">
<script>
  console.log('hello', { theme: 'dark', items: [1, 2] });
  console.warn('careful');
  console.error(new Error('broken'));
  ${long ? "console.log('x'.repeat(300));" : ''}
  setTimeout(() => { throw new Error('boom'); }, 0);
  Promise.reject(new Error('nope'));
  fetch('/api/fail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }).catch(() => {});
  fetch('/missing').catch(() => {});
  fetch('${corsOrigin}/data').catch(() => {});
</script>
<img src="/logo.svg" alt="" width="1" height="1"><p>devtools page</p>`;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
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

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

/** JS в мире страницы гостя — только у теста: окну и агенту этого не дано. */
async function guestEval<T>(app: ElectronApplication, prefix: string, code: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [p, c]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL().startsWith(p));
      return guest === undefined ? null : ((await guest.executeJavaScript(c)) as unknown);
    },
    [prefix, code] as const,
  ) as Promise<T | null>;
}

/** Нажатие в гостя — как его увидел бы before-input-event от человека. */
async function pressInGuest(app: ElectronApplication, prefix: string, keyCode: string, modifiers: Array<'meta' | 'alt'>): Promise<void> {
  await app.evaluate(
    ({ webContents }, [p, k, m]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL().startsWith(p as string));
      const mods = m as Array<'meta' | 'alt'>;
      guest?.sendInputEvent({ type: 'keyDown', keyCode: k as string, modifiers: mods });
      guest?.sendInputEvent({ type: 'keyUp', keyCode: k as string, modifiers: mods });
    },
    [prefix, keyCode, modifiers] as const,
  );
}

/** Строка вкладки: ничто из её кнопок и полей не вылезает за её края, прокрутки вбок нет. */
async function chromeLayout(window: Page): Promise<{ viewportWidth: number; chromeRight: number; chromeOverflow: number; outside: Array<string | null> }> {
  return window.evaluate(() => {
    const chrome = document.querySelector('[data-testid="browser-chrome"]');
    if (chrome === null) throw new Error('нет строки вкладки');
    const chromeBox = chrome.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      chromeRight: chromeBox.right,
      chromeOverflow: chrome.scrollWidth - chrome.clientWidth,
      outside: [...chrome.querySelectorAll('button, input')]
        .filter((node) => node.getBoundingClientRect().right > chromeBox.right + 0.5 || node.getBoundingClientRect().left < chromeBox.left - 0.5)
        .map((node) => node.getAttribute('aria-label')),
    };
  });
}

/** Панель: сама не прокручивается вбок, правый край не за краем окна; ручка — под курсором, а не под соседом. */
async function panelLayout(
  window: Page,
): Promise<{ overflow: number; right: number; viewportWidth: number; height: number; handleHit: boolean; hitNode: string }> {
  return window.evaluate(() => {
    const panelNode = document.querySelector('[data-testid="devtools-panel"]');
    const handle = document.querySelector('[role="separator"][aria-label="Resize panel"]');
    if (panelNode === null || handle === null) throw new Error('нет панели или её ручки');
    const handleBox = handle.getBoundingClientRect();
    const hit = document.elementFromPoint(handleBox.left + handleBox.width / 2, handleBox.top + handleBox.height / 2);
    return {
      overflow: panelNode.scrollWidth - panelNode.clientWidth,
      right: panelNode.getBoundingClientRect().right,
      viewportWidth: document.documentElement.clientWidth,
      height: panelNode.getBoundingClientRect().height,
      handleHit: hit !== null && (hit === handle || handle.contains(hit)),
      // Кто оказался под курсором вместо ручки — для сообщения проверки.
      hitNode: hit === null ? 'null' : `${hit.tagName.toLowerCase()}[${hit.getAttribute('data-testid') ?? hit.getAttribute('role') ?? hit.className.toString().slice(0, 60)}]`,
    };
  });
}

/** Тянет ручку панели мышью окна на `delta` px (минус — вверх) шагами; время каждого шага, мс. */
async function dragHandle(window: Page, delta: number, steps: number): Promise<number[]> {
  const box = await window.getByRole('separator', { name: 'Resize panel' }).boundingBox();
  if (box === null) throw new Error('ручки нет на экране');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  const times: number[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const started = performance.now();
    await window.mouse.move(x, y + (delta * step) / steps);
    times.push(Math.round(performance.now() - started));
  }
  await window.mouse.up();
  return times;
}

async function heightOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('узла нет на экране');
  return box.height;
}

test.describe('консоль, сеть и размеры вкладки браузера (этап A)', () => {
  test.setTimeout(120_000);
  let home: string;
  let project: string;
  let server: Server;
  let cors: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-devtools');
    project = await makeTempProject('browser-devtools');
    // «Чужой origin»: ответ без Access-Control-Allow-Origin — fetch со страницы падает по CORS.
    cors = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const corsOrigin = await listen(cors);
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/api/fail') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"db down"}');
        return;
      }
      if (pathname === '/' || pathname.startsWith('/long/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(devtoolsPage(corsOrigin, pathname !== '/'));
        return;
      }
      if (pathname === '/app.css') {
        res.writeHead(200, { 'content-type': 'text/css' }).end('body { margin: 0; }');
        return;
      }
      if (pathname === '/logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    });
    origin = await listen(server);
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => cors.close(() => resolve()));
  });

  async function launch(extraArgs: string[] = []): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry, ...extraArgs], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    return { electronApp, window };
  }

  async function setSize(electronApp: ElectronApplication, width: number, height: number): Promise<void> {
    await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
  }

  /** Работа с сессией; клик по строке сессии делает работу активной. */
  async function openWork(window: Page, title: string, label: string): Promise<void> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label,
      task: '',
      parent: null,
    });
    await window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${created.ref.sessionId}"]`).click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${created.ref.sessionId}"]`)).toBeVisible();
  }

  async function openPage(electronApp: ElectronApplication, window: Page, url: string): Promise<void> {
    await menu(electronApp, 'browser.newTab');
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(url);
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp)).toEqual([url]);
  }

  test('панель: консоль, исключения, 500, 404 и CORS; счётчики 6 и 1; тело 500 и тело запроса; подресурсы первой загрузки; ⌘⌥I и ⌘⌥J из страницы (E2E 1)', async () => {
    const { electronApp, window } = await launch();
    await setSize(electronApp, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    await openWork(window, 'e2e-devtools', 'agent');
    // Без перезагрузки (спайк 0.1, вариант D): гость стартует с about:blank, страница открывается после включения журнала.
    await openPage(electronApp, window, `${origin}/`);

    // Красный — console.error, исключение, отказ промиса, 500, 404 и CORS; жёлтый — console.warn (Фокус ревью 3).
    await expect(window.getByTestId('devtools-errors')).toHaveText('6');
    await expect(window.getByTestId('devtools-warnings')).toHaveText('1');
    // Пустая страница не осталась в истории (Фокус ревью 6): «назад» после первой загрузки неактивна.
    await expect(window.getByTestId('browser-chrome').getByRole('button', { name: 'Back' })).toBeDisabled();

    // ⌘⌥I из страницы — панель, ещё раз — спрятана; ⌘⌥J — сразу на Console.
    const panel = window.getByTestId('devtools-panel');
    await pressInGuest(electronApp, `${origin}/`, 'I', ['meta', 'alt']);
    await expect(panel).toBeVisible();
    await pressInGuest(electronApp, `${origin}/`, 'I', ['meta', 'alt']);
    await expect(panel).toHaveCount(0);
    await pressInGuest(electronApp, `${origin}/`, 'J', ['meta', 'alt']);
    await expect(panel.getByRole('tab', { name: 'Console' })).toHaveAttribute('data-state', 'active');

    const message = (text: string) => panel.locator('[data-console-row]', { hasText: text });
    await expect(message("hello {theme: 'dark', items: Array(2)}")).toHaveAttribute('data-level', 'info');
    await expect(message('careful')).toHaveAttribute('data-level', 'warning');
    await expect(message('Error: broken')).toHaveAttribute('data-level', 'error');
    await expect(message('Uncaught Error: boom')).toBeVisible();
    await expect(message('Uncaught (in promise) Error: nope')).toBeVisible();

    await panel.getByRole('tab', { name: 'Network' }).click();
    const request = (text: string) => panel.locator('[data-network-row]', { hasText: text });
    await expect(request('/api/fail')).toContainText('500');
    await expect(request('/missing')).toContainText('404');
    await expect(request('/data')).toContainText('CORS');
    // Подресурсы первой загрузки (Фокус ревью 6): стиль и картинка из HTML видны без перезагрузки, захват не поздний.
    await expect(request('/app.css')).toContainText('200');
    await expect(request('/logo.svg')).toContainText('200');
    await expect(panel.getByRole('status')).toHaveCount(0);
    await request('/api/fail').click();
    // Тело запроса (F2, `maxPostDataSize`): POST с JSON доходит до вкладки Payload.
    await panel.getByRole('tab', { name: 'Payload' }).click();
    await expect(panel.getByTestId('request-body')).toContainText('"a": 1');
    await panel.getByRole('tab', { name: 'Response' }).click();
    await expect(panel.getByTestId('response-body')).toContainText('"error": "db down"');
  });

  test('Mobile M: в странице innerWidth 375 и подпись размера; размер переживает перезапуск окна (E2E 5)', async () => {
    let { electronApp, window } = await launch();
    await setSize(electronApp, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    await openWork(window, 'e2e-viewport', 'agent');
    await openPage(electronApp, window, `${origin}/`);
    await window.getByRole('button', { name: 'Viewport size' }).click();
    await window.getByRole('menuitemradio', { name: /Mobile M/ }).click();
    await expect.poll(() => guestEval<number>(electronApp, `${origin}/`, 'innerWidth')).toBe(375);
    await expect(window.getByTestId('viewport-label')).toContainText('375 × 812 · 2x');

    // Раскладка пишется с тишиной в 500 мс (как в layout.spec.ts): окно закрывается, когда размер уже на диске.
    const layouts = path.join(home, 'desktop', 'layouts.json');
    await expect.poll(async () => (await readFile(layouts, 'utf8').catch(() => '')).includes('"mobile-m"'), { timeout: 10_000 }).toBe(true);
    await quitApp(electronApp);
    app = null;
    ({ electronApp, window } = await launch());
    await setSize(electronApp, 1400, 900);
    await expect.poll(() => guestEval<number>(electronApp, `${origin}/`, 'innerWidth'), { timeout: 30_000 }).toBe(375);
    await expect(window.getByTestId('viewport-label')).toContainText('375 × 812 · 2x');
    // Вариант D: пустая страница уже эмулирована, а адрес открывается после этого — подсказка «Reload to apply touch»
    // у восстановленной вкладки ложная (ревью задачи 16, п. 3).
    await expect(window.getByTestId('viewport-label').getByRole('button', { name: 'Reload to apply touch' })).toHaveCount(0);
  });

  for (const dpr of [1, 2]) {
    test(`800×500 при DPR ${dpr}: адрес 300 знаков, работа и сессия по 60 — строка, панель, меню размеров и Mobile M в пределах; ручка тянется поверх страницы (E2E 7; Фокус ревью 2)`, async () => {
      const { electronApp, window } = await launch([`--force-device-scale-factor=${dpr}`]);
      await setSize(electronApp, 800, 500);
      await expect(window.getByTestId('landing')).toBeVisible();
      expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(dpr);
      await openWork(window, LONG_TITLE, LONG_LABEL);
      const prefix = `${origin}/long/`;
      const pageUrl = prefix + 'a'.repeat(300 - prefix.length);
      await openPage(electronApp, window, pageUrl);
      // Как в E2E 1: без перезагрузки, журнал первой загрузки полный.
      await expect(window.getByTestId('devtools-errors')).toHaveText('6');

      await test.step('меню размеров помещается в окно 800×500 (ревью задачи 14)', async () => {
        await window.getByRole('button', { name: 'Viewport size' }).click();
        const last = window.getByRole('menuitemradio', { name: '3x' });
        await expect(last).toBeVisible();
        const box = await last.boundingBox();
        const menuBox = await window.getByRole('menu').boundingBox();
        const innerHeight = await window.evaluate(() => globalThis.innerHeight);
        expect(box).not.toBeNull();
        expect(menuBox).not.toBeNull();
        const itemBottom = (box?.y ?? 0) + (box?.height ?? 0);
        // Последний пункт и целиком в окне, и внутри самого меню (не выкачен из прокручиваемого списка).
        expect(itemBottom).toBeLessThanOrEqual(innerHeight);
        expect(itemBottom).toBeLessThanOrEqual((menuBox?.y ?? 0) + (menuBox?.height ?? 0) + 0.5);
        expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(innerHeight);
        await window.keyboard.press('Escape');
        await expect(last).toHaveCount(0);
      });

      const panel = window.getByTestId('devtools-panel');
      await window.getByRole('button', { name: 'Console and network' }).click();
      await expect(panel).toBeVisible();

      await test.step('Network: детали запроса рядом со строкой и панелью в пределах', async () => {
        await panel.getByRole('tab', { name: 'Network' }).click();
        await panel.locator('[data-network-row]', { hasText: '/api/fail' }).click();
        await expect(panel.getByTestId('request-details')).toBeVisible();

        const layout = await window.evaluate(() => {
          const chrome = document.querySelector('[data-testid="browser-chrome"]');
          const panelNode = document.querySelector('[data-testid="devtools-panel"]');
          const details = document.querySelector('[data-testid="request-details"]');
          if (chrome === null || panelNode === null || details === null) throw new Error('нет строки, панели или деталей');
          return {
            panelRight: panelNode.getBoundingClientRect().right,
            detailsRight: details.getBoundingClientRect().right,
            detailsWidth: details.getBoundingClientRect().width,
          };
        });
        const chromeBox = await chromeLayout(window);
        const panelBox = await panelLayout(window);
        expect(chromeBox.chromeOverflow).toBeLessThanOrEqual(0);
        expect(chromeBox.outside).toEqual([]);
        expect(chromeBox.chromeRight).toBeLessThanOrEqual(chromeBox.viewportWidth);
        expect(panelBox.overflow).toBeLessThanOrEqual(0);
        expect(layout.detailsRight).toBeLessThanOrEqual(layout.panelRight + 0.5);
        expect(layout.detailsWidth).toBeGreaterThan(200);
        await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}.png`), animations: 'disabled' });
      });

      await test.step('Console: сообщение в 300 знаков без пробелов переносится, вбок ничего не прокручивается', async () => {
        await panel.getByRole('tab', { name: 'Console' }).click();
        const longRow = panel.locator('[data-console-row]', { hasText: 'x'.repeat(300) });
        await expect(longRow).toBeVisible();
        // Список прилип к низу (там строка CORS): длинную строку подводим в поле зрения — для снимка и честной проверки.
        await longRow.scrollIntoViewIfNeeded();
        const list = await window.evaluate(() => {
          const log = document.querySelector('[data-testid="devtools-panel"] [role="log"]');
          const view = document.querySelector('[data-testid="console-view"]');
          if (log === null || view === null) throw new Error('нет списка консоли');
          return { logOverflow: log.scrollWidth - log.clientWidth, viewOverflow: view.scrollWidth - view.clientWidth };
        });
        expect(list.logOverflow).toBeLessThanOrEqual(0);
        expect(list.viewOverflow).toBeLessThanOrEqual(0);
        expect((await panelLayout(window)).overflow).toBeLessThanOrEqual(0);
        await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}-console.png`), animations: 'disabled' });
      });

      await test.step('низкая панель: 120 px, вбок не прокручивается, ручку можно схватить (ревью задачи 13)', async () => {
        const before = await heightOf(panel);
        await dragHandle(window, 600, 6);
        await expect(window.getByTestId('resize-overlay')).toHaveCount(0);
        expect(await heightOf(panel)).toBeLessThan(before);
        expect(await heightOf(panel)).toBeCloseTo(PANEL_MIN_PX, 0);
        for (const view of ['Console', 'Network']) {
          await panel.getByRole('tab', { name: view }).click();
          const layout = await panelLayout(window);
          expect(layout.overflow, `${view}: прокрутка вбок`).toBeLessThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
          expect(layout.handleHit, `${view}: ручка под курсором, а там ${layout.hitNode}`).toBe(true);
        }
        await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}-short.png`), animations: 'disabled' });
      });

      await test.step('Mobile M при открытой панели: строка и панель в пределах', async () => {
        await window.getByRole('button', { name: 'Viewport size' }).click();
        await window.getByRole('menuitemradio', { name: /Mobile M/ }).click();
        // Меню закрывается с анимацией: пока его пункты в DOM, они стоят над ручкой.
        await expect(window.getByRole('menu')).toHaveCount(0);
        await expect(window.getByTestId('viewport-label')).toContainText('375 × 812');
        await expect.poll(() => guestEval<number>(electronApp, `${origin}/long/`, 'innerWidth')).toBe(375);
        const chromeBox = await chromeLayout(window);
        const panelBox = await panelLayout(window);
        expect(chromeBox.chromeOverflow).toBeLessThanOrEqual(0);
        expect(chromeBox.outside).toEqual([]);
        expect(chromeBox.chromeRight).toBeLessThanOrEqual(chromeBox.viewportWidth);
        expect(panelBox.overflow).toBeLessThanOrEqual(0);
        expect(panelBox.right).toBeLessThanOrEqual(panelBox.viewportWidth);
        expect(panelBox.handleHit, `ручка под курсором, а там ${panelBox.hitNode}`).toBe(true);
        await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}-mobile.png`), animations: 'disabled' });
      });

      await test.step('ручка тянется мышью поверх настоящего <webview> Mobile M-вкладки, оверлей уходит (ревью задачи 16)', async () => {
        const before = await heightOf(panel);
        const times = await dragHandle(window, -80, 8);
        await expect(window.getByTestId('resize-overlay')).toHaveCount(0);
        const after = await heightOf(panel);
        expect(after - before).toBeGreaterThanOrEqual(70);
        expect(after - before).toBeLessThanOrEqual(90);
        const total = times.reduce((sum, ms) => sum + ms, 0);
        const line = `DPR ${dpr}: перетаскивание на Mobile M, ${times.length} шагов, мс на шаг [${times.join(', ')}], всего ${total}, высота ${Math.round(before)} → ${Math.round(after)}`;
        console.log(line);
        test.info().annotations.push({ type: 'drag-ms', description: line });
        expect(Math.abs((await panelLayout(window)).height - after)).toBeLessThan(1);
        // Высота ушла в ui.json (тишина записи — сотни миллисекунд): перетаскивание закончилось записью, а не потерей.
        const uiFile = path.join(home, 'desktop', 'ui.json');
        await expect
          .poll(async () => {
            try {
              return (JSON.parse(await readFile(uiFile, 'utf8')) as { browser?: { devtoolsHeight?: number | null } }).browser?.devtoolsHeight ?? -1;
            } catch {
              return -1;
            }
          })
          .toBeCloseTo(after, 0);
        await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}-dragged.png`), animations: 'disabled' });
      });
    });
  }
});
