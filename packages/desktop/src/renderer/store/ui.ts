/**
 * Состояние самого окна: выбор в сайдбаре, фокус окна (нужен уведомлениям —
 * «сессия … не видна: она не выбрана или окно не в фокусе»), диалоги и пауза
 * будильника живых сессий (кусок 1.10 плана окна).
 *
 * `selectedRef`/`selectedWorkKey` с куска 2.1 плана окна больше не «единственная
 * открытая панель» (панелей теперь много, `Workspace.tsx`) — это адрес АКТИВНОЙ
 * панели сетки, если она терминальная; их выставляет сам `Workspace` по событию
 * dockview `onDidActivePanelChange`, а не сайдбар напрямую. Сайдбар и ⌘1…⌘9
 * по-прежнему читают их для подсветки и для «последней сессии работы».
 */

import { create } from 'zustand';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';

/** Сколько последних сессий держать для палитры ⌘K (кусок 2.3) — больше и не показать за один экран списка. */
const RECENT_SESSIONS_LIMIT = 20;

export interface DialogsState {
  newWork: boolean;
  newSession: { open: boolean; parentSessionId: string | null };
  settings: boolean;
}

const CLOSED_DIALOGS: DialogsState = {
  newWork: false,
  newSession: { open: false, parentSessionId: null },
  settings: false,
};

export interface UiState {
  selectedRef: SessionRef | null;
  /** Работа выбранной сессии — ключ `lib/tree-order.ts#workKey`. */
  selectedWorkKey: string | null;
  windowFocused: boolean;
  /** `null` — состояние будильника ещё не пришло с хоста. */
  wakePaused: boolean | null;
  dialogs: DialogsState;
  /** Последняя открытая сессия каждой работы: для ⌘1…⌘9 (кусок 1.11). */
  lastSessionByWork: Record<string, string>;
  /** id активной панели сетки (`lib/panel-id.ts#panelId`) — `null`, если панелей нет вовсе (кусок 2.1). */
  activePanelId: string | null;
  /**
   * Сессии, чья панель терминала сейчас видна (активная вкладка своей группы,
   * `@harnas/protocol#refKey`) — кусок 2.1, «Уведомления теперь считают
   * видимой сессию, у которой видна панель в сетке, а не выбранную в
   * сайдбаре». В отличие от `activePanelId` (панель ОДНА — с фокусом), видимых
   * панелей в сетке может быть несколько одновременно, по одной на группу.
   */
  visibleSessionRefs: Record<string, true>;
  /**
   * Последние выбранные сессии, самая свежая первой — палитра ⌘K показывает
   * их первыми при пустом запросе (кусок 2.3, спека 5.2). Пишется там же,
   * где и `lastSessionByWork` (`selectSession`, на каждую активацию панели
   * терминала в сетке), но это отдельный список: `lastSessionByWork` держит
   * только ПО ОДНОЙ сессии на работу, а тут нужен общий порядок по всем
   * работам сразу.
   */
  recentSessionRefs: readonly SessionRef[];

  selectSession: (workKey: string, ref: SessionRef) => void;
  /** `Workspace.tsx` зовёт на каждую смену активной панели dockview. */
  setActivePanelId: (id: string | null) => void;
  /** `panel-registry.tsx` зовёт при каждом `onDidActiveChange` панели терминала и при её закрытии. */
  setSessionVisible: (refKey: string, visible: boolean) => void;
  setWindowFocused: (focused: boolean) => void;
  openNewWorkDialog: () => void;
  closeNewWorkDialog: () => void;
  openNewSessionDialog: (parentSessionId: string | null) => void;
  closeNewSessionDialog: () => void;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
  toggleWake: (bridge: HarnasBridge) => Promise<void>;

  /** Подписывается на фокус окна и `wake.changed`, спрашивает `wake.state` разом; возвращает отписку. */
  init: (bridge: HarnasBridge) => () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  selectedRef: null,
  selectedWorkKey: null,
  windowFocused: typeof document === 'undefined' ? true : document.hasFocus(),
  wakePaused: null,
  dialogs: CLOSED_DIALOGS,
  lastSessionByWork: {},
  activePanelId: null,
  visibleSessionRefs: {},
  recentSessionRefs: [],

  selectSession: (workKey, ref) =>
    set((state) => {
      const key = refKey(ref);
      const withoutCurrent = state.recentSessionRefs.filter((item) => refKey(item) !== key);
      return {
        selectedRef: ref,
        selectedWorkKey: workKey,
        lastSessionByWork: { ...state.lastSessionByWork, [workKey]: ref.sessionId },
        recentSessionRefs: [ref, ...withoutCurrent].slice(0, RECENT_SESSIONS_LIMIT),
      };
    }),

  setActivePanelId: (id) => set({ activePanelId: id }),

  setSessionVisible: (key, visible) =>
    set((state) => {
      if (!visible) {
        if (!(key in state.visibleSessionRefs)) return state;
        const rest = Object.fromEntries(Object.entries(state.visibleSessionRefs).filter(([entryKey]) => entryKey !== key));
        return { visibleSessionRefs: rest };
      }
      return { visibleSessionRefs: { ...state.visibleSessionRefs, [key]: true } };
    }),

  setWindowFocused: (focused) => set({ windowFocused: focused }),

  openNewWorkDialog: () => set((state) => ({ dialogs: { ...state.dialogs, newWork: true } })),
  closeNewWorkDialog: () => set((state) => ({ dialogs: { ...state.dialogs, newWork: false } })),
  openNewSessionDialog: (parentSessionId) =>
    set((state) => ({ dialogs: { ...state.dialogs, newSession: { open: true, parentSessionId } } })),
  closeNewSessionDialog: () =>
    set((state) => ({ dialogs: { ...state.dialogs, newSession: { open: false, parentSessionId: null } } })),
  openSettingsDialog: () => set((state) => ({ dialogs: { ...state.dialogs, settings: true } })),
  closeSettingsDialog: () => set((state) => ({ dialogs: { ...state.dialogs, settings: false } })),

  toggleWake: async (bridge) => {
    const paused = get().wakePaused;
    const result = paused === true ? await bridge.call('wake.resume', {}) : await bridge.call('wake.pause', {});
    set({ wakePaused: result.paused });
  },

  init: (bridge) => {
    let disposed = false;
    bridge
      .call('wake.state', {})
      .then((result) => {
        if (!disposed) set({ wakePaused: result.paused });
      })
      .catch(() => {
        // Строка статуса просто не покажет состояние будильника — не повод падать.
      });
    const unsubscribeWake = bridge.on('wake.changed', ({ paused }) => set({ wakePaused: paused }));

    const onFocus = (): void => set({ windowFocused: true });
    const onBlur = (): void => set({ windowFocused: false });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      disposed = true;
      unsubscribeWake();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  },
}));
