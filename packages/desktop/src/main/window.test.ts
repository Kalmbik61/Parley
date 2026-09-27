import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { createMainWindow, guardNavigation, mainWindowOptions, titlebarDoubleClickAction } from './window.js';

/**
 * Подставной `BrowserWindow` (тест 7 куска 9.1): `createMainWindow` берёт его из `electron` сам,
 * и порядок «подписка will-attach-webview → loadFile» виден только в общем журнале вызовов.
 */
const electronLog = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => {
  class BrowserWindow {
    webContents = {
      on: (event: string) => {
        electronLog.push(`on:${event}`);
      },
      setWindowOpenHandler: () => {
        electronLog.push('setWindowOpenHandler');
      },
    };
    loadFile(): Promise<void> {
      electronLog.push('loadFile');
      return Promise.resolve();
    }
  }
  return { BrowserWindow };
});

describe('mainWindowOptions', () => {
  it('тёмная тема: hiddenInset, светофор, минимальный размер, песочница (тест 1)', () => {
    const options = mainWindowOptions({ dark: true, preloadPath: '/tmp/preload.js' });

    expect(options.titleBarStyle).toBe('hiddenInset');
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 12 });
    expect(options.minWidth).toBe(800);
    expect(options.minHeight).toBe(500);
    expect(options.backgroundColor).toBe('#0a0a0a');
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.preload).toBe('/tmp/preload.js');
    // Встроенный браузер (кусок 9.1, спека 12.2): `<webview>` в окне включён, его стережёт
    // `guardWebviewAttach` (тест 6 куска 9.1).
    expect(options.webPreferences?.webviewTag).toBe(true);
  });

  it('светлая тема: белый фон', () => {
    const options = mainWindowOptions({ dark: false, preloadPath: '/tmp/preload.js' });
    expect(options.backgroundColor).toBe('#ffffff');
  });
});

/** Подставной `webContents`: `guardNavigation` трогает только `on` и `setWindowOpenHandler`. */
function fakeWebContents(): {
  webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>;
  triggerWillNavigate: (url: string) => { defaultPrevented: boolean };
  openHandler: () => { action: string };
} {
  let willNavigateListener: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
  let windowOpenHandler: (() => { action: 'allow' | 'deny' }) | null = null;

  const webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'> = {
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === 'will-navigate') willNavigateListener = listener as never;
      return webContents as WebContents;
    }) as WebContents['on'],
    setWindowOpenHandler: ((handler: () => { action: 'allow' | 'deny' }) => {
      windowOpenHandler = handler;
    }) as WebContents['setWindowOpenHandler'],
  };

  return {
    webContents,
    triggerWillNavigate: (url: string) => {
      let defaultPrevented = false;
      willNavigateListener?.({ preventDefault: () => (defaultPrevented = true) }, url);
      return { defaultPrevented };
    },
    openHandler: () => {
      if (windowOpenHandler === null) throw new Error('setWindowOpenHandler не позвали');
      return windowOpenHandler();
    },
  };
}

describe('guardNavigation', () => {
  it('чужая навигация отменяется, своя — нет; window.open — deny (тест 2)', () => {
    const { webContents, triggerWillNavigate, openHandler } = fakeWebContents();
    const onSpy = vi.spyOn(webContents, 'on');

    guardNavigation(webContents, 'file:///app/index.html');

    expect(triggerWillNavigate('https://example.com').defaultPrevented).toBe(true);
    expect(triggerWillNavigate('file:///app/index.html').defaultPrevented).toBe(false);
    expect(openHandler()).toEqual({ action: 'deny' });
    expect(onSpy).toHaveBeenCalledWith('will-navigate', expect.any(Function));
  });
});

describe('createMainWindow (тест 7 куска 9.1)', () => {
  it('will-attach-webview подписан раньше вызова loadFile', () => {
    electronLog.length = 0;
    createMainWindow({ dark: false, preloadPath: '/tmp/preload.js', indexHtmlPath: '/app/index.html' });

    const attach = electronLog.indexOf('on:will-attach-webview');
    const load = electronLog.indexOf('loadFile');
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(attach);
  });
});

describe('titlebarDoubleClickAction (раунд исправлений 1, Minor A2)', () => {
  it('Maximize → maximize, Minimize → minimize, None/пустая строка/незнакомое значение → none', () => {
    expect(titlebarDoubleClickAction('Maximize')).toBe('maximize');
    expect(titlebarDoubleClickAction('Minimize')).toBe('minimize');
    expect(titlebarDoubleClickAction('None')).toBe('none');
    expect(titlebarDoubleClickAction('')).toBe('none');
    expect(titlebarDoubleClickAction('Something else')).toBe('none');
  });
});
