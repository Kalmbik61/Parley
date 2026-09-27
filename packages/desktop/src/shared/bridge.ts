import type {
  EventData,
  EventName,
  MethodName,
  NotificationName,
  Params,
  Result,
} from '@harnas/protocol';
import type { Appearance, UiFile } from './ui-types.js';

/** Состояние связи окна с хостом — источник для диалогов и строки статуса. */
export type HostStatus =
  | { state: 'connecting' }
  | { state: 'connected'; hostVersion: string }
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };

/** Действия меню приложения, приходящие в рендерер через `window.harnas.app.onMenu`. */
export type MenuAction =
  | 'new-session'
  | 'new-work'
  | 'close-panel'
  | 'reopen-tab'
  | 'split-right'
  | 'split-down'
  | 'prev-panel'
  | 'next-panel'
  | 'palette'
  | 'toggle-left-sidebar'
  | 'find'
  | 'settings'
  | `work-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/**
 * Единственный мост между рендерером и хостом. Рендерер не видит ни Node, ни
 * Electron напрямую — только это, отданное прелоадом через `contextBridge`.
 */
export interface HarnasBridge {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  notify<N extends NotificationName>(method: N, params: Params<N>): void;
  on<E extends EventName>(event: E, listener: (data: EventData<E>) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  app: {
    openExternal(url: string): Promise<void>;
    notify(note: { title: string; body: string }): void;
    setBadge(count: number): void;
    chooseFolder(): Promise<string | null>;
    restartHost(): Promise<void>;
    onMenu(listener: (action: MenuAction) => void): () => void;
    /**
     * `loadLayout`/`saveLayout` остаются на `unknown` до куска 2.7: ими же
     * прежний `Workspace` пишет раскладку dockview под ключом `window` в тот
     * же файл (`main/layout-store.ts`), который с этого куска хранит формат
     * v2 — по одной раскладке `WorkLayout` на `workKey` (спека 5.8).
     */
    loadLayout(workKey: string): Promise<unknown | null>;
    saveLayout(workKey: string, layout: unknown): Promise<void>;
    /** Работа исчезла из снимка — стирает её раскладку из `layouts.json` (спека 5.8). */
    removeLayout(workKey: string): Promise<void>;
    /** Первый снимок после старта: раскладки работ, которых в нём нет, стираются (спека 5.8). */
    retainLayouts(workKeys: string[]): Promise<void>;
    /** `ui.json` (кусок 1.1 плана окна, спека 3.4) — хранилище в `main/ui-store.ts`. */
    loadUi(): Promise<UiFile>;
    saveUi(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
    /** Меняет `nativeTheme.themeSource` в главном процессе и пишет `ui.json` (спека 4.7). */
    setAppearance(mode: Appearance): Promise<void>;
    /** Системная тёмность подхватывается при `nativeTheme.on('updated')` (спека 4.7). */
    onAppearance(listener: (dark: boolean) => void): () => void;
    /** Двойной клик по пустому месту заголовка (кусок 2.3, спека 5.1). */
    titlebarDoubleClick(): void;
  };
}

declare global {
  interface Window {
    harnas: HarnasBridge;
  }
}
