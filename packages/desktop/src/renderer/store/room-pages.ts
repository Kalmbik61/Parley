/**
 * История выбранной комнаты (P35): снимок работ несёт письма комнаты хвостом, а старше хвоста окно берёт страницами
 * `context.messages`. Хранилище помнит, докуда комната уже прочитана, и не даёт гнать два запроса сразу.
 *
 * Курсор цепочки — `next` последней страницы; цепочка сброшена, когда она дочитана, а окно всё ещё не держит всех
 * писем комнаты (хвост успел сдвинуться или в промежутке дыра): тогда следующий запрос начинается заново с курсора перед
 * хвостом из снимка (`earlierCursor`), а счётчик на кнопке остаётся честным (`earlierRemaining`: всего минус то, что держит окно).
 *
 * Здесь же — чтение страниц после разрыва `rooms.mail` (спека rooms.mail 6.5): `repairWork` перечитывает держимое окном
 * по всем комнатам и Mail, `followRoom` дочитывает комнату после её верха, `rereadRoom` — весь держимый диапазон комнаты.
 * Страницы встают в карту через `useWorksStore.addMail`; сам разрыв находит стор работ (`works.ts`).
 */

import { create } from 'zustand';
import type { Message, WindowWorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { earlierCursor, heldRanges } from '../lib/window-merge.js';
import { useWorksStore } from './works.js';

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
  loadEarlier: (bridge: ParleyBridge, entry: WindowWorkEntry, roomId: string, apply: (messages: Message[]) => void) => Promise<void>;
}

const keyOf = (entry: WindowWorkEntry, roomId: string): string => `${entry.projectPath}\u0000${entry.map.work.id}\u0000${roomId}`;

/**
 * Страниц одной комнаты за одно дочитывание не больше (сотня писем на страницу): письма, накопившиеся за долгий обрыв,
 * добирает следующий снимок или следующий разрыв (спека rooms.mail 6.5).
 */
export const MAIL_PAGES_MAX = 20;

/**
 * Страницы `context.messages` после номера `after` до вершины комнаты (или Mail при `roomId: null`); каждая встаёт в карту
 * свежими копиями. Комнату или работу, удалённые, пока шли страницы, не считаем сбоем: читать больше нечего.
 */
async function readAfter(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null, after: number): Promise<void> {
  let cursor = `after:${after}`;
  for (let page = 0; page < MAIL_PAGES_MAX; page += 1) {
    const answer = await bridge
      .call('context.messages', { projectPath: entry.projectPath, workId: entry.map.work.id, roomId, cursor })
      .catch((error: unknown) => {
        if (decodeIpcError(error).code === 'not_found') return null;
        throw error;
      });
    if (answer === null) return;
    useWorksStore.getState().addMail(entry.projectPath, entry.map.work.id, answer.messages);
    if (answer.page.complete || answer.page.next === null) return;
    cursor = answer.page.next;
  }
}

/**
 * Окно держит комнату, но верх, до которого оно дошло, ниже `prevTop` события при совпавшей версии: письма между ними
 * потерялись. Дочитывает `after:<наибольший держимый номер>` (спека rooms.mail 6.5). Комнату без держимых писем не читает:
 * её письма окно возьмёт страницей при открытии. `entry` — карта до применения события, иначе верх уже сдвинут.
 */
export async function followRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readAfter(bridge, entry, roomId, range.max);
}

/**
 * Перечитывает весь держимый диапазон комнаты — от наименьшего держимого номера до вершины, — чтобы обновить `readBy`
 * у каждого письма, а не только у новых: событие с признаком `reread` (потолок кадра, медленное окно, массовая отметка)
 * отметок не несёт. Номер курсора на единицу меньше наименьшего, чтобы страница вернула и это письмо.
 */
export async function rereadRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readAfter(bridge, entry, roomId, Math.max(0, range.min - 1));
}

/**
 * Починка разрыва по версии работы (спека rooms.mail 6.5): держимый диапазон каждой держимой комнаты и Mail читается
 * страницами `after:`. Сбой одной комнаты остальных не останавливает; первая ошибка уходит вызывающему, и тот не
 * считает окно починенным.
 */
export async function repairWork(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry): Promise<void> {
  let failure: { error: unknown } | null = null;
  for (const roomId of heldRanges(entry).keys()) {
    try {
      await rereadRoom(bridge, entry, roomId);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
}

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
