import { BrowserWindow } from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';

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

  void window.loadFile(input.indexHtmlPath, input.search !== undefined ? { search: input.search } : undefined);
  return window;
}

/** Что `guardWindowClose` трогает у окна — ради теста на подставном (настоящий BrowserWindow под vitest не поднять). */
export interface ClosableWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  close(): void;
  isDestroyed(): boolean;
  webContents: { send(channel: string): void };
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
 */
export function guardWindowClose(
  window: ClosableWindow,
  app: QuittableApp,
): { setDirtyCount(count: number): void; answer(answer: 'close' | 'cancel'): void; reset(): void; dispose(): void } {
  let dirty = 0;
  /** Ответ «закрыть» получен: следующий `close` (и `before-quit`) пропускается без вопроса. */
  let allowed = false;
  /** Вопрос задан, ответа ещё нет: повторный ⌘Q или крестик второго вопроса не шлёт. */
  let asking = false;
  /** Вопрос задан из-за ⌘Q: ответ «закрыть» продолжает выход, а не только закрывает окно. */
  let quitting = false;

  const hold = (event: { preventDefault(): void }, quit: boolean): void => {
    if (allowed || dirty === 0) return;
    event.preventDefault();
    if (quit) quitting = true;
    if (asking || window.isDestroyed()) return;
    asking = true;
    window.webContents.send('app:confirm-close');
  };

  const onBeforeQuit = (event: { preventDefault(): void }): void => hold(event, true);
  window.on('close', (event) => hold(event, false));
  app.on('before-quit', onBeforeQuit);

  return {
    setDirtyCount: (count) => {
      dirty = count;
    },
    answer: (answer) => {
      if (!asking) return;
      asking = false;
      if (answer === 'cancel') {
        quitting = false;
        return;
      }
      allowed = true;
      if (quitting) app.quit();
      else if (!window.isDestroyed()) window.close();
    },
    // Страница перезагрузилась или упала: её буферов больше нет, и вопрос ей уже не ответить.
    reset: () => {
      dirty = 0;
      asking = false;
      quitting = false;
    },
    dispose: () => {
      app.removeListener('before-quit', onBeforeQuit);
    },
  };
}
