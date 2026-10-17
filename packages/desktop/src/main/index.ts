import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  webContents,
} from 'electron';
import type { WebContents } from 'electron';
import { configPath, envValue, loadConfig, migrateHome, parleyHome } from '@parley/core';
import type { AssistantLanguage } from '@parley/core/assistant';
import { systemAssistantLanguage } from '../shared/assistant-language.js';
import type { WorksSnapshot } from '@parley/protocol';
import type { FocusTarget, HostStatus } from '../shared/bridge.js';
import { BROWSER_PARTITION } from '../shared/browser-types.js';
import { ISLAND_EVENTS, type AssistantOpenRequest, type IslandConfig } from '../shared/island.js';
import { S } from '../shared/strings.js';
import type { UiFile } from '../shared/ui-types.js';
import { createAgentOps, type AgentOps } from './browser/agent-ops.js';
import { createAnnotate } from './browser/annotate.js';
import { contextDir, saveContextFile } from './browser/context-files.js';
import { createDesignMode, PICK_WORLD_ID } from './browser/design-mode.js';
import { createEmulation } from './browser/emulation.js';
import { fetchFavicon } from './browser/favicon.js';
import guestAnnotateScript from './browser/guest-annotate.js?raw';
import guestDomScript from './browser/guest-dom.js?raw';
import guestPickScript from './browser/guest-pick.js?raw';
import { installBrowserGuard, promptDownload } from './browser/guard.js';
import { createInspector, forwardBatches } from './browser/inspector.js';
import { saveDiagnostics } from './diagnostics/bundle.js';
import { AGENT_SHOT_MAX_AGE_MS, AGENT_SHOT_PREFIX, cleanupDrops, cleanupDropsTree, DropTooLargeError, dropsDir, MAX_DROP_IMAGE_BYTES, saveImage } from './drops.js';
import { createGitRunner, isProjectWorktree } from './files/git-api.js';
import createGrepWorker from './files/grep-worker?nodeWorker';
import { registerFilesIpc } from './files/ipc.js';
import { answerBrowserAgentOps, HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
import { imageThumbnail } from './image-thumbnail.js';
import { forwardAppearanceToWindow, forwardHostToPages, registerIpc } from './ipc.js';
import { quietExpectedIpcRefusals } from './ipc-quiet.js';
import { forwardGuestShortcuts } from './guest-shortcuts.js';
import { createAssistantShortcut } from './assistant/shortcut.js';
import { registerIslandIpc } from './island/ipc.js';
import type { IslandPlacement } from './island/placement.js';
import { createIslandController, islandWindowOptions } from './island/window.js';
import { createLayoutStore, desktopLayoutsPath } from './layout-store.js';
import { createAppMenu } from './menu.js';
import { guardAppQuit, quitQuestion } from './quit-guard.js';
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
import { createUpdateChecker, updateCheckAllowed } from './update-check.js';
import { userDataDir } from './user-data.js';
import { isFileSync, resolveEngine } from './voice/engine.js';
import { registerVoiceIpc } from './voice/ipc.js';
import { MIC_SETTINGS_URL, normalizeMicStatus } from './voice/mic.js';
import { createModelStore, freeBytes, voiceModelsDir } from './voice/models.js';
import { createFakeVoiceServices, createVoiceServices } from './voice/services.js';
import { killRunningEngines, removeStaleRecordings } from './voice/transcribe.js';
import { createMainWindow, guardNavigation, guardWindowClose, titlebarDoubleClickAction, trackLoadedWindow } from './window.js';

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

// Второй экземпляр не поднимает второй хост: фокусирует живое окно или
// пересоздаёт закрытое на macOS через уже готовую связь.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let openMainWindow: (() => BrowserWindow) | null = null;

  const focusMainWindow = (): void => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      // Пока асинхронный старт не закончен, первое окно создаст он сам.
      mainWindow = openMainWindow?.() ?? null;
    }
    const window = mainWindow;
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
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
    // стартует хост) не переносится; живой хост старого дома, блокировка записи и живая сессия в проекте из
    // индекса (и та, что поднята из терминала) — тоже: окно подключится к старому дому, как раньше, а перенос
    // повторится при следующем запуске.
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
        // Собранное окно запускает хост своим встроенным node 22 (`Resources/node`), разработка и сборка
        // без него — node из PATH login-shell. Бинарь Electron не годится: хост — обычный node-процесс.
        const nodeBin = await resolveNodeBin(shellEnv.env, {
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        });
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

    // Операции агента над браузером (спека браузера 2026-10-07, 3.7; этап B2). Подписка — до первого подключения: операция,
    // пришедшая, пока окно поднимается, получает внятный отказ, а не тайм-аут хоста.
    let agentOps: AgentOps | null = null;
    answerBrowserAgentOps(connection, async (event) =>
      agentOps === null
        ? { ok: false, error: { code: 'window_not_connected', message: "Parley's window is still starting: try again in a moment." } }
        : agentOps.run(event),
    );

    try {
      await connection.connect();
    } catch (err) {
      console.error('[parley] failed to connect to host', err);
    }

    // Выход из приложения (Dock → «Завершить», ⌘Q, меню) гасит хост со всеми сессиями; закрытие окна — нет.
    // Вопрос — системный диалог без родительского окна: на `will-quit` окон уже нет. Тестовый режим — по-старому.
    const quitGuard = guardAppQuit(app, {
      liveSessions: () => connection.liveSessions(),
      ask: async (count) => {
        const question = quitQuestion(count);
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          message: question.message,
          detail: question.detail,
          buttons: question.buttons,
          defaultId: 0,
          cancelId: 1,
        });
        return response === 0 ? 'stop' : 'cancel';
      },
      stopHost: async () => {
        await connection.stopHost();
      },
      onCancel: focusMainWindow,
      keepHost: switches.dialogs,
      log: (line) => console.warn(`[parley] ${line}`),
    });
    // Перезагрузка или выключение системы — без вопроса (событие есть на macOS и Linux): хост гасится сразу.
    // Типы Electron объявляют слушатель без аргумента, а само событие отменяемое: задерживаем выключение, пока гасится хост.
    powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => {
      event?.preventDefault();
      quitGuard.systemShutdown();
      app.quit();
    });

    // `ui.json` и `themeSource` — до первого окна: `nativeTheme.shouldUseDarkColors`
    // ниже должен уже отражать выбор пользователя, иначе `backgroundColor` возьмёт
    // системную тему вместо сохранённой (спека 4.7, «Старт»).
    const uiStore = createUiStore(desktopUiPath());
    const ui = await uiStore.load();
    nativeTheme.themeSource = ui.appearance;

    const preloadPath = path.join(dirname, '../preload/index.js');
    const indexHtmlPath = path.join(dirname, '../renderer/index.html');
    const islandPreloadPath = path.join(dirname, '../preload/island.js');
    const islandHtmlPath = path.join(dirname, '../renderer/island.html');

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
    // раньше прелоад ещё не слушает. Перезагрузка страницы снимает признак до нового конца, загрузка <webview> — нет
    // (`trackLoadedWindow`).
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
      trackLoadedWindow(window, loadedWindows);
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
      window.on('closed', () => {
        closeGuard.dispose();
        if (mainWindow === window) mainWindow = null;
      });
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
    // Журнал консоли и сети вкладок браузера (спека 2026-10-07-browser-devtools-agent-design.md, 3.3): инспектор CDP на
    // каждого гостя — до стража, тот подключает гостя на web-contents-created. Пачки — окну-хозяину гостя. Создаётся
    // до выбора элемента: Select берёт у него снимок, роль и React (спека 3.8).
    const inspector = createInspector({ fromId: (id) => webContents.fromId(id) ?? null });
    forwardBatches(inspector, (id) => webContents.fromId(id) ?? null);
    const emulation = createEmulation({ inspector });
    // Снимок элемента Design Mode (кусок 9.3a) — в drops/, как скриншоты из буфера (5.4). Создаётся до
    // стража: загрузка из гостя снимает его выбор (fix-9b).
    const designMode = createDesignMode({
      fromId: (id) => webContents.fromId(id) ?? null,
      saveImage: (png) => saveImage({ png, dir: dropsDir() }),
      // Помощники DOM (guest-dom.js, по Orca) — в той же строке перед скриптом выбора: значение строки — промис выбора.
      guestScript: `${guestDomScript}\n${guestPickScript}`,
      inspector,
    });
    // Аннотации (этап B, спека браузера 4.7): снимок видимой части с метками — в drops/, как у выбора.
    const annotate = createAnnotate({
      fromId: (id) => webContents.fromId(id) ?? null,
      saveImage: (png) => saveImage({ png, dir: dropsDir() }),
      // Помощники DOM (guest-dom.js) — в той же строке перед скриптом меток, как у выбора (задача 2).
      guestScript: `${guestDomScript}\n${guestAnnotateScript}`,
      inspector,
    });
    // Журнал снят вместе с гостем — размер его вкладки тоже.
    inspector.onDestroyed((id) => emulation.forget(id));
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
      inspect: (contents) => inspector.attach(contents),
    });

    mainWindow = openWindow();
    openMainWindow = openWindow;

    // E2E (`PARLEY_NOTIFICATIONS=log`): уведомления — в журнал main, а не на экран
    // человека; тест читает и кликает их через `app.evaluate` (`globalThis.__parleyNotifications`).
    const notificationLog: LoggedNotification[] = [];
    const logNotifications = switches.notifications;
    if (logNotifications) {
      (globalThis as { __parleyNotifications?: LoggedNotification[] }).__parleyNotifications = notificationLog;
    }
    /** Цель клика (уведомление, остров): окну, если оно загружено, иначе — в отложенные. */
    const sendFocusTarget = (target: FocusTarget): void => {
      const window = mainWindow;
      if (window !== null && !window.isDestroyed() && loadedWindows.has(window)) {
        window.webContents.send('app:focus-target', target);
      } else {
        // Окно ещё грузится — в том числе созданное `activate` за миг до клика.
        pendingFocusTarget.put(target);
      }
    };
    const notifier = createNotifier({
      create: (options): NotificationLike =>
        logNotifications ? createLoggedNotification(notificationLog, options) : new Notification(options),
      focusWindow: focusMainWindow,
      sendFocusTarget,
    });

    // Остров одобрений (спека 2026-10-12): окно по настройке «Island»; место — кеш из ui.json (читается один раз на старте), запись асинхронная.
    let islandPlacement: IslandPlacement = { displayId: ui.island.displayId, anchor: ui.island.anchor };
    const island = createIslandController<BrowserWindow>({
      createWindow: () => {
        const window = new BrowserWindow(islandWindowOptions(islandPreloadPath));
        guardNavigation(window.webContents, `file://${islandHtmlPath}`);
        void window.loadFile(islandHtmlPath).catch((error: unknown) => console.warn('[parley] island load failed', error));
        return window;
      },
      displays: () => screen.getAllDisplays(),
      primaryDisplayId: () => screen.getPrimaryDisplay().id,
      placement: () => islandPlacement,
      savePlacement: (placement) => {
        islandPlacement = placement;
        void uiStore.save({ island: { ...placement } } as Partial<Omit<UiFile, 'version'>>).catch(() => undefined);
      },
      cursor: () => screen.getCursorScreenPoint(),
      onHover: (hovered) => {
        const window = island.current();
        if (window !== null) window.webContents.send('island:hover', hovered);
      },
      onKeyboardLost: () => blurAssistant(),
      onCreated: (window) => {
        // Острову — только нужные ему события хоста: `pty.output` всех сессий в его renderer не нужен.
        forwardHostToPages(connection, window, { events: ISLAND_EVENTS });
        // Как у главного окна (`trackLoadedWindow`): «страница загружена» — для `islandActive`; перезагрузка снимает
        // признак до нового конца. С каждым концом загрузки — свежие настройки острова.
        trackLoadedWindow(window, loadedWindows);
        window.webContents.on('did-finish-load', pushIslandConfig);
      },
      log: (message) => console.warn('[parley]', message),
    });
    const assistantShortcut = createAssistantShortcut({
      registry: globalShortcut,
      onTrigger: () => openAssistant({ listen: true }),
      log: (line) => console.warn('[parley]', line),
    });
    function openAssistant(request: AssistantOpenRequest): void {
      const window = island.current();
      if (window === null || window.isDestroyed()) return;
      window.webContents.send('island:assistant-open', request);
    }
    function blurAssistant(): void {
      const window = island.current();
      if (window === null || window.isDestroyed()) return;
      window.webContents.send('island:assistant-blur');
    }
    const assistantLanguage = (current: UiFile): AssistantLanguage =>
      current.assistant.language ?? systemAssistantLanguage(app.getLocale());
    const islandConfig = async (): Promise<IslandConfig> => {
      const current = await uiStore.load();
      return {
        islandEnabled: current.island.enabled,
        assistant: {
          enabled: current.assistant.enabled,
          provider: current.assistant.provider,
          model: current.assistant.model,
          language: assistantLanguage(current),
          hotkey: current.assistant.hotkey,
          voice: { enabled: current.voice.enabled, model: current.voice.model },
        },
        sound: current.notifications.sound,
        topInset: island.topInset(),
        anchor: island.anchor(),
      };
    };
    const pushIslandConfig = (): void => {
      void islandConfig().then((config) => {
        const window = island.current();
        if (window !== null) window.webContents.send('island:config', config);
      });
    };
    /**
     * Настройка решает, есть ли окно; `PARLEY_ISLAND=off` (E2E) — острова нет в любом случае. Место отсюда не читается:
     * его пишет только main (`savePlacement`), и чтение файла, обогнавшее незавершённую запись, откатило бы место назад.
     */
    const syncIsland = (current: UiFile): void => {
      if ((current.island.enabled || current.assistant.enabled) && !switches.islandOff) island.open();
      else island.close();
      assistantShortcut.sync(current.assistant.enabled && !switches.islandOff, current.assistant.hotkey);
      pushIslandConfig();
    };
    // Второстепенное окно не должно ронять старт: сбой создания — в журнал, остальное приложение работает.
    try {
      syncIsland(ui);
    } catch (error) {
      console.warn('[parley] island sync failed', error);
    }
    // Мониторы подключили, отключили, сменили разрешение — место заново из сохранённой точки, отступ под чёлку заново.
    const relayoutIsland = (): void => {
      island.relayout();
      pushIslandConfig();
    };
    screen.on('display-added', relayoutIsland);
    screen.on('display-removed', relayoutIsland);
    screen.on('display-metrics-changed', relayoutIsland);
    registerIslandIpc({
      ipcMain,
      controller: island,
      config: islandConfig,
      pushConfig: pushIslandConfig,
      keyboard: (on) => island.setKeyboard(on),
      openTarget: (target) => {
        focusMainWindow();
        sendFocusTarget(target);
      },
      beep: () => shell.beep(),
      // Тот же `activity.seen`, что шлёт главное окно, когда видит сессию. Методы хоста из приветствия тут не сверяются: хост
      // без `activity.seen` молча отбрасывает уведомление (сервер хоста вызывает `handler?.()`, а неизвестное протоколу
      // только пишет в журнал), и окно само предлагает перезапустить такой хост.
      markSeen: (refs) => {
        for (const ref of refs) connection.notify('activity.seen', { ref });
      },
      onFailed: () => {
        // Упал рендер острова: страница не считается загруженной (системные уведомления снова идут), окно прячется.
        const window = island.current();
        if (window === null) return;
        loadedWindows.delete(window);
        window.hide();
        console.warn('[parley] island render failed');
      },
    });

    // Реестр корней файлов (кусок 5.2, спека 10.8). `works.list` — на каждое (пере)подключение:
    // снимок работ новому клиенту хост не шлёт, а первый `connect()` выше мог упасть.
    // `onStatus` отдаёт текущий статус сразу при подписке — уже поднятая связь читается тут же.
    // Старые скриншоты `drops/` (кусок 5.4) и файлы-контексты браузера в `drops/context/` (спека браузера 3.6):
    // только обычные файлы и сами ссылки, по lstat.
    // В фоне — старт окна их не ждёт.
    void cleanupDropsTree(dropsDir(), DROPS_MAX_AGE_MS).catch((error: unknown) => console.warn('[parley] cleanupDrops', error));
    // Снимки агента (`agent-*`) живут сутки: раз в час старше суток убираются (спека, S8).
    setInterval(() => {
      void cleanupDrops(dropsDir(), AGENT_SHOT_MAX_AGE_MS, Date.now(), (name) => name.startsWith(AGENT_SHOT_PREFIX)).catch((error: unknown) => console.warn('[parley] cleanupAgentShots', error));
    }, 60 * 60 * 1000).unref();
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

    // Проверка новой версии (V6 плана релиза 0.1.0): при старте и раз в сутки main спрашивает GitHub о последнем
    // релизе (`main/update-check.ts`). Окно получает найденное событием `app:update-available`, а то, что найдено до
    // его подписки (окно ещё грузилось или показывало «Connecting…»), — по запросу `app:get-update`. Сеть — стеком
    // Chromium (`net.fetch`: системный прокси), без токенов и куки. Идёт только у собранного окна: в разработке
    // `app.getVersion()` — версия `package.json` ветки, и `pnpm dev:desktop` ходил бы на GitHub зря. Выключена
    // `PARLEY_UPDATE_CHECK=off` (E2E: `playwright.config.ts`; значение — из окружения login-shell, как прочие
    // `PARLEY_*`; не снялось окружение оболочки — из окружения окна) или переключателем в настройках (`ui.json`);
    // оба читаются перед каждой проверкой. Включённый переключатель проверяет сразу: `onUiSaved` ниже.
    const updates = createUpdateChecker({
      currentVersion: app.getVersion(),
      fetch: (url, init) => net.fetch(url, init),
      isEnabled: async () =>
        updateCheckAllowed(shellEnv.env, app.isPackaged) && (await uiStore.load()).checkForUpdates,
      onUpdate: (info) => {
        const window = mainWindow;
        // Окно ещё грузится — событие ушло бы в пустоту (прелоад не подписан): оно спросит само, `app:get-update`.
        if (window !== null && !window.isDestroyed() && loadedWindows.has(window)) {
          window.webContents.send('app:update-available', info);
        }
      },
    });

    // Вкладку агента ставит окно (спека браузера 3.7): место, предел, повтор страницы и тост — его дело. Окно, у которого
    // страница ещё грузится (прелоад не подписан) или которое закрыто, просьбу не получит: агенту сразу window_not_connected.
    // `loadedWindows` тут не годится: первый же `<webview>` даёт окну `did-start-loading` (а `did-finish-load` — нет), и признак
    // снимался бы насовсем; главный кадр окна от гостей не зависит.
    const ops = createAgentOps({
      agentsAllowed: async () => (await uiStore.load()).browser.agentsAllowed,
      openTab: (e) => {
        const window = mainWindow;
        if (window === null || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return false;
        window.webContents.send('browser:agent-open-tab', e);
        return true;
      },
      fromId: (id) => webContents.fromId(id) ?? null,
      inspector,
      emulation,
      saveImage: (png) => saveImage({ png, dir: dropsDir(), prefix: AGENT_SHOT_PREFIX }),
      image: {
        resize: (png, width, height) => nativeImage.createFromBuffer(png).resize({ width, height, quality: 'good' }).toPNG(),
        // Полосы одной ширины склеиваются побайтно: битмапы строка за строкой подряд (спайк 0.7).
        stitch: (parts) => {
          const images = parts.map((part) => nativeImage.createFromBuffer(part));
          const { width } = images[0]?.getSize() ?? { width: 0 };
          const height = images.reduce((sum, image) => sum + image.getSize().height, 0);
          return nativeImage.createFromBitmap(Buffer.concat(images.map((image) => image.toBitmap())), { width, height }).toPNG();
        },
        crop: (png, top, height) => {
          const image = nativeImage.createFromBuffer(png);
          return image.crop({ x: 0, y: top, width: image.getSize().width, height }).toPNG();
        },
      },
      inGuest: (guest, code) => guest.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code }]),
      screenDpr: async (guest) => {
        const host = guest.hostWebContents;
        if (host === undefined || host === null) return null;
        // Изолированный мир окна: рамочный тест запрещает executeJavaScript мира страницы во всём main.
        const dpr: unknown = await host.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: 'window.devicePixelRatio' }]);
        return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : null;
      },
      windowHeight: (guest) => {
        const host = guest.hostWebContents;
        return host === undefined || host === null ? null : (BrowserWindow.fromWebContents(host)?.getContentSize()[1] ?? null);
      },
      activity: (e) => webContents.fromId(e.webContentsId)?.hostWebContents?.send('browser:agent-activity', e),
    });
    agentOps = ops;

    // Версия окна и последний статус хоста — для `app-info.json` архива диагностики; `onStatus` отдаёт текущий статус сразу.
    const appVersion = app.isPackaged ? app.getVersion() : null;
    let hostStatus: HostStatus = { state: 'connecting' };
    connection.onStatus((status) => {
      hostStatus = status;
    });

    registerIpc({
      ipcMain,
      connection,
      layoutStore: createLayoutStore(desktopLayoutsPath()),
      uiStore,
      onUiSaved: () => {
        void updates.settingsChanged();
        // Окна об изменениях ui.json не узнают — main перечитывает файл сам (спека 2026-10-12, 5.1).
        void uiStore.load().then((current) => {
          // Сбой острова не должен ломать сохранение настроек.
          try {
            syncIsland(current);
          } catch (error) {
            console.warn('[parley] island sync failed', error);
          }
        });
      },
      isIslandSender: (sender) => island.isIsland(sender),
      openAssistant: () => openAssistant({ listen: false }),
      assistantShortcut: () => assistantShortcut.status(),
      // «Страница острова загружена», а не просто «окно есть»: пока она грузится или не загрузилась, системные уведомления не глушатся.
      islandActive: () => {
        const window = island.current();
        return window !== null && loadedWindows.has(window);
      },
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
        saveContext: (input) => saveContextFile({ ...input, dir: contextDir(), dropsDir: dropsDir() }),
        annotate,
        inspector,
        emulation,
        agent: ops,
      },
      saveDropImage: async () => {
        if (fakeDrops) return saveImage({ png: FAKE_DROP_PNG, dir: dropsDir() });
        // Есть текст — вставляется текст (спека 8.5): рендерер это уже проверил, main — для надёжности.
        if ((await clipboard.readText()) !== '') return null;
        return saveImage({ png: await clipboardPng(), dir: dropsDir() });
      },
      saveDiagnostics: (options) =>
        saveDiagnostics(
          {
            call: (method, params) => connection.call(method, params),
            recentCalls: () => connection.recentCalls(),
            hostDir: paths.dir,
            // Тесты и E2E подменяют каталог, чтобы не писать в настоящие Downloads человека.
            outDir: process.env.PARLEY_DIAGNOSTICS_DIR ?? app.getPath('downloads'),
            appInfo: () => ({
              appVersion,
              electron: process.versions.electron,
              chrome: process.versions.chrome,
              node: process.versions.node,
              platform: process.platform,
              release: os.release(),
              arch: process.arch,
              windows: BrowserWindow.getAllWindows().length,
              uptimeSec: Math.round(process.uptime()),
              host: {
                state: hostStatus.state,
                hostVersion: 'hostVersion' in hostStatus ? hostStatus.hostVersion : null,
              },
            }),
            readme: S.diagnostics.readme,
          },
          options,
        ),
      imageThumbnail: (absPath, maxPx) => imageThumbnail(absPath, nativeImage, maxPx),
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
      chooseFiles: async () => {
        const window = mainWindow;
        const options = { properties: ['openFile', 'multiSelections'] } satisfies Electron.OpenDialogOptions;
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      },
      showNotification: (note) => notifier.notify(note),
      takeFocusTarget: () => pendingFocusTarget.take(),
      getUpdate: () => updates.latest(),
      // Только у собранного окна: несобранное (E2E, `pnpm dev`) отдало бы версию Electron, и любой хост
      // показался бы хостом другой сборки — с тостом поверх окна.
      appVersion,
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
    // Голосовой ввод (спека 2026-10-06-voice-input-design.md, 4.2): модели в ~/.parley/desktop/voice/models, движок —
    // Resources/whisper или build/whisper (dev). PARLEY_VOICE=fake (E2E) — подменные службы без движка и сети.
    const voiceServices = switches.voice
      ? createFakeVoiceServices(envValue(process.env, 'VOICE_TEXT') ?? 'hello from voice')
      : createVoiceServices({
          models: createModelStore({ dir: voiceModelsDir(), fetch: (url, init) => net.fetch(url, init), freeBytes }),
          engine: () =>
            resolveEngine({
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              devDir: path.resolve(dirname, '../../build/whisper', `darwin-${process.arch}`),
              pathEnv: shellEnv.env.PATH,
              isFile: isFileSync,
            }),
          mic: {
            status: () => normalizeMicStatus(systemPreferences.getMediaAccessStatus('microphone')),
            request: () => systemPreferences.askForMediaAccess('microphone'),
            openSettings: async () => {
              if (logShell) shellLog.push({ action: 'openExternal', url: MIC_SETTINGS_URL });
              else await shell.openExternal(MIC_SETTINGS_URL);
            },
          },
          log: (message) => console.warn('[parley] voice', message),
        });
    registerVoiceIpc({ ipcMain, services: voiceServices });
    void removeStaleRecordings(tmpdir());
    createAppMenu(() => mainWindow);

    // Последним: к первому ответу GitHub обработчики каналов уже стоят.
    updates.start();

    // Клик по уведомлению без окон: macOS может прислать `activate` раньше клика. Окно
    // тогда создаёт этот обработчик, а цель клика ждёт его загрузки в отложенных.
    app.on('activate', () => {
      // Остров — тоже окно: «окон нет совсем» больше не значит «главного окна нет».
      if (mainWindow === null || mainWindow.isDestroyed()) {
        focusMainWindow();
      }
    });
  });

  // Хост — отдельный, отсоединённый процесс: закрытие окна его не трогает. Выход из приложения — другое дело:
  // его сторож (`guardAppQuit`) спрашивает и гасит хост.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Идущее распознавание не должно пережить приложение: `whisper-cli` — дочерний процесс окна, не хоста.
  app.on('before-quit', killRunningEngines);
  // Глобальное сочетание помощника не должно пережить приложение.
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
