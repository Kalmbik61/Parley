/**
 * Список работ: старт — `works.list`, дальше живые изменения по `works.changed`
 * (кусок 1.10 плана окна). Хранилище держит последний снимок целиком — работ
 * немного, точечных патчей хост не присылает.
 */

import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import type { WorksSnapshot } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';

export interface WorksState {
  entries: WorkEntry[];
  branches: Record<string, string | null>;
  loading: boolean;
  error: string | null;
  /** Подписывается на бридж и один раз запрашивает `works.list`; возвращает отписку. */
  init: (bridge: HarnasBridge) => () => void;
}

export const useWorksStore = create<WorksState>((set) => ({
  entries: [],
  branches: {},
  loading: true,
  error: null,
  init: (bridge) => {
    let disposed = false;
    const apply = (snapshot: WorksSnapshot): void => {
      if (disposed) return;
      set({ entries: snapshot.entries, branches: snapshot.branches, loading: false, error: null });
    };

    bridge
      .call('works.list', {})
      .then(apply)
      .catch((err: unknown) => {
        if (disposed) return;
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      });

    const unsubscribe = bridge.on('works.changed', apply);
    return () => {
      disposed = true;
      unsubscribe();
    };
  },
}));

/** Работы по порядку создания — по нему идёт нумерация 1…9 в сайдбаре и ⌘1…⌘9. */
export function orderedWorks(entries: readonly WorkEntry[]): WorkEntry[] {
  return [...entries].sort((a, b) => a.map.work.createdAt.localeCompare(b.map.work.createdAt));
}
