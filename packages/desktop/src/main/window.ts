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
