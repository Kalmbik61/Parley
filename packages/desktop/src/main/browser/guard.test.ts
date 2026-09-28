import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { App, WebContents, WebPreferences } from 'electron';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { guardWebviewAttach, installBrowserGuard, navigationVerdict, sanitizeWebviewAttach } from './guard.js';

describe('navigationVerdict (тест 2)', () => {
  it('http(s) и about:blank — везде; about:srcdoc, data:, blob: — только подфрейм; прочее — deny', () => {
    expect(navigationVerdict('https://x', 'main')).toBe('allow');
    expect(navigationVerdict('http://127.0.0.1:5173/', 'sub')).toBe('allow');
    expect(navigationVerdict('file:///etc/passwd', 'main')).toBe('deny');
    expect(navigationVerdict('file:///etc/passwd', 'sub')).toBe('deny');
    expect(navigationVerdict('about:blank', 'main')).toBe('allow');
    expect(navigationVerdict('about:blank', 'sub')).toBe('allow');
    expect(navigationVerdict('about:srcdoc', 'sub')).toBe('allow');
    expect(navigationVerdict('about:srcdoc', 'main')).toBe('deny');
    expect(navigationVerdict('data:text/html,<b>x</b>', 'main')).toBe('deny');
    expect(navigationVerdict('data:text/html,<b>x</b>', 'sub')).toBe('allow');
    expect(navigationVerdict('blob:https://x/1', 'sub')).toBe('allow');
    expect(navigationVerdict('blob:https://x/1', 'main')).toBe('deny');
    expect(navigationVerdict('javascript:x', 'main')).toBe('deny');
    expect(navigationVerdict('javascript:x', 'sub')).toBe('deny');
    expect(navigationVerdict('chrome://gpu', 'main')).toBe('deny');
    expect(navigationVerdict('chrome://gpu', 'sub')).toBe('deny');
    expect(navigationVerdict('not a url', 'sub')).toBe('deny');
  });
});

describe('sanitizeWebviewAttach (тест 3)', () => {
  const evil = (): WebPreferences & { preloadURL?: string } => ({
    preload: '/tmp/evil.js',
    preloadURL: 'file:///tmp/evil.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    webviewTag: true,
    disableDialogs: false,
    enableBlinkFeatures: 'Serial',
    experimentalFeatures: true,
  });

  it('вычищает preload и preloadURL, ставит флаги, снимает enableBlinkFeatures и experimentalFeatures', () => {
    const prefs = evil();
    expect(sanitizeWebviewAttach(prefs, { partition: BROWSER_PARTITION, src: 'http://127.0.0.1:5173/' })).toBe(true);
    expect(prefs).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      disableDialogs: true,
    });
  });

  it('чужой partition, без partition, src file:, пустой и не-http — false', () => {
    expect(sanitizeWebviewAttach(evil(), { partition: 'persist:other', src: 'https://x' })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { src: 'https://x' })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: 'file:///x' })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: '' })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: 'about:blank' })).toBe(false);
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: 'javascript:alert(1)' })).toBe(false);
  });
});

/** Событие Electron: `preventDefault` и признак для проверки. */
function fakeEvent<T extends object>(extra: T = {} as T): T & { preventDefault: () => void; defaultPrevented: boolean } {
  const event = {
    ...extra,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

/** Подставной webContents: EventEmitter плюс то, что трогает страж. */
function fakeContents(id: number, type: 'window' | 'webview' | 'remote') {
  const emitter = new EventEmitter();
  let openHandler: ((details: { url: string }) => { action: string }) | null = null;
  const contents = Object.assign(emitter, {
    id,
    getType: () => type,
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      openHandler = handler;
    }),
    setZoomMode: vi.fn(),
    stop: vi.fn(),
    openHandler: (url: string) => {
      if (openHandler === null) throw new Error('setWindowOpenHandler не позвали');
      return openHandler({ url });
    },
  });
  return contents;
}

