/**
 * Список работ: старт — `works.list`, дальше живые изменения по `works.changed`
 * (кусок 1.10 плана окна). Хранилище держит последний снимок целиком — работ
 * немного, точечных патчей хост не присылает.
 *
 * Снимок компактный (P35): письма комнаты — хвостом, старше — страницами (`addMessages`). Снимок несёт номер
 * `revision`, и применяется только новее уже применённого: поздно пришедший ответ `works.list` не откатывает
 * свежее событие. Номер считается от подключения — после переподключения (новый `init`) отсчёт начинается заново,
 * хост мог быть другим процессом. Письма, что окно уже показывало, а хвост сдвинулся, остаются (`retainSeen`).
 */

import { create } from 'zustand';
import type { Message, WindowWorkEntry } from '@parley/core';
import type { WorksSnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { retainSeen, withMessages } from '../lib/window-merge.js';

/** Отказ `works.list`: код протокола и причина хоста (`works-unreadable`, раунд lane-r5). */
export interface WorksLoadError {
  code: string;
  reason: string | null;
}

export interface WorksState {
  entries: WindowWorkEntry[];
  branches: Record<string, string | null>;
  /** Снимка работ ещё нет: `works.list` не ответил или отказал. */
  loading: boolean;
  /**
   * Хост ответил на `works.list`: снимок работ дочитан и сверен (ворота `worksReady`), методы снимка больше не ждут.
   * Рассылка `works.changed` приходит и до ворот, поэтому `loading: false` готовности хоста не означает.
   */
  ready: boolean;
  error: WorksLoadError | null;
  /** Подписывается на бридж и один раз запрашивает `works.list`; возвращает отписку. */
  init: (bridge: Pick<ParleyBridge, 'call' | 'on'>) => () => void;
  /** Письма, пришедшие страницей (`context.messages`), встают в карту работы по номеру. */
  addMessages: (projectPath: string, workId: string, messages: readonly Message[]) => void;
}

export const useWorksStore = create<WorksState>((set) => ({
  addMessages: (projectPath, workId, messages) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.projectPath === projectPath && entry.map.work.id === workId ? withMessages(entry, messages) : entry,
      ),
    })),
  entries: [],
  branches: {},
  loading: true,
  ready: false,
  error: null,
  init: (bridge) => {
    let disposed = false;
    let applied = -1;
    // Новое подключение — возможно, к только что запущенному хосту: готовность считается заново.
    set({ ready: false });
    const apply = (snapshot: WorksSnapshot): void => {
      if (disposed) return;
      // Хост до P35 номера не шлёт: его снимки применяются в порядке прихода, как прежде.
      if (snapshot.revision !== undefined) {
        if (snapshot.revision <= applied) return;
        applied = snapshot.revision;
      }
      set((state) => {
        const previous = new Map(state.entries.map((entry) => [`${entry.projectPath}\u0000${entry.map.work.id}`, entry]));
        return {
          entries: snapshot.entries.map((entry) => retainSeen(previous.get(`${entry.projectPath}\u0000${entry.map.work.id}`), entry)),
          branches: snapshot.branches,
          loading: false,
          error: null,
        };
      });
    };

    bridge
      .call('works.list', {})
      .then((snapshot) => {
        apply(snapshot);
        if (!disposed) set({ ready: true });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        // `loading` не снимается и прежний снимок не трогается (lane-r5): отказ — не пустой список.
        // Иначе «загружено, работ нет» стёрло бы сохранённые вкладки (retainLayouts первого снимка)
        // или закрыло вкладки работ при переподключении. Текст хоста — только в консоль.
        // Причина — `data.reason` ошибки хоста, как у ошибок git (8.2a).
        const info = decodeIpcError(err);
        const reason = info.data?.['reason'];
        console.warn('[parley] works.list failed', info.message);
        set({ error: { code: info.code, reason: typeof reason === 'string' ? reason : null } });
      });

    const unsubscribe = bridge.on('works.changed', apply);
    return () => {
      disposed = true;
      unsubscribe();
    };
  },
}));

/** Работы по порядку создания — по нему идёт нумерация 1…9 в сайдбаре и ⌘1…⌘9. */
export function orderedWorks(entries: readonly WindowWorkEntry[]): WindowWorkEntry[] {
  return [...entries].sort((a, b) => a.map.work.createdAt.localeCompare(b.map.work.createdAt));
}
