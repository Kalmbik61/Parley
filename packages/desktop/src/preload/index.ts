import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EventMessage, EventName, MethodName, NotificationName } from '@parley/protocol';
import type { AppNote, AssistantVoiceProgress, CloseAnswer, DiagnosticsSaveResult, FocusTarget, ParleyBridge, HostStatus, UpdateInfo } from '../shared/bridge.js';
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from '../shared/browser-devtools.js';
import type {
  AgentActivity,
  AgentResize,
  AgentOpenTab,
  AgentOpenTabResult,
  AgentPageRegistration,
  AnnotationPick,
  AnnotationPin,
  AnnotationPosition,
  BrowserFavicon,
  BrowserOpenTab,
  ContextInput,
  PickResult,
  SavedContext,
} from '../shared/browser-types.js';
import type { AssistantShortcutStatus, SessionVisibilityReport, TtsEngineState } from '../shared/island.js';
import type { AssistantVoice } from '../shared/tts-types.js';
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
import type { RecipeSaveRequest, RecipeSaveResult } from '../shared/recipe-save.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';
import type {
  DownloadProgress,
  DownloadResult,
  MicStatus,
  TranscribeRequest,
  TranscribeResult,
  VoiceModelId,
} from '../shared/voice-types.js';

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
const browserDevtoolsListeners = new Set<(batch: DevtoolsBatch) => void>();
const browserAgentOpenTabListeners = new Set<(e: AgentOpenTab) => void>();
const browserAgentActivityListeners = new Set<(e: AgentActivity) => void>();
const browserAgentResizeListeners = new Set<(e: AgentResize) => void>();
const windowFocusListeners = new Set<(focused: boolean) => void>();
const updateListeners = new Set<(info: UpdateInfo) => void>();
const voiceProgressListeners = new Set<(progress: DownloadProgress) => void>();
const assistantVoiceStateListeners = new Set<(state: TtsEngineState) => void>();
const assistantVoiceProgressListeners = new Set<(progress: AssistantVoiceProgress) => void>();
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

ipcRenderer.on('browser:devtools', (_event, batch: DevtoolsBatch) => {
  for (const listener of browserDevtoolsListeners) listener(batch);
});

ipcRenderer.on('browser:agent-open-tab', (_event, e: AgentOpenTab) => {
  for (const listener of browserAgentOpenTabListeners) listener(e);
});

ipcRenderer.on('browser:agent-activity', (_event, e: AgentActivity) => {
  for (const listener of browserAgentActivityListeners) listener(e);
});

ipcRenderer.on('browser:agent-resize', (_event, e: AgentResize) => {
  for (const listener of browserAgentResizeListeners) listener(e);
});

ipcRenderer.on('app:window-focus', (_event, focused: boolean) => {
  for (const listener of windowFocusListeners) listener(focused);
});

ipcRenderer.on('app:update-available', (_event, info: UpdateInfo) => {
  for (const listener of updateListeners) listener(info);
});

ipcRenderer.on('voice:progress', (_event, progress: DownloadProgress) => {
  for (const listener of voiceProgressListeners) listener(progress);
});

ipcRenderer.on('app:assistant-voice-state', (_event, state: TtsEngineState) => {
  for (const listener of assistantVoiceStateListeners) listener(state);
});