function setupGuard(isMainWindow: (c: WebContents) => boolean = () => false) {
  const app = new EventEmitter();
  let requestHandler: ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void) | null = null;
  let checkHandler: ((...args: unknown[]) => boolean) | null = null;
  const session = {
    setPermissionRequestHandler: vi.fn((handler: typeof requestHandler) => {
      requestHandler = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: typeof checkHandler) => {
      checkHandler = handler;
    }),
  };
  const openTab = vi.fn();
  const unforward = vi.fn();
  const forwardShortcuts = vi.fn((): (() => void) => unforward);
  const isMain = vi.fn(isMainWindow);
  const install = (): void =>
    installBrowserGuard({
      app: app as unknown as Pick<App, 'on'>,
      isMainWindow: isMain,
      session: session as unknown as Parameters<typeof installBrowserGuard>[0]['session'],
      openTab,
      forwardShortcuts,
    });
  install();
  const created = (contents: ReturnType<typeof fakeContents>): void => {
    app.emit('web-contents-created', fakeEvent(), contents);
  };
  return {
    app,
    install,
    openTab,
    forwardShortcuts,
    unforward,
    isMain,
    created,
    requestHandler: () => requestHandler,
    checkHandler: () => checkHandler,
  };
}

describe('installBrowserGuard (тест 4)', () => {
  it('window.open гостя: https — deny и openTab с id гостя; file: и about:blank — deny без openTab', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);

    expect(guest.openHandler('https://x')).toEqual({ action: 'deny' });
    expect(guard.openTab).toHaveBeenCalledWith({ url: 'https://x', openerWebContentsId: 42 });

    guard.openTab.mockClear();
    expect(guest.openHandler('file:///etc/hosts')).toEqual({ action: 'deny' });
    expect(guest.openHandler('about:blank')).toEqual({ action: 'deny' });
    expect(guest.openHandler('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(guard.openTab).not.toHaveBeenCalled();
  });

  it('разрешения раздела: запрос — callback(false), проверка — false', () => {
    const guard = setupGuard();
    const callback = vi.fn();
    guard.requestHandler()?.({}, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(guard.checkHandler()?.({}, 'clipboard-read', 'https://x', {})).toBe(false);
  });

  it('will-attach-webview гостя и DevTools — preventDefault', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    const devtools = fakeContents(43, 'remote');
    guard.created(guest);
    guard.created(devtools);

    const fromGuest = fakeEvent();
    guest.emit('will-attach-webview', fromGuest, {}, { partition: BROWSER_PARTITION, src: 'https://x' });
    expect(fromGuest.defaultPrevented).toBe(true);

    const fromDevtools = fakeEvent();
    devtools.emit('will-attach-webview', fromDevtools, {}, { partition: BROWSER_PARTITION, src: 'https://x' });
    expect(fromDevtools.defaultPrevented).toBe(true);
  });

  it('навигация: will-frame-navigate подфрейма на file: и data: главного — preventDefault; https — нет', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);

    const subFile = fakeEvent({ url: 'file:///etc/hosts', isMainFrame: false });
    guest.emit('will-frame-navigate', subFile);
    expect(subFile.defaultPrevented).toBe(true);

    const subData = fakeEvent({ url: 'data:text/html,x', isMainFrame: false });
    guest.emit('will-frame-navigate', subData);
    expect(subData.defaultPrevented).toBe(false);

    const mainData = fakeEvent({ url: 'data:text/html,x', isMainFrame: true });
    guest.emit('will-navigate', mainData);
    expect(mainData.defaultPrevented).toBe(true);

    const redirect = fakeEvent({ url: 'file:///etc/hosts', isMainFrame: true });
    guest.emit('will-redirect', redirect);
    expect(redirect.defaultPrevented).toBe(true);

    const ok = fakeEvent({ url: 'https://x/next', isMainFrame: true });
    guest.emit('will-navigate', ok);
    expect(ok.defaultPrevented).toBe(false);
  });

  it('did-start-navigation на file: — stop(); на https — нет', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);

    guest.emit('did-start-navigation', fakeEvent({ url: 'https://x', isMainFrame: true }));
    expect(guest.stop).not.toHaveBeenCalled();
    guest.emit('did-start-navigation', fakeEvent({ url: 'file:///etc/hosts', isMainFrame: true }));
    expect(guest.stop).toHaveBeenCalledTimes(1);
  });

  it('гость: setZoomMode(isolated), will-prevent-unload — preventDefault, forwardShortcuts с ним', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);

    expect(guest.setZoomMode).toHaveBeenCalledWith('isolated');
    const unload = fakeEvent();
    guest.emit('will-prevent-unload', unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(guard.forwardShortcuts).toHaveBeenCalledWith(guest);
  });

  it('отписка forwardShortcuts — на destroyed гостя', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);
    expect(guard.unforward).not.toHaveBeenCalled();
    guest.emit('destroyed');
    expect(guard.unforward).toHaveBeenCalledTimes(1);
  });

  it('повторная установка на ту же сессию обработчиков app не добавляет (ревью 9.1)', () => {
    const guard = setupGuard();
    guard.install();
    guard.install();
    expect(guard.app.listenerCount('web-contents-created')).toBe(1);
    expect(guard.app.listenerCount('select-client-certificate')).toBe(1);

    const guest = fakeContents(42, 'webview');
    guard.created(guest);
    expect(guard.forwardShortcuts).toHaveBeenCalledTimes(1);
  });

  it('не-гость (окно, DevTools) обработчиков гостя не получает', () => {
    const guard = setupGuard();
    const devtools = fakeContents(43, 'remote');
    guard.created(devtools);
    expect(devtools.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(devtools.setZoomMode).not.toHaveBeenCalled();
    expect(guard.forwardShortcuts).not.toHaveBeenCalled();
  });

  it('select-client-certificate — preventDefault и callback() без сертификата', () => {
    const guard = setupGuard();
    const event = fakeEvent();
    const callback = vi.fn();
    guard.app.emit('select-client-certificate', event, null, 'https://mtls.example', [{ subjectName: 'me' }], callback);
    expect(event.defaultPrevented).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
  });
});

