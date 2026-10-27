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
import { earlierCursor, heldRanges, messageSeq } from '../lib/window-merge.js';
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
 * Страниц одной комнаты за одно дочитывание не больше. Страница — до сотни писем и 64 КиБ, поэтому потолок — не способ
 * «дочитать часть», а защита от бесконечного чтения: диапазон, не уложившийся в него, — сбой (`readDown` бросает).
 */
export const MAIL_PAGES_MAX = 20;

/** Одна страница `context.messages`; `null` — комнату или работу удалили, пока шли страницы: читать больше нечего, это не сбой. */
function readPage(
  bridge: Pick<ParleyBridge, 'call'>,
  entry: WindowWorkEntry,
  roomId: string | null,
  cursor: string | null,
): Promise<{ messages: Message[]; page: { complete: boolean; next: string | null } } | null> {
  return bridge
    .call('context.messages', { projectPath: entry.projectPath, workId: entry.map.work.id, roomId, ...(cursor === null ? {} : { cursor }) })
    .catch((error: unknown) => {
      if (decodeIpcError(error).code === 'not_found') return null;
      throw error;
    });
}

/**
 * Читает письма комнаты (или Mail при `roomId: null`) от вершины вниз, пока страница не дойдёт до номера `reach`: сначала без
 * курсора (самая новая страница), затем `before:` по `next`. Потолок страниц обрезает старый конец диапазона, а не вершину:
 * письма вершины и отметки на них доходят первыми. Каждая страница встаёт в карту свежими копиями; последняя может зацепить
 * письма ниже `reach` — они встают тоже. Не дошли за `MAIL_PAGES_MAX` страниц — бросает: вызывающий не должен считать окно
 * починенным (спека rooms.mail 6.5).
 */
async function readDown(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null, reach: number): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAIL_PAGES_MAX; page += 1) {
    const answer = await readPage(bridge, entry, roomId, cursor);
    if (answer === null) return;
    useWorksStore.getState().addMail(entry.projectPath, entry.map.work.id, answer.messages);
    const oldest = Math.min(...answer.messages.map(messageSeq));
    if (answer.page.complete || answer.page.next === null || oldest <= reach) return;
    cursor = answer.page.next;
  }
  throw new Error(`rooms.mail: ${roomId ?? 'direct letters'} not read down to m-${reach} within ${MAIL_PAGES_MAX} pages`);
}

/**
 * Окно держит комнату, но верх, до которого оно дошло, ниже `prevTop` события при совпавшей версии: письма между ними
 * потерялись. Читает от вершины вниз до наибольшего держимого номера (спека rooms.mail 6.5). Комнату без держимых писем не читает:
 * её письма окно возьмёт страницей при открытии. `entry` — карта до применения события, иначе верх уже сдвинут.
 */
export async function followRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readDown(bridge, entry, roomId, range.max);
}

/**
 * Перечитывает весь держимый диапазон комнаты — от вершины до наименьшего держимого номера, — чтобы обновить `readBy`
 * у каждого письма, а не только у новых: событие с признаком `reread` (потолок кадра, медленное окно, массовая отметка)
 * отметок не несёт.
 */
export async function rereadRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readDown(bridge, entry, roomId, range.min);
}

/**
 * Починка разрыва по версии работы (спека rooms.mail 6.5): держимый диапазон каждой держимой комнаты и Mail читается
 * от вершины вниз страницами `context.messages`. Сбой одной комнаты остальных не останавливает; первая ошибка уходит
 * вызывающему, и тот не считает окно починенным.
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
