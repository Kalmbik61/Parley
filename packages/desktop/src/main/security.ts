import { BrowserWindow } from 'electron';

/**
 * Юридическая рамка окна (спека 9.1): контекст изолирован, Node — только в
 * прелоаде, произвольную навигацию и открытие новых окон запрещаем — внешние
 * ссылки идут через `app.openExternal` (см. `ipc.ts`), а не через сам webContents.
 */
export function createSecureWindow(preloadPath: string, indexHtmlUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== indexHtmlUrl) event.preventDefault();
  });

  return window;
}
