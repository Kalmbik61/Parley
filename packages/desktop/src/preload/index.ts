import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EventMessage, EventName, MethodName, NotificationName } from '@parley/protocol';
import type { AppNote, CloseAnswer, FocusTarget, ParleyBridge, HostStatus, UpdateInfo } from '../shared/bridge.js';
import type { BrowserFavicon, BrowserOpenTab, PickResult } from '../shared/browser-types.js';
import type { ActionId } from '../shared/keybindings.js';
import type {
  DiffFile,
  DirEntry,
  FileChangedEvent,
  FileList,
  FileRoot,
  FileStat,
  GitStatusLetter,
  GrepQuery,
  GrepResult,
  Located,
  TextFile,
  TreeChangedEvent,
  WriteResult,
} from '../shared/files-types.js';
import type { WorkLayout } from '../shared/layout-types.js';
import type { NotesFile } from '../shared/notes-types.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';

const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
const statusListeners = new Set<(status: HostStatus) => void>();
const menuListeners = new Set<(id: ActionId) => void>();
const appearanceListeners = new Set<(dark: boolean) => void>();
const focusTargetListeners = new Set<(target: FocusTarget) => void>();
const fileChangedListeners = new Set<(e: FileChangedEvent) => void>();
const treeChangedListeners = new Set<(e: TreeChangedEvent) => void>();
const confirmCloseListeners = new Set<() => void>();
const browserOpenTabListeners = new Set<(e: BrowserOpenTab) => void>();
const browserFaviconListeners = new Set<(e: BrowserFavicon) => void>();
const browserFocusListeners = new Set<(e: { webContentsId: number }) => void>();
const windowFocusListeners = new Set<(focused: boolean) => void>();
const updateListeners = new Set<(info: UpdateInfo) => void>();
/** Цель клика, пришедшая, пока у `onFocusTarget` не было слушателей (кусок 4.3). */
let heldFocusTarget: FocusTarget | null = null;
/**
 * Последние статус хоста и тема: main шлёт их на `did-finish-load`, а страница подписывается в
 * эффекте React — уже после первой отрисовки. Пришедшее раньше подписки иначе терялось, и окно
 * навсегда оставалось на «Connecting to host…» (0.1.0, медленный старт под Rosetta). Подписчик
 * сразу получает последнее значение.
 */
let lastStatus: HostStatus | null = null;
let lastAppearance: boolean | null = null;

/**
 * Цель получают слушатели, подписанные в момент доставки, а не в момент запроса:
 * `StrictMode` в разработке подписывает эффект дважды, и ответ первого запроса иначе
 * достался бы уже отписанному. Слушателей нет — цель ждёт первого подписчика.
 */
function deliverFocusTarget(target: FocusTarget): void {
  if (focusTargetListeners.size === 0) {
    heldFocusTarget = target;
    return;
  }
  for (const listener of focusTargetListeners) listener(target);
}

ipcRenderer.on('host:event', (_event, message: EventMessage) => {
  const listeners = eventListeners.get(message.event);
  if (!listeners) return;
  for (const listener of listeners) listener(message.data);
});

ipcRenderer.on('host:status', (_event, status: HostStatus) => {
  lastStatus = status;
  for (const listener of statusListeners) listener(status);
});

ipcRenderer.on('menu:action', (_event, id: ActionId) => {
  for (const listener of menuListeners) listener(id);
});

ipcRenderer.on('app:appearance', (_event, dark: boolean) => {
  lastAppearance = dark;
  for (const listener of appearanceListeners) listener(dark);
});

ipcRenderer.on('app:focus-target', (_event, target: FocusTarget) => {
  deliverFocusTarget(target);
});

ipcRenderer.on('app:confirm-close', () => {
  for (const listener of confirmCloseListeners) listener();
});

ipcRenderer.on('files:changed', (_event, e: FileChangedEvent) => {
  for (const listener of fileChangedListeners) listener(e);
});

ipcRenderer.on('files:tree-changed', (_event, e: TreeChangedEvent) => {
  for (const listener of treeChangedListeners) listener(e);
});

ipcRenderer.on('browser:open-tab', (_event, e: BrowserOpenTab) => {
  for (const listener of browserOpenTabListeners) listener(e);
});

ipcRenderer.on('browser:favicon', (_event, e: BrowserFavicon) => {
  for (const listener of browserFaviconListeners) listener(e);
});

ipcRenderer.on('browser:focus', (_event, e: { webContentsId: number }) => {
  for (const listener of browserFocusListeners) listener(e);
});

ipcRenderer.on('app:window-focus', (_event, focused: boolean) => {
  for (const listener of windowFocusListeners) listener(focused);
});

ipcRenderer.on('app:update-available', (_event, info: UpdateInfo) => {
  for (const listener of updateListeners) listener(info);
});

/**
 * Единственный выход рендерера наружу. Всё идёт через `ipcRenderer.invoke`/`send`
 * на белый список каналов, который проверяет `ipc.ts` в основном процессе —
 * рендерер не может позвать ничего произвольного, даже зная имя канала.
 */
