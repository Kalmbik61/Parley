import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import { HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
import { forwardAppearanceToWindow, forwardHostToWindow, registerIpc } from './ipc.js';
import { createLayoutStore, desktopLayoutsPath } from './layout-store.js';
import { createAppMenu } from './menu.js';
import { createSecureWindow } from './security.js';
import { captureShellEnv } from './shell-env.js';
import { createUiStore, desktopUiPath } from './ui-store.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// При своём HARNAS_HOME (тесты, второй дом) у окна свой userData: лок одного
// экземпляра тогда привязан к дому так же, как хост, и чужой дом его не держит.
if (process.env.HARNAS_HOME) {
  app.setPath('userData', path.join(process.env.HARNAS_HOME, 'desktop', 'electron'));
}

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
        void (async () => {
          // Системный node, не бинарь Electron: node-pty хоста собран под ABI
          // системного Node и под Node самого Electron не загрузится (спека 3.2).
          const nodeBin = await resolveNodeBin(shellEnv.env);
          if (nodeBin === null) {
            const reason = 'Не найден node в PATH login-shell';
            console.error(`[harnas] ${reason}`);
            connection.reportUnavailable(reason);
            return;
          }
          try {
            const entry = resolveHostEntry({
              packaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
            });
            spawnHost({
              env: shellEnv.env,
              entry,
              nodeBin,
              stderrFile: path.join(paths.dir, 'host.err'),
            });
          } catch (err) {
            console.error('[harnas] не удалось запустить хост', err);
          }
        })();
      },
    });

    try {
      await connection.connect();
    } catch (err) {
      console.error('[harnas] не удалось подключиться к хосту', err);
    }

    // `ui.json` и `themeSource` — до первого окна: `nativeTheme.shouldUseDarkColors`
    // ниже должен уже отражать выбор пользователя, иначе `backgroundColor` возьмёт
    // системную тему вместо сохранённой (спека 4.7, «Старт»).
    const uiStore = createUiStore(desktopUiPath());
    const ui = await uiStore.load();
    nativeTheme.themeSource = ui.appearance;

    const preloadPath = path.join(dirname, '../preload/index.js');
    const indexHtmlPath = path.join(dirname, '../renderer/index.html');
    const indexHtmlUrl = `file://${indexHtmlPath}`;

    const openWindow = (): BrowserWindow => {
      const window = createSecureWindow(preloadPath, indexHtmlUrl);
      // Цвет фона — до первой загрузки страницы: иначе в тёмной теме мелькает
      // белый холст Electron по умолчанию, пока не подгрузится CSS (спека 4.7).
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff');
      // Раньше did-finish-load слать события в это окно бессмысленно и вредно:
      // прелоад ещё может не успеть навесить свои `ipcRenderer.on` (первая,
      // самая важная навигация — с about:blank на наш index.html), и самое
      // первое сообщение (обычно «хост подключён») уйдёт в пустоту.
      window.webContents.once('did-finish-load', () => {
        forwardHostToWindow(connection, window);
        forwardAppearanceToWindow(nativeTheme, window);
      });
      // E2E читают текст экрана терминала — им нужен DOM-рендер xterm вместо WebGL.
      const search =
        process.env.HARNAS_TERMINAL_RENDERER === 'dom' ? { search: 'renderer=dom' } : {};
      void window.loadFile(indexHtmlPath, search);
      return window;
    };

    mainWindow = openWindow();
    registerIpc({
      ipcMain,
      connection,
      layoutStore: createLayoutStore(desktopLayoutsPath()),
      uiStore,
      setAppearance: (mode) => {
        nativeTheme.themeSource = mode;
      },
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
