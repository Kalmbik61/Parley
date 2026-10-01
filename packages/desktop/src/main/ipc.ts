import { METHODS, NOTIFICATIONS } from '@parley/protocol';
import type { MethodName, NotificationName, Result } from '@parley/protocol';
import type { BrowserWindow, IpcMain, NativeTheme, Session, WebContents } from 'electron';
import { clampNoteText } from '../shared/app-note.js';
import type { AppNote, CloseAnswer, FocusTarget, UpdateInfo } from '../shared/bridge.js';
import { encodeIpcError } from '../shared/ipc-error.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';
import { DropTooLargeError } from './drops.js';
import { HostError } from './host-connection.js';
import type { HostConnection } from './host-connection.js';
import { LayoutTooLargeError } from './layout-store.js';
import type { LayoutStore } from './layout-store.js';
import type { NotesStore } from './notes-store.js';
import { isNotesFile } from '../shared/notes-types.js';
import { isSessionId } from '../shared/work-keys.js';
import type { UiStore } from './ui-store.js';
import { openOrReveal, revealInFinder } from './files/open-path.js';
import { FilesDeniedError, type RootsRegistry } from './roots.js';
import type { createDesignMode } from './browser/design-mode.js';

/**
 * Оборачивает обработчик `ipcMain.handle`: сквозные правила плана («Окно»)
 * требуют, чтобы каждый из них бросал `encodeIpcError` — `HostError`
 * (протокольная ошибка хоста, дошедшая через `HostConnection.call`) несёт
 * свой код (`not_found`, `conflict`, …), всё остальное — общий `'failed'`.
 * Рендерер читает код через `decodeIpcError` и показывает `errorText(code,
 * action)`; исходное сообщение (текст хоста) — только
 * `console.warn` у вызывающей стороны, сюда оно попадает как есть.
 * `FilesDeniedError` (путь вне корней, кусок 5.2) — код `files:denied`: окно
 * показывает по нему `S.files.denied`. Экспорт — для каналов `files/ipc.ts`.
 */
export function withIpcError(
  handler: (event: unknown, ...args: unknown[]) => unknown,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      if (error instanceof HostError) {
        // data — ради `reason` (ошибки git куска 8.2a, `works-unreadable` lane-r5): по одному коду
        // их не различить.
        throw encodeIpcError({
          code: error.code,
          message: error.message,
          ...(error.data !== undefined ? { data: error.data } : {}),
        });
      }
      if (error instanceof FilesDeniedError) throw encodeIpcError({ code: error.code, message: error.message });
      if (error instanceof DropTooLargeError) throw encodeIpcError({ code: error.code, message: error.message });
      const message = error instanceof Error ? error.message : String(error);
      throw encodeIpcError({ code: 'failed', message });
    }
  };
}

const METHOD_NAMES = new Set<string>(Object.keys(METHODS));
const NOTIFICATION_NAMES = new Set<string>(Object.keys(NOTIFICATIONS));

export function isMethodName(value: string): value is MethodName {
  return METHOD_NAMES.has(value);
}

export function isNotificationName(value: string): value is NotificationName {
  return NOTIFICATION_NAMES.has(value);
}

/** Внешние ссылки открываются только по http/https — `file:` и `javascript:` наружу не пускаем. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'dark' || value === 'light';
}

/**
 * Ограничения `workKey` каналов раскладки (раунд исправлений 1, Important B):
 * непустая строка до 4096 символов (тот же предел, что план числит за
 * каналами заметок) и не одно из специальных имён свойств JS-объекта.
 * `layout-store.ts` теперь и сам не путает такие ключи со своим прототипом
 * (`Map` вместо `Record`), но этот канал — единственное место «проверки
 * аргументов» из сквозных правил, и должен отказывать им сам, defence-in-depth.
 */
const FORBIDDEN_WORK_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_WORK_KEY_LENGTH = 4096;

export function isValidWorkKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORK_KEY_LENGTH &&
    !FORBIDDEN_WORK_KEYS.has(value)
  );
}

