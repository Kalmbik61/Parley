import { METHODS, NOTIFICATIONS } from '@harnas/protocol';
import type { MethodName, NotificationName } from '@harnas/protocol';
import type { BrowserWindow, IpcMain, NativeTheme } from 'electron';
import { clampNoteText } from '../shared/app-note.js';
import type { AppNote, FocusTarget } from '../shared/bridge.js';
import { encodeIpcError } from '../shared/ipc-error.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';
import { DropTooLargeError } from './drops.js';
import { HostError } from './host-connection.js';
import type { HostConnection } from './host-connection.js';
import { LayoutTooLargeError } from './layout-store.js';
import type { LayoutStore } from './layout-store.js';
import type { UiStore } from './ui-store.js';
import { openOrReveal, revealInFinder } from './files/open-path.js';
import { FilesDeniedError, type RootsRegistry } from './roots.js';

/**
 * Оборачивает обработчик `ipcMain.handle`: сквозные правила плана («Окно»)
 * требуют, чтобы каждый из них бросал `encodeIpcError` — `HostError`
 * (протокольная ошибка хоста, дошедшая через `HostConnection.call`) несёт
 * свой код (`not_found`, `conflict`, …), всё остальное — общий `'failed'`.
 * Рендерер читает код через `decodeIpcError` и показывает `errorText(code,
 * action)`; исходное сообщение (может быть русским текстом хоста) — только
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
      if (error instanceof HostError) throw encodeIpcError({ code: error.code, message: error.message });
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
  setBadge: (count: number) => void;
  /** Раскладки работ, `layouts.json` (кусок 2.2 плана каркаса, спека 5.8). */
  layoutStore: LayoutStore;
  /** `ui.json` (кусок 1.1 плана окна, спека 3.4). */
  uiStore: UiStore;
  /** Меняет `nativeTheme.themeSource`; запись в `ui.json` — забота обработчика `app:set-appearance` ниже (спека 4.7). */
  setAppearance: (mode: Appearance) => void;
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
}

/**
 * Белый список IPC: рендерер не может позвать ничего, кроме методов и
 * уведомлений из `@harnas/protocol`, и не может открыть ничего, кроме
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
    setBadge,
    layoutStore,
    uiStore,
    setAppearance,
    titlebarDoubleClick,
    showItemInFolder,
    roots,
    openPath,
    saveDropImage,
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

  ipcMain.on('app:set-badge', (_event, count: number) => {
    setBadge(count);
  });

  ipcMain.handle('app:choose-folder', withIpcError(() => chooseFolder()));

  ipcMain.handle('app:restart-host', withIpcError(() => connection.restartHost()));

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
          console.warn(`[harnas] ${error.message}`);
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
      return uiStore.save(patch as Partial<Omit<UiFile, 'version'>>);
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

  ipcMain.handle(
    'app:reveal-work',
    withIpcError(async (_event, projectPath: unknown, workId: unknown) => {
      // Путь из рендерера в Finder не идёт как есть: показываем только папку проекта
      // работы, которую знает хост (кусок 3.4). Иначе рендерер открыл бы любой путь.
      // Форма записи — своя: `@harnas/core` main не резолвит (шапка `shared/strings.ts`).
      const known =
        typeof projectPath === 'string' &&
        typeof workId === 'string' &&
        ((await connection.call('works.list', {})) as { entries: Array<{ projectPath: string; map: { work: { id: string } } }> }).entries.some(
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
