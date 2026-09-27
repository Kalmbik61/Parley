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
