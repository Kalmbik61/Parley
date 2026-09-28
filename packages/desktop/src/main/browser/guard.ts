/**
 * Клетка встроенного браузера (кусок 9.1, спека 12.2): страницы из сети живут без Node, без
 * preload, без разрешений, без окон и без доступа к диску.
 *
 * Два входа, и порядок их установки важен:
 * - `guardWebviewAttach` вешает `createMainWindow` на своё окно до `loadFile` — страж рядом с
 *   регистрацией IPC опоздал бы к первому `<webview>`, и тот прикрепился бы с `preload` или
 *   `nodeintegration` из атрибутов;
 * - `installBrowserGuard` ставится внутри `whenReady` до первого окна: `session.fromPartition`
 *   до `ready` бросает, а `web-contents-created` окна приходит внутри `new BrowserWindow`.
 */
import path from 'node:path';
import type { App, DownloadItem, Session, WebContents, WebPreferences } from 'electron';
import { BROWSER_PARTITION, type BrowserOpenTab } from '../../shared/browser-types.js';

export type NavVerdict = 'allow' | 'deny';

/**
 * Главный фрейм: только http, https и about:blank. Подфрейм: ещё about:srcdoc, data: и blob: —
 * у них непрозрачное или своё происхождение, к диску доступа нет. file:, javascript:,
 * chrome: и прочее — deny везде.
 */
export function navigationVerdict(url: string, frame: 'main' | 'sub'): NavVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
      return 'allow';
    case 'about:':
      if (parsed.pathname === 'blank') return 'allow';
      return parsed.pathname === 'srcdoc' && frame === 'sub' ? 'allow' : 'deny';
    case 'data:':
    case 'blob:':
      return frame === 'sub' ? 'allow' : 'deny';
    default:
      return 'deny';
  }
}

function isHttpUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Правка webPreferences на will-attach-webview; false — подключение запрещено. Тип — интерфейс Electron:
 * без индексной сигнатуры он в Record<string, unknown> не присваивается, а preloadURL в нём нет.
 */
export function sanitizeWebviewAttach(
  webPreferences: WebPreferences & { preloadURL?: string },
  params: { partition?: string; src?: string },
): boolean {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  // Атрибут `webpreferences` мог включить и то, чего в списке ниже нет, — снимаем явно.
  delete webPreferences.enableBlinkFeatures;
  delete webPreferences.experimentalFeatures;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  // Иначе alert, confirm и prompt любой страницы шли бы нативным диалогом от имени приложения.
  webPreferences.disableDialogs = true;
  // Пустого src не бывает: <webview> монтируется только с адресом http(s) (9.2a).
  return params.partition === BROWSER_PARTITION && isHttpUrl(params.src);
}

/** will-attach-webview главного окна: createMainWindow зовёт до loadFile. */
export function guardWebviewAttach(contents: Pick<WebContents, 'on'>): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!sanitizeWebviewAttach(webPreferences, params)) event.preventDefault();
  });
}

/** Обработчики гостя `<webview>`: окна, навигация, масштаб, уход со страницы, клавиши. */
function guardGuest(contents: WebContents, deps: Pick<BrowserGuardDeps, 'openTab' | 'forwardShortcuts'>): void {
  contents.setWindowOpenHandler(({ url }) => {
    // about:blank вкладки не открывает: <webview> с таким src не прикрепится ни сразу, ни после перезапуска.
    if (isHttpUrl(url) && navigationVerdict(url, 'main') === 'allow') {
      deps.openTab({ url, openerWebContentsId: contents.id });
    }
    return { action: 'deny' };
  });

  const checkNavigation = (details: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
    if (navigationVerdict(details.url, details.isMainFrame ? 'main' : 'sub') === 'deny') details.preventDefault();
  };
  contents.on('will-navigate', checkNavigation);
  contents.on('will-redirect', checkNavigation);
  contents.on('will-frame-navigate', checkNavigation);
  // Программная навигация (`src`, `loadURL`) will-navigate не вызывает — её останавливает stop().
  contents.on('did-start-navigation', (details) => {
    if (navigationVerdict(details.url, details.isMainFrame ? 'main' : 'sub') === 'deny') contents.stop();
  });

  // Иначе масштаб общий на origin и живёт дольше вкладки, вопреки спеке 12.4.
  contents.setZoomMode('isolated');
  // Иначе beforeunload страницы молча держит её при закрытии вкладки и переходе.
  contents.on('will-prevent-unload', (event) => event.preventDefault());
  // Слушатель клавиш снимается вместе с гостем, а не ждёт сборки мусора.
  contents.once('destroyed', deps.forwardShortcuts(contents));
}

interface BrowserGuardDeps {
  app: Pick<App, 'on'>; // web-contents-created, select-client-certificate
  /** Спрашивается в момент will-attach-webview, а не в web-contents-created (ниже). */
  isMainWindow(contents: WebContents): boolean;
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'on'>; // раздел BROWSER_PARTITION
  openTab(e: BrowserOpenTab): void; // → окну-хозяину открывателя, событие browser:open-tab
  forwardShortcuts(contents: WebContents): () => void; // адаптер к forwardGuestShortcuts (6.1a), вернёт отписку
  /** will-download раздела, синхронно: путь загрузки задаётся только внутри события. promptDownload или подмена E2E. */
  download(item: DownloadItem): void;
}

/**
 * Загрузка страницы — только туда, куда укажет человек стандартным диалогом сохранения (спека 12.2).
 * Путь не ставится: без setSavePath Electron 44 сам показывает диалог, а отмена в нём отменяет
 * загрузку. Задаётся лишь папка по умолчанию — базовое имя, чтобы имя из сети не увело из неё.
 */
export function promptDownload(item: Pick<DownloadItem, 'getFilename' | 'setSaveDialogOptions'>, downloadsDir: string): void {
  item.setSaveDialogOptions({ defaultPath: path.join(downloadsDir, path.basename(item.getFilename())) });
}

/**
 * Сессии, на которые страж уже поставлен. Обработчики app копятся (`on`, не сеттер): второй вызов
 * навесил бы второй набор, и одно нажатие в госте приходило бы окну дважды (ревью 9.1).
 */
const guardedSessions = new WeakSet<object>();

/** Один раз на сессию раздела; повторный вызов с той же сессией ничего не делает. */
export function installBrowserGuard(deps: BrowserGuardDeps): void {
  if (guardedSessions.has(deps.session)) return;
  guardedSessions.add(deps.session);
  deps.app.on('web-contents-created', (_event, contents) => {
    // «Главное окно или нет» — в момент события: web-contents-created окна приходит внутри
    // new BrowserWindow(...), до присвоения mainWindow. Проверка здесь отнесла бы окно к «другим»,
    // и ни один <webview> не прикрепился бы. Главное окно стережёт guardWebviewAttach.
    contents.on('will-attach-webview', (event) => {
      if (!deps.isMainWindow(contents)) event.preventDefault();
    });
    if (contents.getType() === 'webview') guardGuest(contents, deps);
  });

  // Камера, микрофон, геолокация, уведомления, буфер обмена и прочее — отказ.
  deps.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  deps.session.setPermissionCheckHandler(() => false);
  deps.session.on('will-download', (_event, item) => deps.download(item));

  // Событие app, а не разрешение: обработчики сессии его не видят. Без preventDefault Electron
  // отдал бы сайту с mTLS первый сертификат из хранилища — личность человека без вопроса.
  deps.app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
}
