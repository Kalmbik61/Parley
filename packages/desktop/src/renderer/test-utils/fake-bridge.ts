/**
 * Подставной `HarnasBridge` для тестов рендерера (кусок 1.10 плана окна: «тесты
 * идут на подставном HarnasBridge»). Настоящего `window.harnas` в jsdom нет —
 * этот объект его заменяет: `call` отвечает по заранее заданным обработчикам,
 * `emit*` имитирует события и статус, пришедшие от хоста.
 */

import type {
  EventData,
  EventName,
  MethodName,
  NotificationName,
  Params,
  Result,
} from '@harnas/protocol';
import type { AppNote, CloseAnswer, FocusTarget, HarnasBridge, HostStatus } from '../../shared/bridge.js';
import type { ActionId } from '../../shared/keybindings.js';
import type {
  DirEntry,
  FileChangedEvent,
  FileRoot,
  FileStat,
  GitStatusLetter,
  GrepQuery,
  GrepResult,
  Located,
  TextFile,
  TreeChangedEvent,
} from '../../shared/files-types.js';
import type { WorkLayout } from '../../shared/layout-types.js';
import type { IpcErrorInfo } from '../../shared/ipc-error.js';
import { rootKey } from '../../shared/work-keys.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { DEFAULT_UI, normalizeUi, type UiFile } from '../../shared/ui-types.js';

type Handler = (params: never) => unknown;