/** Путь из рендерера (кусок 5.2): строка без NUL — иначе отказ ещё до диска. */
export function isValidPathArg(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFocusTarget(value: unknown): value is FocusTarget {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'session': {
      const ref = value.ref;
      return (
        isRecord(ref) &&
        typeof ref.projectPath === 'string' &&
        typeof ref.workId === 'string' &&
        typeof ref.sessionId === 'string'
      );
    }
    case 'mail':
      return typeof value.projectPath === 'string' && typeof value.workId === 'string';
    case 'room':
      return typeof value.projectPath === 'string' && typeof value.workId === 'string' && typeof value.roomId === 'string';
    default:
      return false;
  }
}

/** Форма `AppNote` из рендерера (кусок 4.3, спека 3.3): иначе main не покажет ничего. */
export function isAppNote(value: unknown): value is AppNote {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.silent === 'boolean' &&
    isFocusTarget(value.target)
  );
}

export interface RegisterIpcOptions {
  ipcMain: IpcMain;
  connection: HostConnection;
  openExternal: (url: string) => Promise<void>;
  chooseFolder: () => Promise<string | null>;
  /** Форму уже проверил и тексты обрезал `app:notify` (кусок 4.3). */
  showNotification: (note: AppNote) => void;
  /** Отложенная цель клика для окна, которое ещё грузилось (`app:take-focus-target`, кусок 4.3). */
  takeFocusTarget: () => FocusTarget | null;
  /** Релиз новее запущенной версии, найденный проверкой main (`app:get-update`, V6 плана релиза 0.1.0); `null` — нет или проверка выключена. */
  getUpdate: () => Promise<UpdateInfo | null>;
  /** Версия окна (`app.getVersion()`): страница сверяет с ней версию хоста (`app:version`, 0.2.0). */
  appVersion: string;
  /**
   * Окно сохранило `ui.json` (`app:save-ui`): main реагирует на смену настроек сразу — включённая проверка новой
   * версии идёт тут же (`main/update-check.ts`, `settingsChanged`). Вызывается после записи; не бросает.
   */
  onUiSaved?: () => void;
  setBadge: (count: number) => void;
  /** Раскладки работ, `layouts.json` (кусок 2.2 плана каркаса, спека 5.8). */
  layoutStore: LayoutStore;
  /** `ui.json` (кусок 1.1 плана окна, спека 3.4). */
  uiStore: UiStore;
  /** Заметки к диффу, `notes/<sha1(workKey)>/<sessionId>.json` (кусок 8.4a, спека 11.4). */
  notesStore: NotesStore;
  /** Меняет `nativeTheme.themeSource`; запись в `ui.json` — забота обработчика `app:set-appearance` ниже (спека 4.7). */
  setAppearance: (mode: Appearance) => void;
  /** `nativeTheme.shouldUseDarkColors` — источник истины темы окна (`app:is-dark`, раунд main-r2, п. 1). */
  isDark: () => boolean;
  /** Двойной клик по пустому месту заголовка (кусок 2.3, спека 5.1) — системное действие macOS. */
  titlebarDoubleClick: () => void;
  /** «Reveal in Finder» карточки работы (кусок 3.4) — `shell.showItemInFolder`. */
  showItemInFolder: (path: string) => void;
  /** Реестр корней файлов (кусок 5.2, спека 10.8): `app:open-path` и `app:show-in-finder` пускают только внутрь корней. */
  roots: RootsRegistry;
  /** `shell.openPath`: '' — успех, иначе текст ошибки. В тестах и E2E — подмена, настоящий открыл бы приложение. */
  openPath: (absPath: string) => Promise<string>;
  /** Картинка буфера → drops/ (main/index.ts: clipboard и saveImage); null — картинки нет или в буфере есть текст. */
  saveDropImage: () => Promise<string | null>;
  /** Число грязных буферов окна-отправителя (`app:dirty-buffers`, кусок 7.3a): main/window.ts#guardWindowClose. */
  setDirtyBuffers: (sender: WebContents, count: number) => void;
  /** Ответ окна-отправителя на `app:confirm-close` (`app:close-answer`, кусок 7.3a). */
  answerClose: (sender: WebContents, answer: CloseAnswer) => void;
  /** Мост встроенного браузера (кусок 9.1, спека 12.5). */
  browser: {
    /** webContents.fromId(id) ?? null; мост пускает только живого гостя webview раздела BROWSER_PARTITION. */
    fromId(id: number): WebContents | null;
    /** Сессия раздела BROWSER_PARTITION: clearData и сверка раздела гостя. */
    session: Pick<Session, 'clearStorageData' | 'clearCache'>;
    /** Выбор элемента Design Mode (кусок 9.3a, спека 12.3): main/browser/design-mode.ts#createDesignMode. */
    designMode: ReturnType<typeof createDesignMode>;
  };
}

