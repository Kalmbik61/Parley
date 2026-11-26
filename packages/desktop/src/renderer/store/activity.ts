/**
 * Живая активность сессий по `activity.changed` (кусок 1.10 плана окна).
 * Ключ — `refKey` из `@parley/protocol`: один и тот же ключ нужен и здесь, и
 * в уведомлениях, и в счётчике бейджа.
 */

import { create } from 'zustand';
import { refKey, type EventData, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import type { IslandActivityEntry } from '../../shared/island.js';

export type ActivityEntry = EventData<'activity.changed'> & Pick<IslandActivityEntry, 'islandTasksTotal'>;

export interface ActivityState {
  byRef: Record<string, ActivityEntry>;
  /**
   * Снимок активности от main уже пришёл (или не удался): до этого `lastEventAt` сессий неизвестен,
   * и «стартовала ли сессия» решать рано (кусок 4a, решение М).
   */
  loaded: boolean;
  /** Подписывается на `activity.changed`; возвращает отписку. */
  init: (bridge: Pick<ParleyBridge, 'on' | 'onStatus' | 'activitySnapshot'>) => () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  byRef: {},
  loaded: false,
  init: (bridge) => {
    const live = new Set<string>();
    let connected = false;
    let connection = 0;
    const clearTerminalStatuses = (): void => set((state) => {
      let byRef = state.byRef;
      for (const [key, entry] of Object.entries(state.byRef)) {
        if (entry.terminalStatus == null) continue;
        if (byRef === state.byRef) byRef = { ...state.byRef };
        byRef[key] = { ...entry, terminalStatus: null };
      }
      return byRef === state.byRef ? state : { byRef };
    });
    clearTerminalStatuses();
    const off = bridge.on('activity.changed', (entry) => {
      // Events replayed during hello are available through the main snapshot once connected.
      if (!connected) return;
      const key = refKey(entry.ref);
      live.add(key);
      set((state) => ({ byRef: { ...state.byRef, [key]: entry } }));
    });
    const offStatus = bridge.onStatus(({ state }) => {
      const online = state === 'connected';
      if (online === connected) return;
      connected = online;
      const request = ++connection;
      live.clear();
      if (!online) {
        clearTerminalStatuses();
        return;
      }
      bridge.activitySnapshot().then((entries) => {
        if (request !== connection) return;
        const fresh = entries.filter((entry) => !live.has(refKey(entry.ref)));
        set((state) => ({
          loaded: true,
          byRef: {
            ...state.byRef,
            ...Object.fromEntries(fresh.map((entry) => [refKey(entry.ref), entry])),
          },
        }));
      }).catch(() => {
        if (request === connection) set({ loaded: true });
      });
    });
    return () => {
      ++connection;
      offStatus();
      off();
      clearTerminalStatuses();
    };
  },
}));

export function activityFor(byRef: Record<string, ActivityEntry>, ref: SessionRef): ActivityEntry | null {
  return byRef[refKey(ref)] ?? null;
}
