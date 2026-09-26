/**
 * Живая активность сессий по `activity.changed` (кусок 1.10 плана окна).
 * Ключ — `refKey` из `@harnas/protocol`: один и тот же ключ нужен и здесь, и
 * в уведомлениях, и в счётчике бейджа.
 */

import { create } from 'zustand';
import { refKey, type EventData, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';

export type ActivityEntry = EventData<'activity.changed'>;

export interface ActivityState {
  byRef: Record<string, ActivityEntry>;
  /** Подписывается на `activity.changed`; возвращает отписку. */
  init: (bridge: HarnasBridge) => () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  byRef: {},
  init: (bridge) =>
    bridge.on('activity.changed', (entry) => {
      set((state) => ({ byRef: { ...state.byRef, [refKey(entry.ref)]: entry } }));
    }),
}));

export function activityFor(byRef: Record<string, ActivityEntry>, ref: SessionRef): ActivityEntry | null {
  return byRef[refKey(ref)] ?? null;
}
