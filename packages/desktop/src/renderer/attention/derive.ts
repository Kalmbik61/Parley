/**
 * Внимание сессий и работ (спека 7.1): где нужен человек. Порядок сайдбара
 * (`sidebar/sort.ts`) и значки карточек считаются отсюда, поэтому функции чистые.
 *
 * Человек — участник каждой комнаты, но в `room.members` не пишется, а
 * `recipientsOf` (`lib/mail-view.ts`) его вычитает. Непрочитанное человеком
 * поэтому считается здесь своими функциями, а не через `recipientsOf`.
 */

import type { Message, SessionActivity, WorkEntry, WorkMap, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import { isoMs } from '../lib/iso-time.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts`: из core рендерер берёт только типы.
const HUMAN = 'human';

export type Attention = 'needs-you' | 'unseen' | 'working' | 'idle' | 'off';

export const ATTENTION_RANK: Record<Attention, 4 | 3 | 2 | 1 | 0> = {
  'needs-you': 4,
  unseen: 3,
  working: 2,
  idle: 1,
  off: 0,
};

/** Таблица спеки 7.1. */
export function sessionAttention(session: WorkSession, live: SessionActivity | null): Attention {
  if (session.lifecycle === 'closed') return 'off';
  // pending и sleeping: процесса нет, но сессия не закрыта.
  if (session.lifecycle !== 'active') return 'idle';
  switch (live?.activity ?? 'idle') {
    case 'blocked':
      return 'needs-you';
    case 'unseen':
      return 'unseen';
    case 'working':
      return 'working';
    default:
      return 'idle';
  }
}

/** Прямые письма человеку (roomId === null, to содержит 'human'), не от человека, без readBy.human. */
export function humanUnreadLetters(map: WorkMap): Message[] {
  return map.messages.filter(
    (message) =>
      message.roomId === null &&
      message.from !== HUMAN &&
      message.to.includes(HUMAN) &&
      message.readBy[HUMAN] === undefined,
  );
}

/** Сообщения комнаты не от человека без readBy.human: человек — участник любой комнаты. */
export function roomUnreadForHuman(map: WorkMap, roomId: string): number {
  return map.messages.filter(
    (message) => message.roomId === roomId && message.from !== HUMAN && message.readBy[HUMAN] === undefined,
  ).length;
}

export interface WorkAttention {
  level: Attention;
  needsYou: number;                     // сессии в 'needs-you'
  unseen: number;
  humanUnread: number;
  roomsUnread: Record<string, number>;  // только комнаты с непрочитанным
  lastEventAt: string;                  // max(lastEventAt сессий, work.updatedAt, at последнего письма)
}

/** Более позднее из двух времён; не-ISO время не обгоняет ничего. */
function later(a: string, b: string | null): string {
  if (b === null) return a;
  const tb = isoMs(b);
  if (tb === null) return a;
  const ta = isoMs(a);
  return ta === null || tb > ta ? b : a;
}

export function workAttention(entry: WorkEntry, activity: Record<string, ActivityEntry>): WorkAttention {
  const { map, projectPath } = entry;
  let level: Attention = 'off';
  let needsYou = 0;
  let unseen = 0;
  let lastEventAt = map.work.updatedAt;

  for (const session of map.sessions) {
    const live = activity[refKey({ projectPath, workId: map.work.id, sessionId: session.id })]?.activity ?? null;
    const own = sessionAttention(session, live);
    if (own === 'needs-you') needsYou += 1;
    if (own === 'unseen') unseen += 1;
    if (ATTENTION_RANK[own] > ATTENTION_RANK[level]) level = own;
    lastEventAt = later(lastEventAt, live?.lastEventAt ?? null);
  }

  for (const message of map.messages) lastEventAt = later(lastEventAt, message.at);

  const humanUnread = humanUnreadLetters(map).length;
  // Письмо человеку — вызов, а комнаты — фон: уровень поднимает только первое (спека 7.1).
  if (humanUnread > 0) level = 'needs-you';

  const roomsUnread: Record<string, number> = {};
  for (const room of map.rooms) {
    const count = roomUnreadForHuman(map, room.id);
    if (count > 0) roomsUnread[room.id] = count;
  }

  return { level, needsYou, unseen, humanUnread, roomsUnread, lastEventAt };
}

/**
 * Внимание работы из готового расчёта (ключ — workKey). Работе без расчёта (снимок работ
 * пришёл раньше) — `off` со временем карты: одно правило для порядка (`sidebar/sort.ts`) и
 * карточек (`sidebar/WorkSidebar.tsx`), раунд исправлений 1 куска 3.3.
 */
export function attentionOf(attention: Record<string, WorkAttention>, entry: WorkEntry): WorkAttention {
  return (
    attention[workKey(entry.projectPath, entry.map.work.id)] ?? {
      level: 'off',
      needsYou: 0,
      unseen: 0,
      humanUnread: 0,
      roomsUnread: {},
      lastEventAt: entry.map.work.updatedAt,
    }
  );
}

/** Два расчёта внимания работы совпадают по всем полям (комнаты — поштучно). */
export function sameWorkAttention(a: WorkAttention, b: WorkAttention): boolean {
  if (
    a.level !== b.level ||
    a.needsYou !== b.needsYou ||
    a.unseen !== b.unseen ||
    a.humanUnread !== b.humanUnread ||
    a.lastEventAt !== b.lastEventAt
  ) {
    return false;
  }
  const rooms = Object.keys(a.roomsUnread);
  return rooms.length === Object.keys(b.roomsUnread).length && rooms.every((id) => a.roomsUnread[id] === b.roomsUnread[id]);
}