describe('главное окно решается в момент will-attach-webview (тест 5)', () => {
  it('web-contents-created — пока mainWindow не присвоен; затем webview окна прикрепляется', () => {
    let mainWindow: { webContents: unknown } | null = null;
    const guard = setupGuard((c) => c === mainWindow?.webContents);
    const windowContents = fakeContents(1, 'window');

    // Внутри new BrowserWindow(...): mainWindow ещё null.
    guard.created(windowContents);
    expect(guard.isMain.mock.results.every((r) => r.value === false)).toBe(true);
    // createMainWindow вешает свой страж до loadFile.
    guardWebviewAttach(windowContents as unknown as Pick<WebContents, 'on'>);
    mainWindow = { webContents: windowContents };

    const prefs: WebPreferences = { preload: '/tmp/evil.js' };
    const event = fakeEvent();
    windowContents.emit('will-attach-webview', event, prefs, { partition: BROWSER_PARTITION, src: 'http://127.0.0.1:5173' });
    expect(event.defaultPrevented).toBe(false);
    expect(prefs.preload).toBeUndefined();
    expect(prefs.webviewTag).toBe(false);
  });

  it('guardWebviewAttach: file: и чужой раздел — preventDefault', () => {
    const windowContents = fakeContents(1, 'window');
    guardWebviewAttach(windowContents as unknown as Pick<WebContents, 'on'>);

    const file = fakeEvent();
    windowContents.emit('will-attach-webview', file, {}, { partition: BROWSER_PARTITION, src: 'file:///etc/hosts' });
    expect(file.defaultPrevented).toBe(true);

    const other = fakeEvent();
    windowContents.emit('will-attach-webview', other, {}, { src: 'https://x' });
    expect(other.defaultPrevented).toBe(true);
  });
});