/** Запрос поиска по странице — до 1000 символов (план, «Числа»). */
const MAX_FIND_TEXT = 1000;
/** Ответ browser.find — не дольше 2 с (план): found-in-page с finalUpdate может не прийти. */
const FIND_TIMEOUT_MS = 2000;

/**
 * Гость моста `browser:*`: целый id, живой, тип `webview`, раздел — наша сессия. Иначе
 * `bad_request`: DevTools главного окна и гостя чужого раздела рендерер не откроет.
 */
function browserGuest(browser: RegisterIpcOptions['browser'], id: unknown): WebContents {
  const contents = Number.isInteger(id) ? browser.fromId(id as number) : null;
  if (
    contents === null ||
    contents.isDestroyed() ||
    contents.getType() !== 'webview' ||
    contents.session !== (browser.session as unknown)
  ) {
    throw new HostError('bad_request', `not a browser guest: ${String(id)}`);
  }
  return contents;
}

/**
 * findInPage и ответ по found-in-page своего requestId с finalUpdate; без него через 2 с —
 * последний промежуточный результат или нули. Слушатель ставится до findInPage: событие может
 * прийти сразу.
 */
function findInGuest(
  guest: WebContents,
  text: string,
  options: { forward: boolean; findNext: boolean },
): Promise<{ matches: number; active: number }> {
  return new Promise((resolve) => {
    let requestId: number | null = null;
    let last = { matches: 0, active: 0 };
    const finish = (): void => {
      clearTimeout(timer);
      guest.off('found-in-page', onFound);
      resolve(last);
    };
    const onFound = (_event: unknown, result: Electron.Result): void => {
      if (result.requestId !== requestId) return;
      last = { matches: result.matches, active: result.activeMatchOrdinal };
      if (result.finalUpdate) finish();
    };
    const timer = setTimeout(finish, FIND_TIMEOUT_MS);
    guest.on('found-in-page', onFound);
    requestId = guest.findInPage(text, options);
  });
}

/**
 * Белый список IPC: рендерер не может позвать ничего, кроме методов и
 * уведомлений из `@parley/protocol`, и не может открыть ничего, кроме
 * http/https. Всё остальное (Node, произвольные каналы) ему недоступно —
 * `contextIsolation` и `sandbox` в `security.ts` это обеспечивают на уровне
 * процесса, а этот список — на уровне протокола.
 */
