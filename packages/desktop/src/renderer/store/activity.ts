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
  init: (bridge) => {
    // Сессии, чьё живое событие уже пришло после подписки: снимок main для них
    // не новее, и перетирать им живое значение нельзя.
    const live = new Set<string>();
    let disposed = false;
    const off = bridge.on('activity.changed', (entry) => {
      live.add(refKey(entry.ref));
      set((state) => ({ byRef: { ...state.byRef, [refKey(entry.ref)]: entry } }));
    });
    // Снимок — после подписки: повтор хоста после `hello` приходит раньше, чем
    // рендерер подписывается, и без снимка ждущая сессия была бы idle до
    // следующего события (раунд исправлений 1 куска 3.1).
    bridge
      .activitySnapshot()
      .then((entries) => {
        if (disposed) return;
        const fresh = entries.filter((entry) => !live.has(refKey(entry.ref)));
        if (fresh.length === 0) return;
        set((state) => ({
          byRef: {
            ...state.byRef,
            ...Object.fromEntries(fresh.map((entry) => [refKey(entry.ref), entry])),
          },
        }));
      })
      .catch(() => {
        // Без снимка остаются живые события — как до повтора активности.
      });
    return () => {
      disposed = true;
      off();
    };
  },
}));

export function activityFor(byRef: Record<string, ActivityEntry>, ref: SessionRef): ActivityEntry | null {
  return byRef[refKey(ref)] ?? null;
}
