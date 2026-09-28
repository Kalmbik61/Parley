/**
 * Список работ: старт — `works.list`, дальше живые изменения по `works.changed`
 * (кусок 1.10 плана окна). Хранилище держит последний снимок целиком — работ
 * немного, точечных патчей хост не присылает.
 */

import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import type { WorksSnapshot } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

/** Отказ `works.list`: код протокола и причина хоста (`works-unreadable`, раунд lane-r5). */
export interface WorksLoadError {
  code: string;
  reason: string | null;
}

export interface WorksState {
  entries: WorkEntry[];
  branches: Record<string, string | null>;
  /** Снимка работ ещё нет: `works.list` не ответил или отказал. */
  loading: boolean;
  error: WorksLoadError | null;
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
        // `loading` не снимается и прежний снимок не трогается (lane-r5): отказ — не пустой список.
        // Иначе «загружено, работ нет» стёрло бы сохранённые вкладки (retainLayouts первого снимка)
        // или закрыло вкладки работ при переподключении. Текст хоста (русский) — только в консоль.
        const info = decodeIpcError(err);
        console.warn('[harnas] works.list failed', info.message);
        set({ error: { code: info.code, reason: info.reason ?? null } });
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