export function registerIpc(options: RegisterIpcOptions): void {
  const {
    ipcMain,
    connection,
    openExternal,
    chooseFolder,
    showNotification,
    takeFocusTarget,
    getUpdate,
    appVersion,
    onUiSaved,
    setBadge,
    layoutStore,
    uiStore,
    notesStore,
    setAppearance,
    isDark,
    titlebarDoubleClick,
    showItemInFolder,
    roots,
    openPath,
    saveDropImage,
    setDirtyBuffers,
    answerClose,
    browser,
  } = options;

  ipcMain.handle(
    'host:call',
    withIpcError(async (_event, method: unknown, params: unknown) => {
      if (typeof method !== 'string' || !isMethodName(method)) {
        throw new Error(`unknown method: ${String(method)}`);
      }
      return connection.call(method, params);
    }),
  );

  ipcMain.handle(
    'host:activity-snapshot',
    withIpcError(async () => connection.activitySnapshot()),
  );

  ipcMain.on('host:notify', (_event, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !isNotificationName(method)) return;
    connection.notify(method, params);
  });

  ipcMain.handle(
    'app:open-external',
    withIpcError(async (_event, url: unknown) => {
      if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
        throw new Error(`forbidden URL: ${String(url)}`);
      }
      await openExternal(url);
    }),
  );

  ipcMain.on('app:notify', (_event, note: unknown) => {
    // Неверная форма — тихий отказ: `send` ответа не ждёт, а показывать нечего.
    if (!isAppNote(note)) return;
    // Рендереру не верим и в длине (спека 15.2): режем так же, как окно.
    showNotification({ ...note, title: clampNoteText(note.title), body: clampNoteText(note.body) });
  });

  ipcMain.handle('app:take-focus-target', withIpcError(() => takeFocusTarget()));

  ipcMain.handle('app:get-update', withIpcError(() => getUpdate()));
  ipcMain.handle('app:version', withIpcError(async () => appVersion));

  ipcMain.on('app:set-badge', (_event, count: number) => {
    setBadge(count);
  });

  ipcMain.handle('app:choose-folder', withIpcError(() => chooseFolder()));

  ipcMain.handle('app:restart-host', withIpcError(() => connection.restartHost()));
  ipcMain.handle('app:reconnect', withIpcError(() => connection.connect()));

  ipcMain.handle(
    'app:load-layout',
    withIpcError(async (_event, workKey: unknown) => {
      if (!isValidWorkKey(workKey)) throw new Error(`invalid layout key: ${String(workKey)}`);
      return layoutStore.load(workKey);
    }),
  );

  ipcMain.handle(
    'app:save-layout',
    withIpcError(async (_event, workKey: unknown, layout: unknown) => {
      if (!isValidWorkKey(workKey)) throw new Error(`invalid layout key: ${String(workKey)}`);
      try {
        await layoutStore.save(workKey, layout);
      } catch (error) {
        // Раскладка больше лимита — план требует тихого предупреждения в
        // консоль main и успешного ответа: рендереру тут делать нечего, а
        // старый файл на диске уже сохранил сам `LayoutStore.save`.
        if (error instanceof LayoutTooLargeError) {
          console.warn(`[parley] ${error.message}`);
          return;
        }
        throw error;
      }
    }),
  );

  ipcMain.handle(
    'app:remove-layout',
    withIpcError(async (_event, workKey: unknown) => {
      if (!isValidWorkKey(workKey)) throw new Error(`invalid layout key: ${String(workKey)}`);
      return layoutStore.remove(workKey);
    }),
  );

  ipcMain.handle(
    'app:retain-layouts',
    withIpcError(async (_event, workKeys: unknown) => {
      // `async`, а не просто throw в обычной функции: подставной `ipcMain` теста
      // (`ipc.test.ts`), в отличие от настоящего Electron, не оборачивает
      // синхронный throw в отказ промиса сам — та же причина, что и у
      // `app:save-ui` выше.
      if (!Array.isArray(workKeys) || !workKeys.every(isValidWorkKey)) {
        throw new Error(`invalid layout key list: ${String(workKeys)}`);
      }
      return layoutStore.retain(workKeys);
    }),
  );

  /**
   * Каналы заметок (кусок 8.4a, спека 11.4 и 15.2): sessionId идёт в имя файла как есть, поэтому
   * только формат core — иначе `../..` из рендерера читал бы и писал JSON вне `notes/`. Отказ —
   * `bad_request`, до диска дело не доходит.
   */
  const checkNotesKeys = (workKey: unknown, sessionId: unknown): void => {
    if (!isValidWorkKey(workKey)) throw new HostError('bad_request', 'invalid notes work key');
    if (typeof sessionId !== 'string' || !isSessionId(sessionId)) {
      throw new HostError('bad_request', `invalid notes session id: ${String(sessionId)}`);
    }
  };

  ipcMain.handle(
    'app:load-notes',
    withIpcError(async (_event, workKey: unknown, sessionId: unknown) => {
      checkNotesKeys(workKey, sessionId);
      return notesStore.load(workKey as string, sessionId as string);
    }),
  );

  ipcMain.handle(
    'app:save-notes',
    withIpcError(async (_event, workKey: unknown, sessionId: unknown, notes: unknown) => {
      checkNotesKeys(workKey, sessionId);
      if (!isNotesFile(notes)) throw new HostError('bad_request', 'invalid notes file');
      await notesStore.save(workKey as string, sessionId as string, notes);
    }),
  );

  ipcMain.handle('app:load-ui', withIpcError((): Promise<UiFile> => uiStore.load()));

  ipcMain.handle(
    'app:save-ui',
    withIpcError(async (_event, patch: unknown) => {
      // `async`, а не просто `throw` в обычной функции: белый список каналов
      // проверяют тесты на подставном `ipcMain` (`ipc.test.ts`), а он, в отличие
      // от настоящего Electron, не оборачивает синхронный throw в отказ промиса
      // сам — так же устроен уже существующий `app:open-external` выше.
      // `Array.isArray` отдельно: `typeof [] === 'object'` (раунд исправлений 1,
      // находка I3/тест 14) — без неё массив проходил бы как патч.
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new Error(`invalid ui.json patch: ${String(patch)}`);
      }
      const saved = await uiStore.save(patch as Partial<Omit<UiFile, 'version'>>);
      onUiSaved?.();
      return saved;
    }),
  );

  ipcMain.handle(
    'app:set-appearance',
    withIpcError(async (_event, mode: unknown) => {
      if (!isAppearance(mode)) throw new Error(`invalid appearance mode: ${String(mode)}`);
      // Сначала диск, потом nativeTheme (раунд исправлений 1, находка I4/тест 14):
      // при отказе записи промис отклоняется и тема в окне не меняется — иначе
      // окно уже перекрасилось бы, а ui.json остался бы со старым значением, и
      // на следующем запуске тема «откатилась» бы без действия пользователя.
      await uiStore.save({ appearance: mode });
      setAppearance(mode);
    }),
  );

  // Начальная тёмность окна (раунд main-r2, п. 1): `sendSync` прелоада, до первого кадра.
  ipcMain.on('app:is-dark', (event) => {
    event.returnValue = isDark();
  });

  ipcMain.on('app:titlebar-double-click', () => {
    titlebarDoubleClick();
  });

  // «Paste» меню терминала (кусок 5.3): вставка родным путём окна — срабатывает то же событие
  // paste, что у ⌘V, и картинку из буфера ловит тот же обработчик (5.4). Только отправителю:
  // чужое окно вставку не получает.
  ipcMain.on('app:paste', (event) => {
    event.sender.paste();
  });

  // Скриншот из буфера (кусок 5.4, спека 8.5). Источник — только 'clipboard': путь или
  // байты картинки рендерер не передаёт, main сам читает буфер и сам выбирает имя в drops/.
  ipcMain.handle(
    'app:save-drop-image',
    withIpcError(async (_event, source: unknown) => {
      if (source !== 'clipboard') throw new HostError('bad_request', `invalid drop image source: ${String(source)}`);
      return saveDropImage();
    }),
  );

  // Вопрос при закрытии окна (кусок 7.3a). `send`, ответа не ждут: неверная форма — тихий отказ.
  // Число — целое от нуля: иначе рендерер мог бы навсегда запереть окно дробным или NaN.
  ipcMain.on('app:dirty-buffers', (event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
    setDirtyBuffers(event.sender, count);
  });

  ipcMain.on('app:close-answer', (event, answer: unknown) => {
    if (answer !== 'close' && answer !== 'cancel') return;
    answerClose(event.sender, answer);
  });

  ipcMain.handle(
    'app:reveal-work',
    withIpcError(async (_event, projectPath: unknown, workId: unknown) => {
      // Путь из рендерера в Finder не идёт как есть: показываем только папку проекта
      // работы, которую знает хост (кусок 3.4). Иначе рендерер открыл бы любой путь.
      const known =
        typeof projectPath === 'string' &&
        typeof workId === 'string' &&
        ((await connection.call('works.list', {})) as Result<'works.list'>).entries.some(
          (entry) => entry.projectPath === projectPath && entry.map.work.id === workId,
        );
      if (!known) throw new HostError('not_found', `work not found: ${String(projectPath)} ${String(workId)}`);
      showItemInFolder(projectPath);
    }),
  );

  ipcMain.handle(
    'app:open-path',
    withIpcError(async (_event, absPath: unknown) => {
      if (!isValidPathArg(absPath)) throw new HostError('bad_request', 'invalid path');
      return openOrReveal(absPath, { roots, openPath, showItemInFolder });
    }),
  );

  // Мост браузера (кусок 9.1, спека 12.5). Прежний текст поиска гостя: findNext — только у нового
  // текста. WeakMap — запись уходит вместе с гостем.
  const lastFindText = new WeakMap<WebContents, string>();

  ipcMain.handle(
    'browser:open-devtools',
    withIpcError(async (_event, id: unknown) => {
      browserGuest(browser, id).openDevTools();
    }),
  );

  ipcMain.handle(
    'browser:find',
    withIpcError(async (_event, id: unknown, text: unknown, forward: unknown) => {
      const guest = browserGuest(browser, id);
      if (typeof text !== 'string' || text.length > MAX_FIND_TEXT || typeof forward !== 'boolean') {
        throw new HostError('bad_request', 'invalid find request');
      }
      // Пустой запрос Electron не ищет — ответ без поиска; сброс подсветки — stopFind.
      if (text === '') return { matches: 0, active: 0 };
      const findNext = lastFindText.get(guest) !== text;
      lastFindText.set(guest, text);
      return findInGuest(guest, text, { forward, findNext });
    }),
  );

  ipcMain.handle(
    'browser:stop-find',
    withIpcError(async (_event, id: unknown) => {
      const guest = browserGuest(browser, id);
      lastFindText.delete(guest);
      guest.stopFindInPage('clearSelection');
    }),
  );

  ipcMain.handle(
    'browser:zoom',
    withIpcError(async (_event, id: unknown, step: unknown) => {
      const guest = browserGuest(browser, id);
      if (step !== 1 && step !== -1 && step !== 0) throw new HostError('bad_request', `invalid zoom step: ${String(step)}`);
      guest.setZoomLevel(step === 0 ? 0 : guest.getZoomLevel() + step);
    }),
  );

  // Design Mode (кусок 9.3a): тот же страж гостя — главное окно и чужой раздел не выбирают.
  ipcMain.handle(
    'browser:pick-start',
    withIpcError(async (_event, id: unknown) => browser.designMode.start(browserGuest(browser, id).id)),
  );

  ipcMain.handle(
    'browser:pick-cancel',
    withIpcError(async (_event, id: unknown) => {
      await browser.designMode.cancel(browserGuest(browser, id).id);
    }),
  );

  ipcMain.handle(
    'browser:clear-data',
    withIpcError(async () => {
      await browser.session.clearStorageData();
      await browser.session.clearCache();
    }),
  );

  ipcMain.handle(
    'app:show-in-finder',
    withIpcError(async (_event, absPath: unknown) => {
      if (!isValidPathArg(absPath)) throw new HostError('bad_request', 'invalid path');
      await revealInFinder(absPath, { roots, showItemInFolder });
    }),
  );
}

