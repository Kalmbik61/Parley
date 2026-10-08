/**
 * История выбранной комнаты (P35): снимок работ несёт письма комнаты хвостом, а старше хвоста окно берёт страницами
 * `context.messages`. Хранилище помнит, докуда комната уже прочитана, и не даёт гнать два запроса сразу.
 *
 * Курсор цепочки — `next` последней страницы; цепочка сброшена, когда она дочитана, а окно всё ещё не держит всех
 * писем комнаты (хвост успел сдвинуться или в промежутке дыра): тогда следующий запрос начинается заново с курсора перед
 * хвостом из снимка (`earlierCursor`), а счётчик на кнопке остаётся честным (`earlierRemaining`: всего минус то, что держит окно).
 */

import { create } from 'zustand';
import type { Message, WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { earlierCursor } from '../lib/window-merge.js';

interface Chain {
  next: string | null;
  done: boolean;
}

export interface RoomPagesState {
  chains: Record<string, Chain>;
  loading: Record<string, boolean>;
  /**
   * Подгружает страницу писем старше уже имеющихся. `apply` получает письма синхронно, сразу по ответу, — до смены
   * состояния цепочки: панель успевает запомнить положение ленты. Ошибку хоста бросает наружу (вызывающий решает, что
   * показать); при ошибке цепочка не двигается.
   */
  loadEarlier: (bridge: ParleyBridge, entry: WorkEntry, roomId: string, apply: (messages: Message[]) => void) => Promise<void>;
}

const keyOf = (entry: WorkEntry, roomId: string): string => `${entry.projectPath}\u0000${entry.map.work.id}\u0000${roomId}`;

export const useRoomPagesStore = create<RoomPagesState>((set, get) => ({
  chains: {},
  loading: {},
  loadEarlier: async (bridge, entry, roomId, apply) => {
    const key = keyOf(entry, roomId);
    if (get().loading[key] === true) return;
    const chain = get().chains[key];
    const cursor = chain !== undefined && !chain.done ? chain.next : earlierCursor(entry, roomId);
    set((state) => ({ loading: { ...state.loading, [key]: true } }));
    try {
      const answer = await bridge.call('context.messages', {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId,
        ...(cursor === null || cursor === undefined ? {} : { cursor }),
      });
      apply(answer.messages);
      const next: Chain = answer.page.complete ? { next: null, done: true } : { next: answer.page.next, done: false };
      set((state) => ({ chains: { ...state.chains, [key]: next } }));
    } finally {
      set((state) => ({ loading: { ...state.loading, [key]: false } }));
    }
  },
}));
