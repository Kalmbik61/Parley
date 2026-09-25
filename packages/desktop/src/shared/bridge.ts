import type { EventData, EventName, MethodName, NotificationName, Params, Result } from '@harnas/protocol';

/** Состояние связи окна с хостом — источник для диалогов и строки статуса. */
export type HostStatus =
  | { state: 'connecting' }
  | { state: 'connected'; hostVersion: string }
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };

/** Действия меню приложения, приходящие в рендерер через `window.harnas.app.onMenu`. */
export type MenuAction =
  | 'new-session'
  | 'close-panel'
  | 'split-right'
  | 'split-down'
  | 'prev-panel'
  | 'next-panel'
  | 'palette'
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
  };
}

declare global {
  interface Window {
    harnas: HarnasBridge;
  }
}
