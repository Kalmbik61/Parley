import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from '@harnas/host';
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { HostConnection } from './host-connection.js';
import { resolveHostEntry, spawnHost } from './host-launcher.js';
import { forwardHostToWindow, registerIpc } from './ipc.js';
import { createAppMenu } from './menu.js';
import { createSecureWindow } from './security.js';
import { captureShellEnv } from './shell-env.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Второй экземпляр не поднимает второй хост и не открывает второе окно —
// фокусирует первое (см. план, «На что смотреть на ревью», пункт 1).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  const focusMainWindow = (): void => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  };

  app.on('second-instance', focusMainWindow);

  app.whenReady().then(async () => {
    const shellEnv = await captureShellEnv();
    if (shellEnv.warning) {
      console.warn(`[harnas] captureShellEnv: ${shellEnv.warning}`);
    }

    const paths = hostPaths();
    const connection = new HostConnection({
      paths,
      env: shellEnv.env,
      spawn: () => {
        try {
          const entry = resolveHostEntry();
          spawnHost({ env: shellEnv.env, entry, nodeBin: process.execPath });
        } catch (err) {
          console.error('[harnas] не удалось запустить хост', err);
        }
      },
    });

    try {
      await connection.connect();
    } catch (err) {
      console.error('[harnas] не удалось подключиться к хосту', err);
    }

    const preloadPath = path.join(dirname, '../preload/index.js');
    const indexHtmlPath = path.join(dirname, '../renderer/index.html');
    const indexHtmlUrl = `file://${indexHtmlPath}`;

    const openWindow = (): BrowserWindow => {
      const window = createSecureWindow(preloadPath, indexHtmlUrl);
      // Раньше did-finish-load слать события в это окно бессмысленно и вредно:
      // прелоад ещё может не успеть навесить свои `ipcRenderer.on` (первая,
      // самая важная навигация — с about:blank на наш index.html), и самое
      // первое сообщение (обычно «хост подключён») уйдёт в пустоту.
      window.webContents.once('did-finish-load', () => {
        forwardHostToWindow(connection, window);
      });
      void window.loadFile(indexHtmlPath);
      return window;
    };

    mainWindow = openWindow();
    registerIpc({
      ipcMain,
      connection,
      openExternal: (url) => shell.openExternal(url),
      chooseFolder: async () => {
        const window = mainWindow;
        const result = window
          ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0] ?? null;
      },
      showNotification: (note) => {
        new Notification(note).show();
      },
      setBadge: (count) => {
        app.dock?.setBadge(count > 0 ? String(count) : '');
      },
    });
    createAppMenu(() => mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = openWindow();
      }
    });
  });

  // Хост — отдельный, отсоединённый процесс: закрытие окна его не трогает.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
