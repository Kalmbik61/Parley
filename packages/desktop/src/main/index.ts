import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, Notification, shell, systemPreferences } from 'electron';
import type { WorksSnapshot } from '@harnas/protocol';
import { S } from '../shared/strings.js';
import { cleanupDrops, DropTooLargeError, dropsDir, MAX_DROP_IMAGE_BYTES, saveImage } from './drops.js';
import { createGitRunner } from './files/git-api.js';
import createGrepWorker from './files/grep-worker?nodeWorker';
import { registerFilesIpc } from './files/ipc.js';
import { HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
import { forwardAppearanceToWindow, forwardHostToWindow, registerIpc } from './ipc.js';
import { createLayoutStore, desktopLayoutsPath } from './layout-store.js';
import { createAppMenu } from './menu.js';
import {
  createLoggedNotification,
  createNotifier,
  createPendingFocusTarget,
  type LoggedNotification,
  type NotificationLike,
} from './notifications.js';
import { createRootsRegistry, type RootsSource } from './roots.js';
import { captureShellEnv } from './shell-env.js';
import { createUiStore, desktopUiPath } from './ui-store.js';
import { createMainWindow, titlebarDoubleClickAction } from './window.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Скриншоты в `drops/` живут 7 суток (план, «Числа»). */
const DROPS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Картинка 1×1 для E2E (`HARNAS_DROPS=fake`): тест не трогает настоящий буфер обмена
 * человека — ни читать его, ни писать в него (решение контролёра 5.4).
 */
const FAKE_DROP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * PNG картинки из буфера обмена; null — картинки нет. `clipboard` Electron 44 — асинхронный,
 * по образцу W3C (`read()` и `ClipboardItem.types`), `readImage` в нём больше нет. Картинку
 * не в PNG (TIFF скриншота macOS) пересобирает `nativeImage`.
 */
async function clipboardPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find((name) => name.startsWith('image/'));
    if (type === undefined) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob)) continue;
    // Огромную картинку не грузим в память целиком: отказ до arrayBuffer. PNG после
    // пересборки nativeImage проверит сам saveImage.
    if (blob.size > MAX_DROP_IMAGE_BYTES) throw new DropTooLargeError(blob.size);
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (type === 'image/png') return bytes;
    const image = nativeImage.createFromBuffer(bytes);
    if (!image.isEmpty()) return image.toPNG();
  }
  return null;
}

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
            const reason = S.connection.reasonNodeNotFound;
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
            console.error('[harnas] failed to start host', err);
          }
        })();
      },
    });

    try {
      await connection.connect();
    } catch (err) {
      console.error('[harnas] failed to connect to host', err);
    }

    // `ui.json` и `themeSource` — до первого окна: `nativeTheme.shouldUseDarkColors`
    // ниже должен уже отражать выбор пользователя, иначе `backgroundColor` возьмёт
    // системную тему вместо сохранённой (спека 4.7, «Старт»).
    const uiStore = createUiStore(desktopUiPath());
    const ui = await uiStore.load();
    nativeTheme.themeSource = ui.appearance;

    const preloadPath = path.join(dirname, '../preload/index.js');
    const indexHtmlPath = path.join(dirname, '../renderer/index.html');

    // Флаги окна из `search` (`location.search` рендерера читает их сама, `main/window.ts`
    // просто грузит файл с готовой строкой запроса): `renderer=dom` — E2E читают текст
    // экрана терминала, им нужен DOM-рендер xterm вместо WebGL.
    const searchFlags = [
      process.env.HARNAS_TERMINAL_RENDERER === 'dom' ? 'renderer=dom' : null,
    ].filter((flag): flag is string => flag !== null);

    // Окна, у которых был did-finish-load: только им событие `app:focus-target` дойдёт —
    // раньше прелоад ещё не слушает. Перезагрузка страницы снимает признак до нового конца.
    const loadedWindows = new WeakSet<BrowserWindow>();
    const pendingFocusTarget = createPendingFocusTarget();

    const openWindow = (): BrowserWindow => {
      const window = createMainWindow({
        dark: nativeTheme.shouldUseDarkColors,
        preloadPath,
        indexHtmlPath,
        ...(searchFlags.length > 0 ? { search: searchFlags.join('&') } : {}),
      });
      // Раньше did-finish-load слать события в это окно бессмысленно и вредно:
      // прелоад ещё может не успеть навесить свои `ipcRenderer.on` (первая,
      // самая важная навигация — с about:blank на наш index.html), и самое
      // первое сообщение (обычно «хост подключён») уйдёт в пустоту.
      window.webContents.once('did-finish-load', () => {
        forwardHostToWindow(connection, window);
        forwardAppearanceToWindow(nativeTheme, window);
      });
      window.webContents.on('did-start-loading', () => loadedWindows.delete(window));
      window.webContents.on('did-finish-load', () => loadedWindows.add(window));
      return window;
    };

    mainWindow = openWindow();

    // E2E (`HARNAS_NOTIFICATIONS=log`): уведомления — в журнал main, а не на экран
    // человека; тест читает и кликает их через `app.evaluate` (`globalThis.__harnasNotifications`).
    const notificationLog: LoggedNotification[] = [];
    const logNotifications = process.env.HARNAS_NOTIFICATIONS === 'log';
    if (logNotifications) {
      (globalThis as { __harnasNotifications?: LoggedNotification[] }).__harnasNotifications = notificationLog;
    }
    const notifier = createNotifier({
      create: (options): NotificationLike =>
        logNotifications ? createLoggedNotification(notificationLog, options) : new Notification(options),
      focusWindow: () => {
        const window = mainWindow;
        // После закрытия окна ссылка не обнуляется, а macOS держит приложение и без окон.
        if (window === null || window.isDestroyed()) {
          mainWindow = openWindow();
          return;
        }
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      },
      sendFocusTarget: (target) => {
        const window = mainWindow;
        if (window !== null && !window.isDestroyed() && loadedWindows.has(window)) {
          window.webContents.send('app:focus-target', target);
        } else {
          // Окно ещё грузится — в том числе созданное `activate` за миг до клика.
          pendingFocusTarget.put(target);
        }
      },
    });

    // Реестр корней файлов (кусок 5.2, спека 10.8). `works.list` — на каждое (пере)подключение:
    // снимок работ новому клиенту хост не шлёт, а первый `connect()` выше мог упасть.
    // `onStatus` отдаёт текущий статус сразу при подписке — уже поднятая связь читается тут же.
    // Старые скриншоты `drops/` (кусок 5.4): только обычные файлы и сами ссылки, по lstat.
    // В фоне — старт окна их не ждёт.
    void cleanupDrops(dropsDir(), DROPS_MAX_AGE_MS).catch((error: unknown) => console.warn('[harnas] cleanupDrops', error));
    const fakeDrops = process.env.HARNAS_DROPS === 'fake';

    const rootsSource: RootsSource = {
      list: () => connection.call('works.list', {}) as Promise<WorksSnapshot>,
      onChange: (listener) =>
        connection.onEvent((message) => {
          if (message.event === 'works.changed') listener(message.data as WorksSnapshot);
        }),
      onConnected: (listener) =>
        connection.onStatus((status) => {
          if (status.state === 'connected') listener();
        }),
    };
    const roots = createRootsRegistry(rootsSource);

    // E2E (`HARNAS_SHELL=log`): «открыть в приложении», «показать в Finder» и внешний адрес —
    // в журнал main, а не на экран человека (настоящие открыли бы приложение, Finder и браузер);
    // тест читает журнал через `app.evaluate` (`globalThis.__harnasShell`).
    const shellLog: Array<{ action: 'openPath' | 'showItemInFolder'; path: string } | { action: 'openExternal'; url: string }> = [];
    const logShell = process.env.HARNAS_SHELL === 'log';
    if (logShell) {
      (globalThis as { __harnasShell?: typeof shellLog }).__harnasShell = shellLog;
    }

    registerIpc({
      ipcMain,
      connection,
      layoutStore: createLayoutStore(desktopLayoutsPath()),
      uiStore,
      setAppearance: (mode) => {
        nativeTheme.themeSource = mode;
      },
      openExternal: async (url) => {
        if (!logShell) return shell.openExternal(url);
        shellLog.push({ action: 'openExternal', url });
      },
      showItemInFolder: (path) => {
        if (logShell) shellLog.push({ action: 'showItemInFolder', path });
        else shell.showItemInFolder(path);
      },
      roots,
      openPath: async (path) => {
        if (!logShell) return shell.openPath(path);
        shellLog.push({ action: 'openPath', path });
        return '';
      },
      saveDropImage: async () => {
        if (fakeDrops) return saveImage({ png: FAKE_DROP_PNG, dir: dropsDir() });
        // Есть текст — вставляется текст (спека 8.5): рендерер это уже проверил, main — для надёжности.
        if ((await clipboard.readText()) !== '') return null;
        return saveImage({ png: await clipboardPng(), dir: dropsDir() });
      },
      chooseFolder: async () => {
        const window = mainWindow;
        const result = window
          ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0] ?? null;
      },
      showNotification: (note) => notifier.notify(note),
      takeFocusTarget: () => pendingFocusTarget.take(),
      setBadge: (count) => {
        app.dock?.setBadge(count > 0 ? String(count) : '');
      },
      titlebarDoubleClick: () => {
        const window = mainWindow;
        if (window === null || window.isDestroyed()) return;
        // Как ведёт себя родной заголовок macOS на двойной клик — настройка
        // системы, а не наша (спека 5.1). 'None' (или незнакомое значение) —
        // ничего не делать, а не молчаливый maximize (раунд исправлений 1, Minor A2).
        const action = titlebarDoubleClickAction(
          systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string'),
        );
        if (action === 'minimize') window.minimize();
        else if (action === 'maximize') {
          if (window.isMaximized()) window.unmaximize();
          else window.maximize();
        }
      },
    });
    // git — с PATH login-shell, как хост; воркер поиска — отдельный бандл electron-vite.
    // Слежение и поиски окна снимаются его перезагрузкой и закрытием (files/ipc.ts).
    registerFilesIpc({
      ipcMain,
      roots,
      git: createGitRunner(shellEnv.env),
      spawnGrepWorker: () => createGrepWorker({}),
    });
    createAppMenu(() => mainWindow);

    // Клик по уведомлению без окон: macOS может прислать `activate` раньше клика. Окно
    // тогда создаёт этот обработчик, а цель клика ждёт его загрузки в отложенных.
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
