import type {
  EventData,
  EventName,
  MethodName,
  NotificationName,
  Params,
  Result,
  SessionRef,
} from '@harnas/protocol';
import type { WorkLayout } from './layout-types.js';
import type { Appearance, UiFile } from './ui-types.js';

/** Состояние связи окна с хостом — источник для диалогов и строки статуса. */
export type HostStatus =
  | { state: 'connecting' }
  /** `methods: null` — хост до этапа 3: ответ `hello` без списка методов (спека 3.2). */
  | { state: 'connected'; hostVersion: string; methods: string[] | null }
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };

/**
 * Куда ведёт клик по уведомлению (спека 3.3, 7.4): вкладка сессии, почты или комнаты.
 * Main шлёт её окну событием `app:focus-target`; окну, которое ещё грузится, — через
 * отложенную (`app:take-focus-target`).
 */
export type FocusTarget =
  | { kind: 'session'; ref: SessionRef }
  | { kind: 'mail'; projectPath: string; workId: string }
  | { kind: 'room'; projectPath: string; workId: string; roomId: string };

/** Уведомление macOS (спека 3.3, 7.4): одно на тег — новое закрывает прежнее. */
export interface AppNote {
  title: string;
  body: string;
  tag: string;
  target: FocusTarget;
  silent: boolean;
}

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
  | 'history-back'
  | 'history-forward'
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
  /**
   * Последняя активность каждой сессии, которую main видел на текущем
   * подключении, — в том числе повтор хоста после `hello`, пришедший раньше
   * подписки рендерера (`main/host-connection.ts#activitySnapshot`).
   */
  activitySnapshot(): Promise<Array<EventData<'activity.changed'>>>;
  app: {
    openExternal(url: string): Promise<void>;
    notify(note: AppNote): void;
    /** При подписке отдаёт слушателю отложенную цель: сначала ту, что держит прелоад, иначе из app:take-focus-target. */
    onFocusTarget(listener: (target: FocusTarget) => void): () => void;
    setBadge(count: number): void;
    chooseFolder(): Promise<string | null>;
    restartHost(): Promise<void>;
    onMenu(listener: (action: MenuAction) => void): () => void;
    /**
     * Раскладка работы в `layouts.json` (`main/layout-store.ts`, формат v2 —
     * по одной `WorkLayout` на `workKey`, спека 5.8). Файл пишет не только
     * это окно, поэтому рендерер всё равно проверяет прочитанное
     * (`layout/tree.ts#parseWorkLayout`).
     */
    loadLayout(workKey: string): Promise<WorkLayout | null>;
    saveLayout(workKey: string, layout: WorkLayout): Promise<void>;
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
    /**
     * «Reveal in Finder» (кусок 3.4): main сверяет работу с `works.list` и показывает
     * папку проекта; незнакомая работа — отказ с кодом `not_found`.
     */
    revealWork(projectPath: string, workId: string): Promise<void>;
  };
}

declare global {
  interface Window {
    harnas: HarnasBridge;
  }
}
