import { BrowserWindow } from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { guardWebviewAttach } from './browser/guard.js';

/**
 * Опции главного окна (спека 5.1, 4.4): `hiddenInset` вместо прежнего окна без
 * настроек заголовка (`security.ts` этапа 1) — светофор macOS остаётся, а
 * заголовок рисует сам рендерер (`renderer/shell/Titlebar.tsx`). Цвет фона —
 * по теме СРАЗУ в конструкторе, а не отдельным `setBackgroundColor` после
 * создания: иначе перед первой отрисовкой мелькает белый холст Electron по
 * умолчанию (спека 4.7, «Старт»).
 */
export function mainWindowOptions(input: {
  dark: boolean;
  preloadPath: string;
}): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: input.dark ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: input.preloadPath,
      // Встроенный браузер (кусок 9.1, спека 12.2): каждый <webview> проходит guardWebviewAttach.
      webviewTag: true,
    },
  };
}

/**
 * Запрет навигации, кроме своего `index.html`, и `window.open` → `deny` —
 * прежняя защита `security.ts`, вынесенная отдельной функцией ради теста на
 * подставном `webContents` (настоящий `BrowserWindow` под vitest не поднять).
 */
export function guardNavigation(
  webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>,
  indexUrl: string,
): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('will-navigate', (event, url) => {
    if (url !== indexUrl) event.preventDefault();
  });
}

/**
 * Действие двойного клика по пустому месту заголовка (спека 5.1) — трансляция
 * `AppleActionOnDoubleClick` систем­ных настроек macOS в решение окна. Чистая
 * функция, а не часть `titlebarDoubleClick` в `main/index.ts` — ради теста без
 * мока всего `electron` (раунд исправлений 1, Minor A2): `'None'` и любое
 * другое/отсутствующее значение (ключ не задан) — «ничего не делать», а не
 * молчаливый maximize, как было раньше.
 */
export type TitlebarDoubleClickAction = 'maximize' | 'minimize' | 'none';

export function titlebarDoubleClickAction(appleActionOnDoubleClick: string): TitlebarDoubleClickAction {
  if (appleActionOnDoubleClick === 'Minimize') return 'minimize';
  if (appleActionOnDoubleClick === 'Maximize') return 'maximize';
  return 'none';
}

/**
 * Окно с прежней защитой: `contextIsolation`, `sandbox`, `guardNavigation`.
 * Заменяет `createSecureWindow` (`security.ts`, удалён этим куском) — сама
 * загрузка страницы теперь тоже здесь, а не в вызывающем `main/index.ts`:
 * `indexHtmlPath`/`search` больше некому передавать по отдельности.
 */
export function createMainWindow(input: {
  dark: boolean;
  preloadPath: string;
  indexHtmlPath: string;
  search?: string;
}): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions({ dark: input.dark, preloadPath: input.preloadPath }));

  guardNavigation(window.webContents, `file://${input.indexHtmlPath}`);
  // До loadFile: страж позже первого <webview> пропустил бы его с preload из атрибутов (кусок 9.1).
  guardWebviewAttach(window.webContents);

  void window.loadFile(input.indexHtmlPath, input.search !== undefined ? { search: input.search } : undefined);
  return window;
}

/** Что `guardWindowClose` трогает у окна — ради теста на подставном (настоящий BrowserWindow под vitest не поднять). */
export interface ClosableWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  webContents: {
    send(channel: string): void;
    on(event: 'will-prevent-unload' | 'unresponsive' | 'responsive', listener: (event: { preventDefault(): void }) => void): unknown;
    reload(): void;
  };
}