// Реализация ниже нарочно нетипизирована по дженерику `M`: мост через IPC
// стирает связь между методом и его параметрами/результатом на границе
// процессов, а вызывающая сторона (`ParleyBridge`) типизирована как раз для
// того, чтобы эту связь вернуть на стороне рендерера.
const bridge = {
  call: (method: MethodName, params: unknown) => ipcRenderer.invoke('host:call', method, params),
  notify: (method: NotificationName, params: unknown) => {
    ipcRenderer.send('host:notify', method, params);
  },
  on: (event: EventName, listener: (data: unknown) => void) => {
    let set = eventListeners.get(event);
    if (!set) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(listener);
    return () => eventListeners.get(event)?.delete(listener);
  },
  onStatus: (listener: (status: HostStatus) => void) => {
    statusListeners.add(listener);
    if (lastStatus !== null) listener(lastStatus);
    return () => statusListeners.delete(listener);
  },
  activitySnapshot: () => ipcRenderer.invoke('host:activity-snapshot'),
  app: {
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
    notify: (note: AppNote) => {
      ipcRenderer.send('app:notify', note);
    },
    onFocusTarget: (listener: (target: FocusTarget) => void) => {
      focusTargetListeners.add(listener);
      if (heldFocusTarget !== null) {
        const target = heldFocusTarget;
        heldFocusTarget = null;
        listener(target);
      } else {
        // Цель, отложенная main, пока окно грузилось (клик при закрытом окне).
        void (ipcRenderer.invoke('app:take-focus-target') as Promise<FocusTarget | null>)
          .then((target) => {
            if (target !== null) deliverFocusTarget(target);
          })
          .catch(() => {});
      }
      return () => focusTargetListeners.delete(listener);
    },
    setBadge: (count: number) => {
      ipcRenderer.send('app:set-badge', count);
    },
    chooseFolder: () => ipcRenderer.invoke('app:choose-folder') as Promise<string | null>,
    chooseFiles: () => ipcRenderer.invoke('app:choose-files') as Promise<string[]>,
    version: () => ipcRenderer.invoke('app:version') as Promise<string | null>,
    restartHost: () => ipcRenderer.invoke('app:restart-host') as Promise<void>,
    reconnect: () => ipcRenderer.invoke('app:reconnect') as Promise<void>,
    loadLayout: (workKey: string) =>
      ipcRenderer.invoke('app:load-layout', workKey) as Promise<WorkLayout | null>,
    saveLayout: (workKey: string, layout: WorkLayout) =>
      ipcRenderer.invoke('app:save-layout', workKey, layout) as Promise<void>,
    removeLayout: (workKey: string) => ipcRenderer.invoke('app:remove-layout', workKey) as Promise<void>,
    retainLayouts: (workKeys: string[]) =>
      ipcRenderer.invoke('app:retain-layouts', workKeys) as Promise<void>,
    loadUi: () => ipcRenderer.invoke('app:load-ui') as Promise<UiFile>,
    saveUi: (patch: Partial<Omit<UiFile, 'version'>>) =>
      ipcRenderer.invoke('app:save-ui', patch) as Promise<UiFile>,
    loadNotes: (workKey: string, sessionId: string) =>
      ipcRenderer.invoke('app:load-notes', workKey, sessionId) as Promise<{ file: NotesFile; corruptedTo: string | null }>,
    saveNotes: (workKey: string, sessionId: string, notes: NotesFile) =>
      ipcRenderer.invoke('app:save-notes', workKey, sessionId, notes) as Promise<void>,
    setAppearance: (mode: Appearance) =>
      ipcRenderer.invoke('app:set-appearance', mode) as Promise<void>,
    onAppearance: (listener: (dark: boolean) => void) => {
      appearanceListeners.add(listener);
      if (lastAppearance !== null) listener(lastAppearance);
      return () => appearanceListeners.delete(listener);
    },
    // Синхронно: окно ставит `.dark` до первого кадра React, без белой вспышки (спека 4.7).
    isDark: () => ipcRenderer.sendSync('app:is-dark') === true,
    onMenu: (listener: (id: ActionId) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    },
    onWindowFocus: (listener: (focused: boolean) => void) => {
      windowFocusListeners.add(listener);
      return () => windowFocusListeners.delete(listener);
    },
    titlebarDoubleClick: () => {
      ipcRenderer.send('app:titlebar-double-click');
    },
    revealWork: (projectPath: string, workId: string) =>
      ipcRenderer.invoke('app:reveal-work', projectPath, workId) as Promise<void>,
    openPath: (absPath: string) => ipcRenderer.invoke('app:open-path', absPath) as Promise<'opened' | 'revealed'>,
    showInFinder: (absPath: string) => ipcRenderer.invoke('app:show-in-finder', absPath) as Promise<void>,
    paste: () => {
      ipcRenderer.send('app:paste');
    },
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    saveDropImage: (source: 'clipboard') =>
      ipcRenderer.invoke('app:save-drop-image', source) as Promise<string | null>,
    imageThumbnail: (path: string) => ipcRenderer.invoke('app:image-thumbnail', path) as Promise<string | null>,
    setDirtyBuffers: (count: number) => {
      ipcRenderer.send('app:dirty-buffers', count);
    },
    onConfirmClose: (listener: () => void) => {
      confirmCloseListeners.add(listener);
      return () => confirmCloseListeners.delete(listener);
    },
    answerClose: (answer: CloseAnswer) => {
      ipcRenderer.send('app:close-answer', answer);
    },
    onUpdateAvailable: (listener: (info: UpdateInfo) => void) => {
      updateListeners.add(listener);
      // Найденное до подписки (окно ещё грузилось или показывало «Connecting…»); отписавшемуся ответ не нужен.
      void (ipcRenderer.invoke('app:get-update') as Promise<UpdateInfo | null>)
        .then((info) => {
          if (info !== null && updateListeners.has(listener)) listener(info);
        })
        .catch(() => {});
      return () => updateListeners.delete(listener);
    },
  },
  files: {
    stat: (root: FileRoot, paths: string[]) =>
      ipcRenderer.invoke('files:stat', root, paths) as Promise<Array<FileStat | null>>,
    locate: (workKey: string, absPaths: string[]) =>
      ipcRenderer.invoke('files:locate', workKey, absPaths) as Promise<Array<Located | null>>,
    list: (root: FileRoot, dir: string) => ipcRenderer.invoke('files:list', root, dir) as Promise<DirEntry[]>,
    readText: (root: FileRoot, path: string) => ipcRenderer.invoke('files:read-text', root, path) as Promise<TextFile>,
    readBytes: (root: FileRoot, path: string, limit?: number) =>
      ipcRenderer.invoke('files:read-bytes', root, path, limit) as Promise<Uint8Array>,
    write: (root: FileRoot, path: string, text: string, expectedMtimeMs: number | null) =>
      ipcRenderer.invoke('files:write', root, path, text, expectedMtimeMs) as Promise<WriteResult>,
    watch: (root: FileRoot, path: string) => ipcRenderer.invoke('files:watch', root, path) as Promise<string>,
    unwatch: (id: string) => ipcRenderer.invoke('files:unwatch', id) as Promise<void>,
    onChanged: (listener: (e: FileChangedEvent) => void) => {
      fileChangedListeners.add(listener);
      return () => fileChangedListeners.delete(listener);
    },
    onTreeChanged: (listener: (e: TreeChangedEvent) => void) => {
      treeChangedListeners.add(listener);
      return () => treeChangedListeners.delete(listener);
    },
    lsFiles: (root: FileRoot) => ipcRenderer.invoke('files:ls-files', root) as Promise<FileList>,
    grep: (root: FileRoot, query: GrepQuery, signalId: string) =>
      ipcRenderer.invoke('files:grep', root, query, signalId) as Promise<GrepResult>,
    cancel: (signalId: string) => ipcRenderer.invoke('files:cancel', signalId) as Promise<void>,
    gitShow: (root: FileRoot, rev: string, path: string) =>
      ipcRenderer.invoke('files:git-show', root, rev, path) as Promise<TextFile | null>,
    gitCommitFiles: (root: FileRoot, hash: string) =>
      ipcRenderer.invoke('files:git-commit-files', root, hash) as Promise<DiffFile[]>,
    gitStatus: (root: FileRoot) =>
      ipcRenderer.invoke('files:git-status', root) as Promise<Record<string, GitStatusLetter>>,
  },
  browser: {
    openDevTools: (webContentsId: number) => ipcRenderer.invoke('browser:open-devtools', webContentsId) as Promise<void>,
    find: (webContentsId: number, text: string, forward: boolean) =>
      ipcRenderer.invoke('browser:find', webContentsId, text, forward) as Promise<{ matches: number; active: number }>,
    stopFind: (webContentsId: number) => ipcRenderer.invoke('browser:stop-find', webContentsId) as Promise<void>,
    zoom: (webContentsId: number, step: 1 | -1 | 0) =>
      ipcRenderer.invoke('browser:zoom', webContentsId, step) as Promise<void>,
    clearData: () => ipcRenderer.invoke('browser:clear-data') as Promise<void>,
    pickStart: (webContentsId: number) =>
      ipcRenderer.invoke('browser:pick-start', webContentsId) as Promise<PickResult | null>,
    pickCancel: (webContentsId: number) => ipcRenderer.invoke('browser:pick-cancel', webContentsId) as Promise<void>,
    onOpenTab: (listener: (e: BrowserOpenTab) => void) => {
      browserOpenTabListeners.add(listener);
      return () => browserOpenTabListeners.delete(listener);
    },
    onFavicon: (listener: (e: BrowserFavicon) => void) => {
      browserFaviconListeners.add(listener);
      return () => browserFaviconListeners.delete(listener);
    },
    onFocus: (listener: (e: { webContentsId: number }) => void) => {
      browserFocusListeners.add(listener);
      return () => browserFocusListeners.delete(listener);
    },
  },
};

contextBridge.exposeInMainWorld('parley', bridge as unknown as ParleyBridge);