export interface FakeBridge extends HarnasBridge {
  /** Обработчик `call` для конкретного метода; без него `call` отклоняется. */
  setHandler<M extends MethodName>(
    method: M,
    handler: (params: Params<M>) => Result<M> | Promise<Result<M>>,
  ): void;
  /** Уведомления, отправленные наружу (`notify`), — для проверки, что дошло. */
  readonly notified: Array<{ method: NotificationName; params: unknown }>;
  /** Вызовы `call` — для проверки, что и с какими параметрами позвали. */
  readonly calls: Array<{ method: MethodName; params: unknown }>;
  emit<E extends EventName>(event: E, data: EventData<E>): void;
  emitStatus(status: HostStatus): void;
  /**
   * Методы хоста в статусе connected; null — хост до этапа 3. По умолчанию REQUIRED_METHODS.
   * Заново рассылает статус подписчикам onStatus, как emitStatus.
   */
  setHostMethods(methods: string[] | null): void;
  /** Что вернёт `activitySnapshot` — будто main запомнил эти события до подписки. */
  setActivitySnapshot(entries: Array<EventData<'activity.changed'>>): void;
  emitMenu(id: ActionId): void;
  readonly appNotified: AppNote[];
  /** Клик по уведомлению: событие `app:focus-target` слушателям `onFocusTarget` (кусок 4.3). */
  emitFocusTarget(target: FocusTarget): void;
  /** Отложенная цель main: первый подписчик onFocusTarget получает её сразу, как через app:take-focus-target. */
  setPendingFocusTarget(target: FocusTarget | null): void;
  readonly badges: number[];
  /** Вызовы `app.saveLayout` — для теста тишины 500 мс (кусок 2.2). */
  readonly layoutSaves: Array<{ workKey: string; layout: WorkLayout }>;
  /** Вызовы `app.removeLayout` — работа пропала из снимка (кусок 2.2, тест 6). */
  readonly layoutRemovals: string[];
  /** Вызовы `app.retainLayouts` — первый снимок после `worksLoaded` (кусок 2.2, тест 13). */
  readonly layoutRetains: string[][];
  /** Системная тёмность, будто бы её сообщил `nativeTheme.on('updated')` (кусок 1.1). */
  emitAppearance(dark: boolean): void;
  /** Ответ `app.isDark()` — тёмность `nativeTheme` main (раунд main-r2, п. 1). */
  setDark(dark: boolean): void;
  /** Журнал вызовов `app.titlebarDoubleClick` (кусок 2.3) — по одной записи на вызов. */
  readonly titlebarDoubleClicks: number[];
  /** Журнал вызовов `app.revealWork` (кусок 3.4). */
  readonly revealedWorks: Array<{ projectPath: string; workId: string }>;
  /** Чем ответит следующий `app.revealWork`: ошибка — отказ, `null` — успех. */
  setRevealWorkError(error: unknown): void;
  /** Ответ `files.locate` для пути в работе workKey; по умолчанию `null` на каждый путь (кусок 5.2). */
  setLocated(workKey: string, absPath: string, located: Located | null): void;
  /** Ответ `files.stat` для пути в корне; по умолчанию `null`. */
  setFileStat(root: FileRoot, path: string, stat: FileStat | null): void;
  /** Вызовы `files.locate` — пачки путей, как их отправил рендерер. */
  readonly locateCalls: Array<{ workKey: string; absPaths: string[] }>;
  /** Чем ответит `app.openPath`: `'opened'` (по умолчанию), `'revealed'` или ошибка — отказ. */
  setOpenPathResult(result: 'opened' | 'revealed' | { error: unknown }): void;
  /** Вызовы `app.openPath` и `app.showInFinder`. */
  readonly openedPaths: string[];
  readonly revealedPaths: string[];
  /** Вызовы `app.openExternal` (кусок 5.3). */
  readonly externalOpened: string[];
  /** Вызовы `app.paste` — по записи на вызов (кусок 5.3). */
  readonly pastes: number[];
  /** Ответ app.saveDropImage: путь, null (картинки нет) или отказ — объект с code, как отказы подставного моста (кусок 5.4). */
  setSaveDropImage(answer: string | null | IpcErrorInfo): void;
  readonly saveDropImageCalls: Array<'clipboard'>;
  /** Ответ `files.list`; по умолчанию `[]`. Отказ — объект с code (кусок 7.1a). */
  setDir(root: FileRoot, dir: string, entries: DirEntry[] | IpcErrorInfo): void;
  /** Ответ `files.readText`; по умолчанию отказ `not_found`. */
  setFile(root: FileRoot, path: string, file: TextFile | IpcErrorInfo): void;
  /** Ответ `files.readBytes`; по умолчанию отказ `not_found`. */
  setBytes(root: FileRoot, path: string, bytes: Uint8Array | IpcErrorInfo): void;
  /** Следующий write этого пути ответит conflict с этим mtimeMs; без него — ok с новым mtimeMs. */
  setWriteConflict(root: FileRoot, path: string, mtimeMs: number): void;
  /** Вызовы `files.write`, в том числе ответившие conflict. */
  readonly writes: Array<{ root: FileRoot; path: string; text: string; expectedMtimeMs: number | null }>;
  readonly readTextCalls: Array<{ root: FileRoot; path: string }>;
  /** Ответ `files.lsFiles` корня; по умолчанию `[]`. Отказ — объект с code (кусок 7.1b). */
  setLsFiles(root: FileRoot, paths: string[] | IpcErrorInfo): void;
  /** Ответ следующих `files.grep`; по умолчанию пусто. */
  setGrepResult(result: GrepResult | IpcErrorInfo): void;
  /** Ответ `files.gitStatus` корня; по умолчанию `{}`. */
  setGitStatus(root: FileRoot, status: Record<string, GitStatusLetter>): void;
  /** `watch` корня → отказ `files:watch-failed`. */
  setWatchFails(root: FileRoot): void;
  emitFileChanged(e: FileChangedEvent): void;
  emitTreeChanged(e: TreeChangedEvent): void;
  readonly grepCalls: Array<{ root: FileRoot; query: GrepQuery; signalId: string }>;
  readonly cancelCalls: string[];
  readonly watchCalls: Array<{ root: FileRoot; path: string; id: string }>;
  readonly unwatchCalls: string[];
  readonly lsFilesCalls: FileRoot[];
  readonly gitStatusCalls: FileRoot[];
  /** Вызовы `app.setDirtyBuffers` — число грязных буферов, как его получил бы main (кусок 7.3a). */
  readonly dirtyBufferCounts: number[];
  /** Main отложил закрытие окна: событие `app:confirm-close` слушателям `onConfirmClose`. */
  emitConfirmClose(): void;
  /** Вызовы `app.answerClose`. */
  readonly closeAnswers: CloseAnswer[];
}