ipcRenderer.on('app:assistant-voice-progress', (_event, progress: AssistantVoiceProgress) => {
  for (const listener of assistantVoiceProgressListeners) listener(progress);
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
  noticesSnapshot: () => ipcRenderer.invoke('host:notices-snapshot'),
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
    reportSessionVisibility: (report: SessionVisibilityReport) => ipcRenderer.send('app:session-visibility', report),
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
    openAssistant: () => ipcRenderer.send('app:assistant-open'),
    assistantShortcut: () => ipcRenderer.invoke('app:assistant-shortcut') as Promise<AssistantShortcutStatus>,
    assistantShortcutSuspend: (on: boolean) => ipcRenderer.send('app:assistant-shortcut-suspend', on),
    islandShortcut: () => ipcRenderer.invoke('app:island-shortcut') as Promise<AssistantShortcutStatus>,
    islandShortcutSuspend: (on: boolean) => ipcRenderer.send('app:island-shortcut-suspend', on),
    assistantVoices: () => ipcRenderer.invoke('app:assistant-voices') as Promise<AssistantVoice[]>,
    assistantVoiceDownload: () => ipcRenderer.invoke('app:assistant-voice-download') as Promise<DownloadResult>,
    assistantVoiceCancel: () => ipcRenderer.invoke('app:assistant-voice-cancel') as Promise<void>,
    assistantVoiceRemove: () => ipcRenderer.invoke('app:assistant-voice-remove') as Promise<void>,
    assistantVoiceState: () => ipcRenderer.invoke('app:assistant-voice-state') as Promise<TtsEngineState>,
    onAssistantVoiceState: (listener: (state: TtsEngineState) => void) => {
      assistantVoiceStateListeners.add(listener);
      return () => assistantVoiceStateListeners.delete(listener);
    },
    onAssistantVoiceProgress: (listener: (progress: AssistantVoiceProgress) => void) => {
      assistantVoiceProgressListeners.add(listener);
      return () => assistantVoiceProgressListeners.delete(listener);
    },
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
    islandActive: () => ipcRenderer.sendSync('app:island-active') === true,
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
    openBacklog: (projectPath: string) => ipcRenderer.invoke('app:open-backlog', projectPath),
    openDecision: (projectPath: string, file: string) => ipcRenderer.invoke('app:open-decision', projectPath, file),
    openSharedFile: (projectPath: string, file: string) => ipcRenderer.invoke('app:open-shared-file', projectPath, file),
    parleyMd: (projectPath: string, create: boolean) =>
      ipcRenderer.invoke('app:parley-md', projectPath, create) as Promise<{ exists: boolean; created: boolean }>,
    saveRecipe: (request: RecipeSaveRequest) => ipcRenderer.invoke('app:save-recipe', request) as Promise<RecipeSaveResult>,
    saveDiagnostics: (options: { profile: boolean }) =>
      ipcRenderer.invoke('app:save-diagnostics', options) as Promise<DiagnosticsSaveResult>,
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
    imageThumbnail: (path: string, maxPx?: number) =>
      ipcRenderer.invoke('app:image-thumbnail', path, maxPx) as Promise<string | null>,
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
    saveContext: (input: ContextInput) => ipcRenderer.invoke('browser:save-context', input) as Promise<SavedContext>,
    annotateStart: (webContentsId: number) => ipcRenderer.invoke('browser:annotate-start', webContentsId) as Promise<AnnotationPick | null>,
    annotateCancel: (webContentsId: number) => ipcRenderer.invoke('browser:annotate-cancel', webContentsId) as Promise<void>,
    annotateSync: (webContentsId: number, pins: AnnotationPin[]) =>
      ipcRenderer.invoke('browser:annotate-sync', webContentsId, pins) as Promise<AnnotationPosition[]>,
    annotateCapture: (webContentsId: number) => ipcRenderer.invoke('browser:annotate-capture', webContentsId) as Promise<{ path: string | null }>,
    devtoolsSnapshot: (webContentsId: number) =>
      ipcRenderer.invoke('browser:devtools-snapshot', webContentsId) as Promise<DevtoolsSnapshot>,
    devtoolsClear: (webContentsId: number) => ipcRenderer.invoke('browser:devtools-clear', webContentsId) as Promise<void>,
    devtoolsReady: (webContentsId: number) => ipcRenderer.invoke('browser:devtools-ready', webContentsId) as Promise<void>,
    responseBody: (webContentsId: number, requestId: string) =>
      ipcRenderer.invoke('browser:response-body', webContentsId, requestId) as Promise<ResponseBody | null>,
    onDevtools: (listener: (batch: DevtoolsBatch) => void) => {
      browserDevtoolsListeners.add(listener);
      return () => browserDevtoolsListeners.delete(listener);
    },
    setViewport: (webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }) =>
      ipcRenderer.invoke('browser:set-viewport', webContentsId, spec, area) as Promise<{ scale: number }>,
    onAgentOpenTab: (listener: (e: AgentOpenTab) => void) => {
      browserAgentOpenTabListeners.add(listener);
      return () => browserAgentOpenTabListeners.delete(listener);
    },
    agentOpenTabResult: (requestId: string, result: AgentOpenTabResult) =>
      ipcRenderer.invoke('browser:agent-open-tab-result', requestId, result) as Promise<void>,
    registerTab: (e: AgentPageRegistration) => ipcRenderer.invoke('browser:register-tab', e) as Promise<void>,
    onAgentActivity: (listener: (e: AgentActivity) => void) => {
      browserAgentActivityListeners.add(listener);
      return () => browserAgentActivityListeners.delete(listener);
    },
    agentCaptureReady: (id: string) => ipcRenderer.invoke('browser:agent-capture-ready', id) as Promise<void>,
    onAgentResize: (listener: (e: AgentResize) => void) => {
      browserAgentResizeListeners.add(listener);
      return () => browserAgentResizeListeners.delete(listener);
    },
    agentStop: (webContentsId: number) => ipcRenderer.invoke('browser:agent-stop', webContentsId) as Promise<void>,
    agentFocusReady: (id: string, ok: boolean) => ipcRenderer.invoke('browser:agent-focus-ready', id, ok) as Promise<void>,
  },
  voice: {
    listModels: () => ipcRenderer.invoke('voice:list-models') as Promise<VoiceModelId[]>,
    downloadModel: (id: VoiceModelId) => ipcRenderer.invoke('voice:download-model', id) as Promise<DownloadResult>,
    cancelDownload: (id: VoiceModelId) => ipcRenderer.invoke('voice:cancel-download', id) as Promise<void>,
    removeModel: (id: VoiceModelId) => ipcRenderer.invoke('voice:remove-model', id) as Promise<void>,
    onProgress: (listener: (progress: DownloadProgress) => void) => {
      voiceProgressListeners.add(listener);
      return () => {
        voiceProgressListeners.delete(listener);
      };
    },
    transcribe: (request: TranscribeRequest) => ipcRenderer.invoke('voice:transcribe', request) as Promise<TranscribeResult>,
    micStatus: () => ipcRenderer.invoke('voice:mic-status') as Promise<MicStatus>,
    requestMic: () => ipcRenderer.invoke('voice:request-mic') as Promise<boolean>,
    openMicSettings: () => ipcRenderer.invoke('voice:open-mic-settings') as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('parley', bridge as unknown as ParleyBridge);