/** Что `guardWindowClose` трогает у `app`. */
export interface QuittableApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  removeListener(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Вопрос о несохранённых буферах при закрытии окна и ⌘Q (кусок 7.3a, решение контролёра по
 * сверке этапа 7): спрашивает само окно, а не родной диалог `beforeunload` — тот E2E не нажать,
 * а потеря правок молча недопустима. Рендерер держит main в курсе числа грязных буферов
 * (`setDirtyCount`); пока оно ноль, окно закрывается сразу, как раньше. Иначе `close` и
 * `before-quit` отменяются, окну уходит `app:confirm-close`, и решает ответ `answer`.
 *
 * Перезагрузка страницы (fix-7.3 п. 4б: DevTools, `webContents.reload()`) — тот же вопрос. У неё нет
 * события до выгрузки, поэтому перехват — `beforeunload` рендерера: при грязных буферах он отменяет
 * выгрузку, Electron сообщает об этом `will-prevent-unload`, и main задаёт вопрос вместо неё. Ответ
 * «закрыть» повторяет перезагрузку, а отмену страницы main тогда пропускает (`preventDefault`) — как
 * и у закрытия с ответом «закрыть». Падение рендерера не перехватить: остаточный риск спеки 10.5.
 *
 * Страница зависла, а вопрос ждёт ответа (fix-7.3 п. 5): по `unresponsive` — нативный вопрос
 * `askUnresponsive`; «Quit anyway» уничтожает окно без `beforeunload` и продолжает выход.
 */
export function guardWindowClose(
  window: ClosableWindow,
  app: QuittableApp,
  options: { askUnresponsive?: () => Promise<'quit' | 'wait'> } = {},
): { setDirtyCount(count: number): void; answer(answer: 'close' | 'cancel'): void; reset(): void; dispose(): void } {
  let dirty = 0;
  /** Ответ «закрыть» получен: следующий `close` (и `before-quit`) пропускается без вопроса. */
  let allowed = false;
  /** Вопрос задан, ответа ещё нет: повторный ⌘Q или крестик второго вопроса не шлёт. */
  let asking = false;
  /** Вопрос задан из-за ⌘Q: ответ «закрыть» продолжает выход, а не только закрывает окно. */
  let quitting = false;
  /** Вопрос задан из-за крестика окна. */
  let closing = false;
  /** Вопрос задан из-за перезагрузки страницы: ответ «закрыть» — перезагрузка, если не ждут закрытия. */
  let reloading = false;
  /** Страница не отвечает (`unresponsive` без `responsive` после). */
  let unresponsive = false;
  /** Нативный вопрос о зависшей странице открыт. */
  let promptingUnresponsive = false;

  const promptIfHung = (): void => {
    const ask = options.askUnresponsive;
    if (ask === undefined || !unresponsive || !asking || promptingUnresponsive || window.isDestroyed()) return;
    promptingUnresponsive = true;
    void ask().then((answer) => {
      promptingUnresponsive = false;
      if (answer !== 'quit' || window.isDestroyed()) return;
      allowed = true;
      // destroy, а не close: зависшая страница не ответит и на `beforeunload`.
      window.destroy();
      app.quit();
    });
  };

  const send = (): void => {
    if (asking || window.isDestroyed()) return;
    asking = true;
    window.webContents.send('app:confirm-close');
    promptIfHung();
  };

  const hold = (event: { preventDefault(): void }, quit: boolean): void => {
    if (allowed || dirty === 0) return;
    event.preventDefault();
    if (quit) quitting = true;
    else closing = true;
    send();
  };

  const onBeforeQuit = (event: { preventDefault(): void }): void => hold(event, true);
  window.on('close', (event) => hold(event, false));
  app.on('before-quit', onBeforeQuit);
  window.webContents.on('will-prevent-unload', (event) => {
    // Ответ «закрыть» уже есть — отмену страницы (её буферы ещё грязные после «Don't save») пропускаем.
    if (allowed) {
      event.preventDefault();
      return;
    }
    // Выгрузку отменила страница, а вопроса не было — перезагрузка. Без preventDefault она отменена.
    reloading = true;
    send();
  });
  window.webContents.on('unresponsive', () => {
    unresponsive = true;
    promptIfHung();
  });
  window.webContents.on('responsive', () => {
    unresponsive = false;
  });

  return {
    setDirtyCount: (count) => {
      dirty = count;
    },
    answer: (answer) => {
      if (!asking) return;
      asking = false;
      const [quit, close, reload] = [quitting, closing, reloading];
      quitting = false;
      closing = false;
      reloading = false;
      if (answer === 'cancel') return;
      allowed = true;
      if (quit) app.quit();
      else if (window.isDestroyed()) return;
      else if (close || !reload) window.close();
      else window.webContents.reload();
    },
    // Страница перезагрузилась или упала: её буферов больше нет, и вопрос ей уже не ответить.
    // Разрешение тоже снимается: оно было на ту выгрузку, у новой страницы вопрос снова свой.
    reset: () => {
      dirty = 0;
      allowed = false;
      asking = false;
      quitting = false;
      closing = false;
      reloading = false;
    },
    dispose: () => {
      app.removeListener('before-quit', onBeforeQuit);
    },
  };
}