export function createFakeBridge(): FakeBridge {
  const handlers = new Map<MethodName, Handler>();
  const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
  const statusListeners = new Set<(status: HostStatus) => void>();
  const menuListeners = new Set<(id: ActionId) => void>();
  const appearanceListeners = new Set<(dark: boolean) => void>();
  let dark = false;
  const notified: Array<{ method: NotificationName; params: unknown }> = [];
  const calls: Array<{ method: MethodName; params: unknown }> = [];
  const appNotified: AppNote[] = [];
  const focusTargetListeners = new Set<(target: FocusTarget) => void>();
  let pendingFocusTarget: FocusTarget | null = null;
  const badges: number[] = [];
  const layoutSaves: Array<{ workKey: string; layout: WorkLayout }> = [];
  const layoutRemovals: string[] = [];
  const layoutRetains: string[][] = [];
  const titlebarDoubleClicks: number[] = [];
  const revealedWorks: Array<{ projectPath: string; workId: string }> = [];
  let revealWorkError: unknown = null;
  const located = new Map<string, Located | null>();
  const fileStats = new Map<string, FileStat | null>();
  const locateCalls: Array<{ workKey: string; absPaths: string[] }> = [];
  let openPathResult: 'opened' | 'revealed' | { error: unknown } = 'opened';
  const openedPaths: string[] = [];
  const revealedPaths: string[] = [];
  const externalOpened: string[] = [];
  const pastes: number[] = [];
  let saveDropImageAnswer: string | null | IpcErrorInfo = null;
  const saveDropImageCalls: Array<'clipboard'> = [];
  const dirs = new Map<string, DirEntry[] | IpcErrorInfo>();
  const textFiles = new Map<string, TextFile | IpcErrorInfo>();
  const byteFiles = new Map<string, Uint8Array | IpcErrorInfo>();
  const writeConflicts = new Map<string, number>();
  const writes: Array<{ root: FileRoot; path: string; text: string; expectedMtimeMs: number | null }> = [];
  const readTextCalls: Array<{ root: FileRoot; path: string }> = [];
  const lsFilesAnswers = new Map<string, string[] | IpcErrorInfo>();
  let grepAnswer: GrepResult | IpcErrorInfo = { files: [], truncated: false };
  const gitStatuses = new Map<string, Record<string, GitStatusLetter>>();
  const watchFails = new Set<string>();
  const changedListeners = new Set<(e: FileChangedEvent) => void>();
  const treeListeners = new Set<(e: TreeChangedEvent) => void>();
  const grepCalls: Array<{ root: FileRoot; query: GrepQuery; signalId: string }> = [];
  const cancelCalls: string[] = [];
  const watchCalls: Array<{ root: FileRoot; path: string; id: string }> = [];
  const unwatchCalls: string[] = [];
  const lsFilesCalls: FileRoot[] = [];
  const gitStatusCalls: FileRoot[] = [];
  const dirtyBufferCounts: number[] = [];
  const confirmCloseListeners = new Set<() => void>();
  const closeAnswers: CloseAnswer[] = [];
  let watchSeq = 0;
  /** mtimeMs ответа write: растёт с каждой записью, как на диске. */
  let writeMtimeMs = 1_700_000_000_000;
  const fileKey = (root: FileRoot, path: string): string => `${rootKey(root)}\n${path}`;
  const notFound = (path: string): IpcErrorInfo => ({ code: 'not_found', message: `fake-bridge: no file ${path}` });
  const layouts = new Map<string, WorkLayout>();
  let status: HostStatus = {
    state: 'connected',
    hostVersion: '0.0.0-test',
    methods: [...REQUIRED_METHODS],
  };
  let ui: UiFile = DEFAULT_UI;
  let activitySnapshot: Array<EventData<'activity.changed'>> = [];

  const bridge: FakeBridge = {
    setHandler: (method, handler) => {
      handlers.set(method, handler as Handler);
    },
    notified,
    calls,
    appNotified,
    badges,
    layoutSaves,
    layoutRemovals,
    layoutRetains,
    titlebarDoubleClicks,
    revealedWorks,
    setRevealWorkError: (error) => {
      revealWorkError = error;
    },
    setLocated: (workKey, absPath, answer) => {
      located.set(`${workKey}\n${absPath}`, answer);
    },
    setFileStat: (root, path, stat) => {
      fileStats.set(`${rootKey(root)}\n${path}`, stat);
    },
    locateCalls,
    setOpenPathResult: (result) => {
      openPathResult = result;
    },
    openedPaths,
    revealedPaths,
    externalOpened,
    pastes,
    setSaveDropImage: (answer) => {
      saveDropImageAnswer = answer;
    },
    saveDropImageCalls,
    setDir: (root, dir, entries) => {
      dirs.set(fileKey(root, dir), entries);
    },
    setFile: (root, path, file) => {
      textFiles.set(fileKey(root, path), file);
    },
    setBytes: (root, path, bytes) => {
      byteFiles.set(fileKey(root, path), bytes);
    },
    setWriteConflict: (root, path, mtimeMs) => {
      writeConflicts.set(fileKey(root, path), mtimeMs);
    },
    writes,
    readTextCalls,
    setLsFiles: (root, paths) => {
      lsFilesAnswers.set(rootKey(root), paths);
    },
    setGrepResult: (result) => {
      grepAnswer = result;
    },
    setGitStatus: (root, status) => {
      gitStatuses.set(rootKey(root), status);
    },
    setWatchFails: (root) => {
      watchFails.add(rootKey(root));
    },
    emitFileChanged: (e) => {
      for (const listener of changedListeners) listener(e);
    },
    emitTreeChanged: (e) => {
      for (const listener of treeListeners) listener(e);
    },
    grepCalls,
    cancelCalls,
    watchCalls,
    unwatchCalls,
    lsFilesCalls,
    gitStatusCalls,
    dirtyBufferCounts,
    closeAnswers,
    emitConfirmClose: () => {
      for (const listener of confirmCloseListeners) listener();
    },
    files: {
      stat: async (root, paths) => paths.map((path) => fileStats.get(`${rootKey(root)}\n${path}`) ?? null),
      locate: async (workKey, absPaths) => {
        locateCalls.push({ workKey, absPaths: [...absPaths] });
        return absPaths.map((absPath) => located.get(`${workKey}\n${absPath}`) ?? null);
      },
      list: async (root, dir) => {
        const answer = dirs.get(fileKey(root, dir)) ?? [];
        if (!Array.isArray(answer)) throw answer;
        return answer.map((entry) => ({ ...entry }));
      },
      readText: async (root, path) => {
        readTextCalls.push({ root, path });
        const answer = textFiles.get(fileKey(root, path)) ?? notFound(path);
        if ('code' in answer) throw answer;
        return { ...answer };
      },
      readBytes: async (root, path) => {
        const answer = byteFiles.get(fileKey(root, path)) ?? notFound(path);
        if (!(answer instanceof Uint8Array)) throw answer;
        return answer.slice();
      },
      write: async (root, path, text, expectedMtimeMs) => {
        writes.push({ root, path, text, expectedMtimeMs });
        const key = fileKey(root, path);
        const conflict = writeConflicts.get(key);
        if (conflict !== undefined) {
          writeConflicts.delete(key);
          return { ok: false, conflict: { mtimeMs: conflict } };
        }
        writeMtimeMs += 1000;
        return { ok: true, mtimeMs: writeMtimeMs };
      },
      watch: async (root, path) => {
        if (path === '' && watchFails.has(rootKey(root))) {
          throw { code: 'files:watch-failed', message: 'fake-bridge: watch failed' } satisfies IpcErrorInfo;
        }
        watchSeq += 1;
        const id = `watch-${watchSeq}`;
        watchCalls.push({ root, path, id });
        return id;
      },
      unwatch: async (id) => {
        unwatchCalls.push(id);
      },
      onChanged: (listener) => {
        changedListeners.add(listener);
        return () => changedListeners.delete(listener);
      },
      onTreeChanged: (listener) => {
        treeListeners.add(listener);
        return () => treeListeners.delete(listener);
      },
      lsFiles: async (root) => {
        lsFilesCalls.push(root);
        const answer = lsFilesAnswers.get(rootKey(root)) ?? [];
        if (!Array.isArray(answer)) throw answer;
        return [...answer];
      },
      grep: async (root, query, signalId) => {
        grepCalls.push({ root, query: { ...query }, signalId });
        const answer = grepAnswer;
        if ('code' in answer) throw answer;
        return structuredClone(answer);
      },
      cancel: async (signalId) => {
        cancelCalls.push(signalId);
      },
      gitShow: async () => null,
      gitStatus: async (root) => {
        gitStatusCalls.push(root);
        return { ...(gitStatuses.get(rootKey(root)) ?? {}) };
      },
    },

    call: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`fake-bridge: нет обработчика для ${method}`);
      return handler(params as never) as never;
    },
    notify: (method, params) => {
      notified.push({ method, params });
    },
    on: (event, listener) => {
      let set = eventListeners.get(event);
      if (set === undefined) {
        set = new Set();
        eventListeners.set(event, set);
      }
      set.add(listener as (data: unknown) => void);
      return () => eventListeners.get(event)?.delete(listener as (data: unknown) => void);
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
    activitySnapshot: async () => [...activitySnapshot],
    setActivitySnapshot: (entries) => {
      activitySnapshot = [...entries];
    },
    app: {
      openExternal: async (url) => {
        externalOpened.push(url);
      },
      notify: (note) => {
        appNotified.push(note);
      },
      onFocusTarget: (listener) => {
        focusTargetListeners.add(listener);
        if (pendingFocusTarget !== null) {
          const target = pendingFocusTarget;
          pendingFocusTarget = null;
          listener(target);
        }
        return () => focusTargetListeners.delete(listener);
      },
      setBadge: (count) => {
        badges.push(count);
      },
      chooseFolder: async () => null,
      restartHost: async () => {},
      loadLayout: async (workKey) => layouts.get(workKey) ?? null,
      saveLayout: async (workKey, layout) => {
        layouts.set(workKey, layout);
        layoutSaves.push({ workKey, layout });
      },
      removeLayout: async (workKey) => {
        layouts.delete(workKey);
        layoutRemovals.push(workKey);
      },
      retainLayouts: async (workKeys) => {
        const keep = new Set(workKeys);
        for (const key of [...layouts.keys()]) {
          if (!keep.has(key)) layouts.delete(key);
        }
        layoutRetains.push([...workKeys]);
      },
      loadUi: async () => ui,
      saveUi: async (patch) => {
        ui = normalizeUi({ ...ui, ...patch });
        return ui;
      },
      setAppearance: async (mode) => {
        ui = { ...ui, appearance: mode };
      },
      onAppearance: (listener) => {
        appearanceListeners.add(listener);
        return () => appearanceListeners.delete(listener);
      },
      isDark: () => dark,
      onMenu: (listener) => {
        menuListeners.add(listener);
        return () => menuListeners.delete(listener);
      },
      titlebarDoubleClick: () => {
        titlebarDoubleClicks.push(titlebarDoubleClicks.length);
      },
      revealWork: async (projectPath, workId) => {
        revealedWorks.push({ projectPath, workId });
        if (revealWorkError !== null) throw revealWorkError;
      },
      openPath: async (absPath) => {
        openedPaths.push(absPath);
        if (typeof openPathResult === 'object') throw openPathResult.error;
        return openPathResult;
      },
      showInFinder: async (absPath) => {
        revealedPaths.push(absPath);
      },
      paste: () => {
        pastes.push(pastes.length);
      },
      // Подставной путь по имени файла: у `File` jsdom пути на диске нет (кусок 5.4).
      pathForFile: (file) => (file.name === '' ? '' : `/fake/${file.name}`),
      saveDropImage: async (source) => {
        saveDropImageCalls.push(source);
        const answer = saveDropImageAnswer;
        if (answer !== null && typeof answer === 'object') throw answer;
        return answer;
      },
      setDirtyBuffers: (count) => {
        dirtyBufferCounts.push(count);
      },
      onConfirmClose: (listener) => {
        confirmCloseListeners.add(listener);
        return () => confirmCloseListeners.delete(listener);
      },
      answerClose: (answer) => {
        closeAnswers.push(answer);
      },
    },

    emit: (event, data) => {
      for (const listener of eventListeners.get(event) ?? []) listener(data);
    },
    emitStatus: (next) => {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
    setHostMethods: (methods) => {
      bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods });
    },
    emitMenu: (id) => {
      for (const listener of menuListeners) listener(id);
    },
    emitFocusTarget: (target) => {
      for (const listener of focusTargetListeners) listener(target);
    },
    setPendingFocusTarget: (target) => {
      pendingFocusTarget = target;
    },
    emitAppearance: (next) => {
      for (const listener of appearanceListeners) listener(next);
    },
    setDark: (next) => {
      dark = next;
    },
  };

  return bridge;
}
