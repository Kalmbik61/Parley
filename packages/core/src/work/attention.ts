/**
 * Внимание сессий и работ: где нужен человек. Чистые предикаты, которые окно и хост считают одинаково
 * (хост по ним решает, когда писать в Telegram). Раньше они жили в `desktop/renderer/attention/derive.ts`.
 *
 * Модуль чистый: ни Node-импортов, ни значений из других файлов core (только типы). Поэтому его берёт и окно через
 * подпуть `@parley/core/attention`, как `@parley/core/session-state`. Разбор `@human` по Markdown остался в окне:
 * упоминание распознаёт функция, которую передаёт вызывающий (`hasMention`); хосту без Markdown годится `plainHumanMention`.
 */

import type { SessionActivity } from './activity.js';
import type { SessionNeed } from './stuck.js';
import type { Message, Room, WindowWorkMap, WorkSession } from './types.js';

// Те же литералы, что `HUMAN` и `SYSTEM` в `types.ts`: значения не импортируем, чтобы модуль остался чистым.
const HUMAN = 'human';
const SYSTEM = 'system';

export type Attention = 'needs-you' | 'unseen' | 'working' | 'idle' | 'off';

export const ATTENTION_RANK: Record<Attention, 4 | 3 | 2 | 1 | 0> = {
  'needs-you': 4,
  unseen: 3,
  working: 2,
  idle: 1,
  off: 0,
};

// Копия `isRoomArchived` из `rooms.ts`: тот модуль тянет диск. Проверка по строке: комната без `archivedAt` открыта.
const isArchived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';

/**
 * Ждёт ли комната решения человека: в слоте `Room.proposal` лежит решение ведущего. У комнаты карты без поля
 * `proposal` это «не ждёт». Архивная комната решения не ждёт: хост очищает слот при архивации, а правило страхует
 * карту, где слот всё же остался.
 */
export function roomAwaitsDecision(room: Room): boolean {
  return !isArchived(room) && (room.proposal ?? null) !== null;
}

/**
 * Чего живая сессия ждёт от человека (`SessionActivity.need`, спека застрявших 3.1). У спящей, ожидающей запуска и
 * закрытой — `null`: процесса нет, ждать человека в терминале некому, а запись активности могла остаться от прошлого
 * процесса. У хоста прежней версии поля нет — тоже `null` (спека застрявших 8, п. 10).
 */
export function sessionNeed(session: Pick<WorkSession, 'lifecycle'>, live: SessionActivity | null): SessionNeed | null {
  return session.lifecycle === 'active' ? (live?.need ?? null) : null;
}

/** Таблица спеки 7.1. */
export function sessionAttention(session: WorkSession, live: SessionActivity | null): Attention {
  if (session.lifecycle === 'closed') return 'off';
  // pending и sleeping: процесса нет, но сессия не закрыта.
  if (session.lifecycle !== 'active') return 'idle';
  // `need` — «нужен ты» до разбора activity: лимит и вход оставляют ход законченным (`unseen`/`idle`), но человеку
  // всё равно пора вмешаться (спека застрявших 7.3; `!= null` — у хоста прежней версии поля нет).
  if (live?.need != null) return 'needs-you';
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
 * readBy.human. То же правило, что `unreadForHuman` в `letters.ts` (`mail.markRead` хоста).
 */
export function isHumanUnread(message: Message): boolean {
  return (
    message.from !== HUMAN &&
    message.readBy[HUMAN] === undefined &&
    (message.roomId !== null || message.to.includes(HUMAN))
  );
}

/**
 * Сообщение комнаты, где человека назвали: не от него и не от хоста, а в тексте `@human` по правилу `hasMention`.
 * Окно передаёт разбор Markdown, которым лента рисует чип «@you»; хост — `plainHumanMention`. Прочитано оно или нет,
 * решает `isHumanUnread`.
 */
export function isHumanMention(message: Message, hasMention: (text: string) => boolean): boolean {
  return (
    message.roomId !== null &&
    message.from !== HUMAN &&
    message.from !== SYSTEM &&
    hasMention(message.text)
  );
}

/**
 * Прямые письма человеку (roomId === null) с isHumanUnread. Упоминания в комнатах сюда не входят — их берёт
 * `humanUnreadMentions`.
 */
export function humanUnreadLetters(map: Pick<WindowWorkMap, 'messages'>): Message[] {
  return map.messages.filter((message) => message.roomId === null && isHumanUnread(message));
}

/**
 * Упоминания человека в комнатах с isHumanUnread, в порядке карты: последнее — самое позднее. Архивная комната
 * не источник внимания: её старые упоминания не считаются.
 */
export function humanUnreadMentions(map: Pick<WindowWorkMap, 'messages' | 'rooms'>, hasMention: (text: string) => boolean): Message[] {
  const archived = new Set(map.rooms.filter(isArchived).map((room) => room.id));
  return map.messages.filter(
    (message) =>
      isHumanUnread(message) &&
      isHumanMention(message, hasMention) &&
      !(message.roomId !== null && archived.has(message.roomId)),
  );
}

/** `@human` в простом тексте, без Markdown: не часть слова и не адрес (`mail@humanity.org` не считается). */
export function plainHumanMention(text: string): boolean {
  return /(^|[^\w@])@human\b/i.test(text);
}
