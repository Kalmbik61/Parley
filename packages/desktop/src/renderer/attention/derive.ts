/**
 * Внимание сессий и работ (спека 7.1): где нужен человек. Порядок сайдбара
 * (`sidebar/sort.ts`) и значки карточек считаются отсюда, поэтому функции чистые.
 *
 * Человек — участник каждой комнаты, но в `room.members` не пишется, а
 * `recipientsOf` (`lib/mail-view.ts`) его вычитает. Непрочитанное человеком
 * поэтому считается здесь своими функциями, а не через `recipientsOf`.
 */

import type { Message, Room, SessionActivity, WorkEntry, WorkMap, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
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

/**
 * Ждёт ли комната решения человека (спека окна 2026-09-29, 2.7): в слоте `Room.proposal` лежит решение
 * ведущего. У комнаты карты до 2026-09-29 поля `proposal` нет вовсе — это «не ждёт», а не ошибка. Одно
 * правило на карточку (значок вопроса), строку комнаты, вкладку комнаты (`layout/tab-meta.ts`), ранг работы и
 * «следующую, где нужен ты»: своего выражения `proposal ?? null` рядом с ним писать не надо.
 */
export function roomAwaitsDecision(room: Room): boolean {
  return (room.proposal ?? null) !== null;
}

// Те же литералы, что `RETURNED_LETTER` и `ACCEPTED_LETTER` в `core/work/proposals.ts`: из core рендерер берёт только
// типы. Сходство держит страж `main/decision-letters-sync.test.ts`.
const RETURNED_LETTER = 'Returned for rework';
const ACCEPTED_LETTER = 'Decision accepted.';

/**
 * Последний ответ человека на решение комнаты — `Return for rework` (спека окна 2026-09-29, 1.10)? Слот `proposal`
 * после ответа пуст и не помнит, чем ответили, а факт ответа лежит в ленте: письмо человека ведущему — `Returned for
 * rework: …` или `Decision accepted.`. Решает самое позднее из двух: возврат, за которым решение приняли, следующее
 * решение «переделанным» не делает. Свои слова человека в комнате (без этих двух начал) в счёт не идут. Ленту читаем
 * в момент нового решения, а не ведём по снимкам окна: окно, открытое между возвратом и новым решением, тоже знает.
 */
export function roomDecisionReturned(map: WorkMap, roomId: string): boolean {
  const answer = map.messages.findLast(
    (message) =>
      message.roomId === roomId &&
      message.from === HUMAN &&
      (message.text.startsWith(RETURNED_LETTER) || message.text === ACCEPTED_LETTER),
  );
  return answer?.text.startsWith(RETURNED_LETTER) ?? false;
}

/**
 * Таблица спеки 7.1. `pendingCard` — в открытой ленте сессии есть карточка `pending` (план 2026-10-01,
 * кусок 4a, решение О): живая сессия с ней — «нужен ты», как `blocked`. Закрытой и спящей сессии
 * карточка внимания не даёт.
 */
export function sessionAttention(session: WorkSession, live: SessionActivity | null, pendingCard = false): Attention {
  if (session.lifecycle === 'closed') return 'off';
  // pending и sleeping: процесса нет, но сессия не закрыта.
  if (session.lifecycle !== 'active') return 'idle';
  if (pendingCard) return 'needs-you';
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

/**
 * Не прочитано человеком по правилам 3.2: письмо ему или сообщение комнаты, не от него, без
 * readBy.human. То же правило, что `unreadForHuman` в `core/work/letters.ts` (`mail.markRead`
 * хоста): иначе окно отправляло бы на отметку то, что хост не отметит, и наоборот.
 */
export function isHumanUnread(message: Message): boolean {
  return (
    message.from !== HUMAN &&
    message.readBy[HUMAN] === undefined &&
    (message.roomId !== null || message.to.includes(HUMAN))
  );
}

/** Прямые письма человеку (roomId === null) с isHumanUnread. */
export function humanUnreadLetters(map: WorkMap): Message[] {
  return map.messages.filter((message) => message.roomId === null && isHumanUnread(message));
}

/** Сообщения комнаты с isHumanUnread: человек — участник любой комнаты. */
export function roomUnreadForHuman(map: WorkMap, roomId: string): number {
  return map.messages.filter((message) => message.roomId === roomId && isHumanUnread(message)).length;
}

export interface WorkAttention {
  level: Attention;
  needsYou: number;                     // сессии в 'needs-you' и комнаты с ждущим решением (2.7)
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

const NO_PENDING_FEEDS: ReadonlySet<string> = new Set();

/**
 * `pendingFeeds` — `refKey` сессий, у которых в открытой ленте окна есть карточка `pending` (решение О
 * куска 4a). Лента закрытой вкладки окну неизвестна — такая карточка сюда не попадёт.
 */
export function workAttention(
  entry: WorkEntry,
  activity: Record<string, ActivityEntry>,
  pendingFeeds: ReadonlySet<string> = NO_PENDING_FEEDS,
): WorkAttention {
  const { map, projectPath } = entry;
  let level: Attention = 'off';
  let needsYou = 0;
  let unseen = 0;
  let lastEventAt = map.work.updatedAt;

  for (const session of map.sessions) {
    const key = refKey({ projectPath, workId: map.work.id, sessionId: session.id });
    const live = activity[key]?.activity ?? null;
    const own = sessionAttention(session, live, pendingFeeds.has(key));
    if (own === 'needs-you') needsYou += 1;
    if (own === 'unseen') unseen += 1;
    if (ATTENTION_RANK[own] > ATTENTION_RANK[level]) level = own;
    lastEventAt = later(lastEventAt, live?.lastEventAt ?? null);
  }

  for (const message of map.messages) lastEventAt = later(lastEventAt, message.at);

  // Комната с ждущим решением — «нужен ты», ранг 4, как blocked (спека окна 2026-09-29, 2.7): в счёт
  // «нужен ты» она входит наравне с сессией, иначе строка статуса молчала бы, а «следующая, где нужен
  // ты» вела бы туда, куда счётчик не зовёт.
  const decisions = map.rooms.filter(roomAwaitsDecision).length;
  if (decisions > 0) {
    needsYou += decisions;
    level = 'needs-you';
  }

  const humanUnread = humanUnreadLetters(map).length;
  // Письмо человеку — ранг 3 (2.7, как `workRank` прототипа): выше работающей и простаивающей работы,
  // ниже blocked и решения. Прежде оно поднимало работу до needs-you (спека Orca-UI 7.1). Комнаты — фон,
  // а не вызов: их непрочитанное уровень не поднимает.
  if (humanUnread > 0 && ATTENTION_RANK[level] < ATTENTION_RANK.unseen) level = 'unseen';

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
