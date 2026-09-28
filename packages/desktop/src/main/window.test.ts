import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { guardNavigation, guardWindowClose, mainWindowOptions, titlebarDoubleClickAction } from './window.js';

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
    // `webviewTag` — с этапа 9 (спека 5.1): пока не задан вовсе, а не `false`.
    expect(options.webPreferences?.webviewTag).toBeUndefined();
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

describe('titlebarDoubleClickAction (раунд исправлений 1, Minor A2)', () => {
  it('Maximize → maximize, Minimize → minimize, None/пустая строка/незнакомое значение → none', () => {
    expect(titlebarDoubleClickAction('Maximize')).toBe('maximize');
    expect(titlebarDoubleClickAction('Minimize')).toBe('minimize');
    expect(titlebarDoubleClickAction('None')).toBe('none');
    expect(titlebarDoubleClickAction('')).toBe('none');
    expect(titlebarDoubleClickAction('Something else')).toBe('none');
  });
});

/** Подставные окно и app для вопроса при закрытии (кусок 7.3a): настоящий BrowserWindow под vitest не поднять. */
function fakeCloseTargets() {
  const windowListeners: Array<(event: { preventDefault: () => void }) => void> = [];
  const quitListeners: Array<(event: { preventDefault: () => void }) => void> = [];
  const sent: string[] = [];
  let closed = 0;
  let quits = 0;
  const emit = (listeners: typeof windowListeners): boolean => {
    let prevented = false;
    for (const listener of [...listeners]) listener({ preventDefault: () => (prevented = true) });
    return prevented;
  };
  const window = {
    on: (_event: 'close', listener: (event: { preventDefault: () => void }) => void) => {
      windowListeners.push(listener);
    },
    close: () => {
      closed += 1;
      emit(windowListeners);
    },
    isDestroyed: () => false,
    webContents: { send: (channel: string) => sent.push(channel) },
  };
  const app = {
    on: (_event: 'before-quit', listener: (event: { preventDefault: () => void }) => void) => {
      quitListeners.push(listener);
    },
    removeListener: (_event: 'before-quit', listener: (event: { preventDefault: () => void }) => void) => {
      quitListeners.splice(quitListeners.indexOf(listener), 1);
    },
    quit: () => {
      quits += 1;
      emit(quitListeners);
    },
  };
  return {
    window,
    app,
    sent,
    closeWindow: () => emit(windowListeners),
    quitApp: () => emit(quitListeners),
    closed: () => closed,
    quits: () => quits,
    quitListenerCount: () => quitListeners.length,
  };
}

describe('guardWindowClose (тест 11 куска 7.3a)', () => {
  it('грязных буферов 0 — close без preventDefault и без вопроса', () => {
    const t = fakeCloseTargets();
    guardWindowClose(t.window, t.app);
    expect(t.closeWindow()).toBe(false);
    expect(t.quitApp()).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it('2 — preventDefault и app:confirm-close; повторный close до ответа второго вопроса не шлёт', () => {
    const t = fakeCloseTargets();
    const guard = guardWindowClose(t.window, t.app);
    guard.setDirtyCount(2);
    expect(t.closeWindow()).toBe(true);
    expect(t.closeWindow()).toBe(true);
    expect(t.sent).toEqual(['app:confirm-close']);
  });

  it('ответ close (Don\'t save или Save all без ошибок) — окно закрыто', () => {
    const t = fakeCloseTargets();
    const guard = guardWindowClose(t.window, t.app);
    guard.setDirtyCount(2);
    t.closeWindow();
    guard.answer('close');
    expect(t.closed()).toBe(1);
    expect(t.quits()).toBe(0);
  });

  it('ответ cancel (Cancel или ошибка записи Save all) — окно остаётся, следующий close снова спрашивает', () => {
    const t = fakeCloseTargets();
    const guard = guardWindowClose(t.window, t.app);
    guard.setDirtyCount(1);
    t.closeWindow();
    guard.answer('cancel');
    expect(t.closed()).toBe(0);
    expect(t.closeWindow()).toBe(true);
    expect(t.sent).toEqual(['app:confirm-close', 'app:confirm-close']);
  });

  it('⌘Q (before-quit) с грязными — вопрос; ответ close — app.quit без второго вопроса', () => {
    const t = fakeCloseTargets();
    const guard = guardWindowClose(t.window, t.app);
    guard.setDirtyCount(1);
    expect(t.quitApp()).toBe(true);
    expect(t.sent).toEqual(['app:confirm-close']);
    guard.answer('close');
    expect(t.quits()).toBe(1);
    expect(t.sent).toEqual(['app:confirm-close']);
    expect(t.closeWindow()).toBe(false);
  });

  it('ответ без вопроса ничего не делает; dispose снимает слушатель before-quit', () => {
    const t = fakeCloseTargets();
    const guard = guardWindowClose(t.window, t.app);
    guard.answer('close');
    expect(t.closed()).toBe(0);
    guard.dispose();
    expect(t.quitListenerCount()).toBe(0);
  });
});