/**
 * Прокидывает события и статус хоста в конкретное окно. Отдельно от
 * `registerIpc` и вызывается не раньше `did-finish-load`: `HostConnection.onStatus`
 * отдаёт текущий статус немедленно при подписке, а если подписаться до того,
 * как прелоад этого окна навесил свои слушатели `ipcRenderer.on`, самое первое
 * сообщение (обычно самое важное — «хост подключён») уйдёт в пустоту.
 */
export function forwardHostToWindow(
  connection: HostConnection,
  window: BrowserWindow,
): { dispose: () => void } {
  const unsubEvent = connection.onEvent((message) => {
    if (window.isDestroyed()) return;
    window.webContents.send('host:event', message);
  });
  const unsubStatus = connection.onStatus((status) => {
    if (window.isDestroyed()) return;
    window.webContents.send('host:status', status);
  });
  return {
    dispose: () => {
      unsubEvent();
      unsubStatus();
    },
  };
}

/**
 * `forwardHostToWindow` на каждую загрузку страницы окна (fix-7.3 п. 4а): перезагрузка — новая
 * страница, её стор связи снова `connecting`, а статус хоста main слал только первой. Новая
 * подписка отдаёт текущий статус сразу (`onStatus`), прежняя снимается — подписка одна.
 */
export function forwardHostToPages(connection: HostConnection, window: BrowserWindow): void {
  let current: { dispose: () => void } | null = null;
  window.webContents.on('did-finish-load', () => {
    current?.dispose();
    current = forwardHostToWindow(connection, window);
  });
  window.on('closed', () => {
    current?.dispose();
    current = null;
  });
}

/**
 * Смена системной темы (спека 4.7): `nativeTheme.on('updated')` шлёт окну
 * текущую тёмность. Сам выбор темы (`system`/`dark`/`light`) уже осел в
 * `nativeTheme.themeSource` через `app:set-appearance` — рендереру остаётся
 * только переставить `.dark` по факту.
 */
export function forwardAppearanceToWindow(
  nativeTheme: NativeTheme,
  window: BrowserWindow,
): { dispose: () => void } {
  const send = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send('app:appearance', nativeTheme.shouldUseDarkColors);
  };
  nativeTheme.on('updated', send);
  return { dispose: () => nativeTheme.off('updated', send) };
}
