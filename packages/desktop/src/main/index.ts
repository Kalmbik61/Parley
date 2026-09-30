import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  systemPreferences,
  webContents,
} from 'electron';
import type { WebContents } from 'electron';
import { configPath, envValue, loadConfig, migrateHome, parleyHome } from '@parley/core';
import type { WorksSnapshot } from '@parley/protocol';
import { BROWSER_PARTITION } from '../shared/browser-types.js';
import { S } from '../shared/strings.js';
import { createDesignMode } from './browser/design-mode.js';
import { fetchFavicon } from './browser/favicon.js';
import guestPickScript from './browser/guest-pick.js?raw';
import { installBrowserGuard, promptDownload } from './browser/guard.js';
import { cleanupDrops, DropTooLargeError, dropsDir, MAX_DROP_IMAGE_BYTES, saveImage } from './drops.js';
import { createGitRunner, isProjectWorktree } from './files/git-api.js';
import createGrepWorker from './files/grep-worker?nodeWorker';
import { registerFilesIpc } from './files/ipc.js';
import { HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
import { forwardAppearanceToWindow, forwardHostToPages, registerIpc } from './ipc.js';
import { quietExpectedIpcRefusals } from './ipc-quiet.js';
import { forwardGuestShortcuts } from './guest-shortcuts.js';
import { createLayoutStore, desktopLayoutsPath } from './layout-store.js';
import { createAppMenu } from './menu.js';
import { createNotesStore } from './notes-store.js';
import {
  createLoggedNotification,
  createNotifier,
  createPendingFocusTarget,
  type LoggedNotification,
  type NotificationLike,
} from './notifications.js';
import { createRootsRegistry, worktreeRootPolicy, type RootsSource } from './roots.js';
import { captureShellEnv } from './shell-env.js';
import { testSwitches } from './test-switches.js';
import { createUiStore, desktopUiPath } from './ui-store.js';
import { userDataDir } from './user-data.js';
import { createMainWindow, guardWindowClose, titlebarDoubleClickAction } from './window.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Скриншоты в `drops/` живут 7 суток (план, «Числа»). */
const DROPS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Картинка 1×1 для E2E (`PARLEY_DROPS=fake`): тест не трогает настоящий буфер обмена
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

// Ожидаемый отказ канала (неверная регулярка поиска и т. п.) — ответ окну, а не сбой main:
// Electron не печатает его в stderr (fix-lane-post, п. 4).
quietExpectedIpcRefusals(console);

// Тестовые переключатели E2E — только в неупакованном окне или при PARLEY_E2E=1 (ревью M5).
const switches = testSwitches(process.env, app.isPackaged);

// userData окна ставится здесь, на верхнем уровне, — до лока одного экземпляра и до первой сессии Chromium.
// При своём доме (тесты, второй дом: задан `PARLEY_HOME` или прежний `HARNAS_HOME`) у окна свой
// userData: лок одного экземпляра тогда привязан к дому так же, как хост, и чужой дом его не
// держит. Дом окно берёт только из core (`parleyHome`), переменных не читает само.
// Без своего дома userData закреплён (R7): Electron считает его от имени пакета, а оно сменилось, и без закрепления
// окно открыло бы пустой `@parley/desktop` вместо данных человека в `@harnas/desktop` (`user-data.ts`).
const explicitHome = envValue(process.env, 'HOME') !== undefined;
if (explicitHome) {
  app.setPath('userData', path.join(parleyHome(), 'desktop', 'electron'));
} else {
  app.setPath('userData', userDataDir(switches.appData ?? app.getPath('appData')));
}

// E2E (`PARLEY_DOWNLOADS=log`): диалог сохранения загрузок браузера подменён журналом main, а папка
// загрузок — в доме теста: настоящий диалог не встаёт на экране человека, его Downloads не трогаются.
const logDownloads = switches.downloads;
if (logDownloads && explicitHome) {
  app.setPath('downloads', path.join(parleyHome(), 'desktop', 'downloads'));
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
    // Открытому из Finder окну launchd отдаёт урезанное окружение: без `~/.local/bin` и nvm хост не найдёт
    // ни `claude`, ни `codex`, а прокси, `CLAUDE_CONFIG_DIR` и `PARLEY_*` (прежние `HARNAS_*` тоже) из rc-файлов человека не придут
    // вовсе. Окружение login-оболочки снимается один раз, до хоста, и уходит в хост окружением его запуска,
    // в поиск `node`, git и конфиг; агенты наследуют его от хоста.
    // E2E (`PARLEY_LOGIN_SHELL=skip`): оболочку человека с её rc-файлами не зовём, окружение — то, с которым
    // запущен тест; разбор настоящего вывода оболочки держат тесты `shell-env.test.ts` с заглушкой в файле.
    const shellEnv = await captureShellEnv({ skip: switches.loginShell });
    if (shellEnv.warning) {
      console.warn(`[parley] captureShellEnv: ${shellEnv.warning}`);
    }

    // Перенос дома `~/.harnas` → `~/.parley` (R6) — до поиска и запуска хоста: пути хоста считаются от дома, и окно
    // сперва решает, какой из двух домов настоящий. Заданный дом (у окна или в окружении оболочки, с которым
    // стартует хост) не переносится; живой хост старого дома и блокировка записи — тоже: окно подключится к
    // старому дому, как раньше, а перенос повторится при следующем запуске.
    const homeMigration = await migrateHome({ env: explicitHome ? process.env : shellEnv.env });
    if (homeMigration.status === 'moved') {
      console.info(`[parley] home moved: ${homeMigration.from} -> ${homeMigration.to}`);
    } else if (homeMigration.reason !== 'no-legacy' && homeMigration.reason !== 'explicit-home') {
      const detail = homeMigration.detail === undefined ? '' : `: ${homeMigration.detail}`;
      console.warn(`[parley] home not moved (${homeMigration.reason}${detail}): ${homeMigration.from}`);
    }

    const paths = hostPaths();
    const connection = new HostConnection({
      paths,
      env: shellEnv.env,
      // Процесс хоста — соединению: пока он жив, второй не запускается (раунд lane-r4).
      spawn: async () => {
        // Системный node, не бинарь Electron: node-pty хоста собран под ABI
        // системного Node и под Node самого Electron не загрузится (спека 3.2).
        const nodeBin = await resolveNodeBin(shellEnv.env);
        if (nodeBin === null) {
          const reason = S.connection.reasonNodeNotFound;
          console.error(`[parley] ${reason}`);
          connection.reportUnavailable(reason);
          return null;
        }
        try {
          const entry = resolveHostEntry({
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
          });
          return spawnHost({
            env: shellEnv.env,
            entry,
            nodeBin,
            stderrFile: path.join(paths.dir, 'host.err'),
          });
        } catch (err) {
          console.error('[parley] failed to start host', err);
          return null;
        }
      },
    });

    try {
      await connection.connect();
    } catch (err) {
      console.error('[parley] failed to connect to host', err);
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
      envValue(process.env, 'TERMINAL_RENDERER') === 'dom' ? 'renderer=dom' : null,
    ].filter((flag): flag is string => flag !== null);

    // Нативные вопросы main в E2E — в журнал (`globalThis.__parleyDialogs`), ответ «ждать».
    const logDialogs = switches.dialogs;
    const dialogLog: string[] = [];
    if (logDialogs) (globalThis as { __parleyDialogs?: string[] }).__parleyDialogs = dialogLog;

    // Окна, у которых был did-finish-load: только им событие `app:focus-target` дойдёт —
    // раньше прелоад ещё не слушает. Перезагрузка страницы снимает признак до нового конца.
    const loadedWindows = new WeakSet<BrowserWindow>();
    const pendingFocusTarget = createPendingFocusTarget();
    // Вопрос о несохранённых буферах при закрытии окна и ⌘Q (кусок 7.3a) — по окну-отправителю.
    const closeGuards = new WeakMap<WebContents, ReturnType<typeof guardWindowClose>>();

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
      // первое сообщение (обычно «хост подключён») уйдёт в пустоту. Статус хоста —
      // каждой загрузке: после перезагрузки страница иначе осталась бы на «Connecting…».
      forwardHostToPages(connection, window);
      window.webContents.once('did-finish-load', () => {
        forwardAppearanceToWindow(nativeTheme, window);
      });
      window.webContents.on('did-start-loading', () => loadedWindows.delete(window));
      window.webContents.on('did-finish-load', () => loadedWindows.add(window));
      const closeGuard = guardWindowClose(window, app, {
        askUnresponsive: async () => {
          // E2E (`PARLEY_DIALOGS=log`): настоящий системный диалог на экране человека не встаёт.
          if (logDialogs) {
            dialogLog.push('unresponsive');
            return 'wait';
          }
          const { response } = await dialog.showMessageBox(window, {
            type: 'warning',
            message: S.files.unresponsive,
            buttons: [S.files.quitAnyway, S.files.wait],
            defaultId: 1,
            cancelId: 1,
          });
          return response === 0 ? 'quit' : 'wait';
        },
      });
      closeGuards.set(window.webContents, closeGuard);
      // Новая страница — по did-navigate, а не did-start-loading: тот приходит и перед
      // перезагрузкой, которую потом отменит вопрос о правках (fix-7.3 п. 4б), и сбросил бы счёт.
      window.webContents.on('did-navigate', () => closeGuard.reset());
      window.webContents.on('render-process-gone', () => closeGuard.reset());
      window.on('closed', () => closeGuard.dispose());
      // Фокус окна macOS (кусок 9.2b, спека 7.2): при фокусе в странице <webview> уход в другое
      // приложение DOM окна не показывает, а focus и blur WebContents при смене окон не приходят.
      const sendWindowFocus = (focused: boolean): void => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('app:window-focus', focused);
      };
      window.on('focus', () => sendWindowFocus(true));
      window.on('blur', () => sendWindowFocus(false));
      return window;
    };

    // Клетка встроенного браузера (кусок 9.1, спека 12.2) — до первого окна: его
    // web-contents-created приходит внутри new BrowserWindow, а session.fromPartition до ready бросает.
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    // Журнал загрузок E2E; ответ «диалога» тест кладёт в `__parleySaveAnswer`: путь или null — «Отмена».
    const downloadLog: Array<{ filename: string; url: string }> = [];
    const testGlobals = globalThis as { __parleyDownloads?: typeof downloadLog; __parleySaveAnswer?: string | null };
    if (logDownloads) testGlobals.__parleyDownloads = downloadLog;
    // Снимок элемента Design Mode (кусок 9.3a) — в drops/, как скриншоты из буфера (5.4). Создаётся до
    // стража: загрузка из гостя снимает его выбор (fix-9b).
    const designMode = createDesignMode({
      fromId: (id) => webContents.fromId(id) ?? null,
      saveImage: (png) => saveImage({ png, dir: dropsDir() }),
      guestScript: guestPickScript,
    });
    installBrowserGuard({
      app,
      // К моменту will-attach-webview mainWindow уже присвоен — и у окна, пересозданного на activate.
      isMainWindow: (contents) => contents === mainWindow?.webContents,
      session: browserSession,
      // Окну-хозяину открывателя; куда встаёт вкладка — решает окно (9.2b).
      openTab: (e) => {
        webContents.fromId(e.openerWebContentsId)?.hostWebContents?.send('browser:open-tab', e);
      },
      // hostWebContents читается в момент нажатия: окно пересоздаётся на activate, ссылка устарела бы.
      forwardShortcuts: (contents) =>
        forwardGuestShortcuts(contents, (id) => contents.hostWebContents?.send('menu:action', id)),
      download: (item, source) => {
        designMode.downloadStarted(source.id);
        if (!logDownloads) {
          promptDownload(item, app.getPath('downloads'));
          return;
        }
        downloadLog.push({ filename: item.getFilename(), url: item.getURL() });
        const answer = testGlobals.__parleySaveAnswer ?? null;
        if (answer === null) item.cancel();
        else item.setSavePath(answer);
      },
      // Сессией раздела браузера, а не окна: куки и прокси — страницы, а не приложения.
      fetchFavicon: (iconUrl, pageUrl) =>
        fetchFavicon(iconUrl, pageUrl, (url, init) => browserSession.fetch(url, init)),
    });

    mainWindow = openWindow();

    // E2E (`PARLEY_NOTIFICATIONS=log`): уведомления — в журнал main, а не на экран
    // человека; тест читает и кликает их через `app.evaluate` (`globalThis.__parleyNotifications`).
    const notificationLog: LoggedNotification[] = [];
    const logNotifications = switches.notifications;
    if (logNotifications) {
      (globalThis as { __parleyNotifications?: LoggedNotification[] }).__parleyNotifications = notificationLog;
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
    void cleanupDrops(dropsDir(), DROPS_MAX_AGE_MS).catch((error: unknown) => console.warn('[parley] cleanupDrops', error));
    const fakeDrops = switches.drops;

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
    // git — с PATH login-shell, как хост; один раннер у файлового API и проверки корней.
    const gitRunner = createGitRunner(shellEnv.env);
    // Корень worktree — только в каталоге worktree харнесса (настройки core с окружением хоста) или
    // зарегистрированный worktree проекта: карту переписывает и агент (раунд fix-final-a, M6).
    const roots = createRootsRegistry(rootsSource, {
      acceptWorktree: worktreeRootPolicy({
        home: os.homedir(),
        worktreeRoot: async () => (await loadConfig(configPath(), shellEnv.env)).config.worktreeRoot,
        isRegistered: (projectPath, dir) => isProjectWorktree(gitRunner, projectPath, dir),
      }),
    });

    // E2E (`PARLEY_SHELL=log`): «открыть в приложении», «показать в Finder» и внешний адрес —
    // в журнал main, а не на экран человека (настоящие открыли бы приложение, Finder и браузер);
    // тест читает журнал через `app.evaluate` (`globalThis.__parleyShell`).
    const shellLog: Array<{ action: 'openPath' | 'showItemInFolder'; path: string } | { action: 'openExternal'; url: string }> = [];
    const logShell = switches.shell;
    if (logShell) {
      (globalThis as { __parleyShell?: typeof shellLog }).__parleyShell = shellLog;
    }

    registerIpc({
      ipcMain,
      connection,
      layoutStore: createLayoutStore(desktopLayoutsPath()),
      uiStore,
      notesStore: createNotesStore(),
      setAppearance: (mode) => {
        nativeTheme.themeSource = mode;
      },
      isDark: () => nativeTheme.shouldUseDarkColors,
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
      browser: {
        fromId: (id) => webContents.fromId(id) ?? null,
        session: browserSession,
        designMode,
      },
      saveDropImage: async () => {
        if (fakeDrops) return saveImage({ png: FAKE_DROP_PNG, dir: dropsDir() });
        // Есть текст — вставляется текст (спека 8.5): рендерер это уже проверил, main — для надёжности.
        if ((await clipboard.readText()) !== '') return null;
        return saveImage({ png: await clipboardPng(), dir: dropsDir() });
      },
      setDirtyBuffers: (sender, count) => closeGuards.get(sender)?.setDirtyCount(count),
      answerClose: (sender, answer) => closeGuards.get(sender)?.answer(answer),
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
    // Воркер поиска — отдельный бандл electron-vite. Слежение и поиски окна снимаются его
    // перезагрузкой и закрытием (files/ipc.ts).
    registerFilesIpc({
      ipcMain,
      roots,
      git: gitRunner,
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
