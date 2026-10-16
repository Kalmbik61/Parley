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
import { ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { EventData } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { hostFeatures } from '../lib/capabilities.js';
import { earlierCursor, messageSeq } from '../lib/window-merge.js';
import { useHostStore } from './host.js';
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
  /**
   * Подписка на `rooms.mail` (карта-журнал): хост с признаком `rooms-mail` не шлёт окну `works.changed` на каждое письмо,
   * и новые письма комнаты окно дочитывает хвостом `context.messages` само. Хост без признака шлёт письма снимком, как
   * прежде, — событие тогда не приходит, а пришедшее игнорируется. Возвращает отписку.
   */
  init: (bridge: Pick<ParleyBridge, 'call' | 'on'>) => () => void;
  loadEarlier: (bridge: ParleyBridge, entry: WorkEntry, roomId: string, apply: (messages: Message[]) => void) => Promise<void>;
}

const keyOf = (entry: WorkEntry, roomId: string): string => `${entry.projectPath}\u0000${entry.map.work.id}\u0000${roomId}`;

/** Страниц за одно событие не больше: письма, накопившиеся за долгий обрыв, добирает следующий снимок. */
const MAIL_PAGES_MAX = 5;

/** Дочитывание писем комнаты после последнего письма, которое окно уже держит. */
async function followMail(bridge: Pick<ParleyBridge, 'call'>, mail: EventData<'rooms.mail'>): Promise<void> {
  if (!hostFeatures(useHostStore.getState().status).has(ROOMS_MAIL_FEATURE)) return;
  const find = (): WorkEntry | undefined =>
    useWorksStore.getState().entries.find((entry) => entry.projectPath === mail.projectPath && entry.map.work.id === mail.workId);
  const first = find();
  if (first === undefined) return;
  let cursor: string | undefined;
  const held = first.map.messages.filter((message) => message.roomId === mail.roomId);
  if (held.length > 0) cursor = `after:${Math.max(...held.map(messageSeq))}`;
  for (let page = 0; page < MAIL_PAGES_MAX; page += 1) {
    const answer = await bridge.call('context.messages', {
      projectPath: mail.projectPath,
      workId: mail.workId,
      roomId: mail.roomId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    useWorksStore.getState().addMail(mail.projectPath, mail.workId, answer.messages);
    // Без курсора хост отдаёт самые новые письма, и «дальше» у такой страницы нет.
    if (cursor === undefined || answer.page.complete || answer.page.next === null) return;
    cursor = answer.page.next;
  }
}

export const useRoomPagesStore = create<RoomPagesState>((set, get) => ({
  init: (bridge) =>
    bridge.on('rooms.mail', (mail) => {
      void followMail(bridge, mail).catch((error: unknown) => console.warn('[parley] rooms.mail', error));
    }),
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
