/**
 * Внимание сессий и работ (спека 7.1): где нужен человек. Порядок сайдбара
 * (`sidebar/sort.ts`) и значки карточек считаются отсюда, поэтому функции чистые.
 *
 * Человек — участник каждой комнаты, но в `room.members` не пишется, а
 * `recipientsOf` (`lib/mail-view.ts`) его вычитает. Непрочитанное человеком
 * поэтому считается здесь своими функциями, а не через `recipientsOf`.
 */

import type { Message, SessionNeed, WindowWorkEntry, WindowWorkMap } from '@parley/core';
import {
  ATTENTION_RANK,
  humanDecisionOutcome,
  humanUnreadLetters,
  humanUnreadMentions as coreHumanUnreadMentions,
  isHumanMention as coreIsHumanMention,
  isHumanUnread,
  roomAwaitsDecision,
  sessionAttention,
  sessionNeed,
  type Attention,
} from '@parley/core/attention';
import { needWord } from '@parley/core/session-state';
import { refKey, type MailWait } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { hasHumanMention } from '../components/rooms/room-remark.js';
import { isoMs } from '../lib/iso-time.js';
import { archivedRoomIds, isRoomArchived } from '../lib/room-archive.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

// Тот же литерал, что `HUMAN` в `core/work/types.ts`: из core рендерер берёт только типы.
const HUMAN = 'human';

// Предикаты внимания живут в core (`work/attention.ts`): их считает и хост. Имена и сигнатуры окна прежние.
export { ATTENTION_RANK, humanUnreadLetters, isHumanUnread, roomAwaitsDecision, sessionAttention, sessionNeed };
export type { Attention };

// Время сброса лимита — по часам машины, `HH:mm` (спека застрявших 7.3); дата другого дня — `Oct 14`.
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/**
 * Когда сбросится лимит `need` (3.4): `when` — `19:27`, не сегодня — `Oct 14, 19:27`; `reset` — время уже прошло;
 * `null` — времени нет или оно не разбирается.
 */
function limitReset(need: SessionNeed, now: number): { when: string; reset: boolean } | null {
  const at = need.resetsAt === null ? null : isoMs(need.resetsAt);
  if (at === null) return null;
  const date = new Date(at);
  const clock = CLOCK.format(date);
  const when = date.toDateString() === new Date(now).toDateString() ? clock : `${DAY.format(date)}, ${clock}`;
  return { when, reset: at <= now };
}

/**
 * Метка `need` в строке сессии и на карточке участника (спека застрявших 7.3): слово вида — `needWord` из core, у
 * лимита рядом время сброса. Обрамление — `S.need`.
 */
export function needLabel(need: SessionNeed, now: number): string {
  const word = needWord(need.kind);
  if (need.kind !== 'limit') return word;
  const limit = limitReset(need, now);
  if (limit === null) return word;
  return limit.reset ? S.need.reset(word) : S.need.withTime(word, limit.when);
}

/** Подсказка метки: чего ждёт сессия, затем `detail` (команда, текст вопроса или ошибки). */
export function needTooltip(need: SessionNeed): string {
  const lead =
    need.kind === 'sign-in' && need.account === 'account'
      ? S.need.accountLead
      : S.need.lead[need.kind](needWord(need.kind));
  return need.detail === null ? lead : S.need.withDetail(lead, need.detail);
}

/**
 * Причина в строке доставки под сообщением (`MailWait`, спека застрявших 7.3): у `stuck` — по `need` ждущей сессии
 * (`waiting for your approval`, `usage limit until 19:27`…), у прочих причин — таблица окна. Причина, которой окно
 * не знает (хост новее окна), — общее `waiting`, а не пустая скобка; `null` — причины нет.
 */
export function mailWaitText(reason: MailWait | null, need: SessionNeed | null, now: number): string | null {
  if (reason === null) return null;
  if (reason === 'stuck' && need !== null) {
    const word = needWord(need.kind);
    switch (need.kind) {
      case 'approval':
        return S.need.mail.approval(word);
      case 'question':
        return S.need.mail.question(word);
      case 'limit': {
        const limit = limitReset(need, now);
        if (limit === null) return S.need.mail.limit(word);
        return limit.reset ? S.need.mail.limitReset(word) : S.need.mail.limitUntil(word, limit.when);
      }
      case 'sign-in':
        return need.account === 'account' ? S.need.mail.accountProblem : S.need.mail.signedOut;
      case 'startup':
        return S.need.mail.startup;
    }
  }
  const known: Partial<Record<string, string>> = S.rooms.mailWait;
  return known[reason] ?? S.rooms.mailWaitUnknown;
}

/**
 * Последний ответ человека на решение комнаты — `Return for rework` (спека окна 2026-09-29, 1.10)? Слот `proposal`
 * после ответа пуст и не помнит, чем ответили, а факт ответа лежит в ленте: письмо человека ведущему — `Returned for
 * rework: …` или `Decision accepted.`. Решает самое позднее из двух: возврат, за которым решение приняли, следующее
 * решение «переделанным» не делает. Свои слова человека в комнате (без этих двух начал) в счёт не идут. Ленту читаем
 * в момент нового решения, а не ведём по снимкам окна: окно, открытое между возвратом и новым решением, тоже знает.
 */
export function roomDecisionReturned(map: WindowWorkMap, roomId: string): boolean {
  const answer = map.messages.findLast(
    (message) => message.roomId === roomId && message.from === HUMAN && humanDecisionOutcome(message.text) !== null,
  );
  return answer !== undefined && humanDecisionOutcome(answer.text) === 'returned';
}

/**
 * Сообщение комнаты, где человека назвали (Parley 0.3.0). Распознаёт `hasHumanMention` — тот же разбор Markdown,
 * которым лента рисует чип «@you» (`components/rooms/room-remark.ts`). Остальное правило — в core.
 */
export function isHumanMention(message: Message): boolean {
  return coreIsHumanMention(message, hasHumanMention);
}

/** Упоминания человека в комнатах с isHumanUnread, без архивных комнат (правило core, разбор Markdown окна). */
export function humanUnreadMentions(map: WindowWorkMap): Message[] {
  return coreHumanUnreadMentions(map, hasHumanMention);
}

/** Куда ведёт кнопка «для тебя» карточки: в почту — письма важнее — или в комнату самого позднего упоминания. */
export type ForYouTarget = { kind: 'mail' } | { kind: 'room'; roomId: string };

/**
 * Цель кнопки «для тебя» (`WorkCard`): есть непрочитанные письма — вкладка Mail; одни упоминания — комната
 * самого позднего из них; ничего непрочитанного — `null`. Письма первыми, потому что Mail показывает только их:
 * упоминание там не найти.
 */
export function forYouTarget(map: WindowWorkMap): ForYouTarget | null {
  if (humanUnreadLetters(map).length > 0) return { kind: 'mail' };
  const roomId = humanUnreadMentions(map).at(-1)?.roomId ?? null;
  return roomId === null ? null : { kind: 'room', roomId };
}

/** Сообщения комнаты с isHumanUnread: человек — участник любой комнаты. */
export function roomUnreadForHuman(map: WindowWorkMap, roomId: string): number {
  // Компактный снимок (P35) несёт точное число: письма комнаты в карте — только хвост, остальное за окном.
  const exact = map.compact?.unread.rooms[roomId];
  if (map.compact !== undefined) return exact ?? 0;
  return map.messages.filter((message) => message.roomId === roomId && isHumanUnread(message)).length;
}

export interface WorkAttention {
  level: Attention;
  needsYou: number;                     // сессии в 'needs-you' и комнаты с ждущим решением (2.7)
  unseen: number;
  // письма человеку без комнаты и упоминания `@human` в комнатах: одно сообщение считается один раз
  humanUnread: number;
  roomsUnread: Record<string, number>;  // только комнаты с непрочитанным
  roomMentions: Record<string, number>; // только комнаты с непрочитанным упоминанием человека
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

export function workAttention(entry: WindowWorkEntry, activity: Record<string, ActivityEntry>): WorkAttention {
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

  // Лента архивной комнаты — не событие работы: строка «Room archived by the human.» не поднимает карточку в сайдбаре
  // и не меняет время в её заголовке (хост пишет архивацию без `touch`, чтобы карточка не подпрыгивала).
  const archived = archivedRoomIds(map);
  for (const message of map.messages) {
    if (message.roomId !== null && archived.has(message.roomId)) continue;
    lastEventAt = later(lastEventAt, message.at);
  }

  // Комната с ждущим решением — «нужен ты», ранг 4, как blocked (спека окна 2026-09-29, 2.7): в счёт
  // «нужен ты» она входит наравне с сессией, иначе строка статуса молчала бы, а «следующая, где нужен
  // ты» вела бы туда, куда счётчик не зовёт.
  const decisions = map.rooms.filter(roomAwaitsDecision).length;
  if (decisions > 0) {
    needsYou += decisions;
    level = 'needs-you';
  }

  // Письма идут без `roomId`, упоминания — с ним: множества не пересекаются, и одно сообщение считается один раз.
  const mentions = humanUnreadMentions(map);
  // Прямых писем в компактной карте — точное число из `compact.unread`; упоминания считаются по письмам окна: все
  // непрочитанные в нём есть (до 200), а за ними счётчик комнаты и так точный.
  const humanUnread = (map.compact?.unread.letters ?? humanUnreadLetters(map).length) + mentions.length;
  // Письмо человеку — ранг 3 (2.7, как `workRank` прототипа): выше работающей и простаивающей работы,
  // ниже blocked и решения. Прежде оно поднимало работу до needs-you (спека Orca-UI 7.1). Упоминание человека в
  // комнате — то же письмо, ему и ранг тот же. Прочие комнаты — фон, а не вызов: их непрочитанное уровень не
  // поднимает.
  if (humanUnread > 0 && ATTENTION_RANK[level] < ATTENTION_RANK.unseen) level = 'unseen';

  const roomsUnread: Record<string, number> = {};
  const roomMentions: Record<string, number> = {};
  for (const room of map.rooms) {
    // Архивная комната внимания не просит (спека архива комнат, 5.3): ни счётчика, ни `@you` в её строке.
    if (isRoomArchived(room)) continue;
    const count = roomUnreadForHuman(map, room.id);
    if (count > 0) roomsUnread[room.id] = count;
    const mentioned = mentions.filter((message) => message.roomId === room.id).length;
    if (mentioned > 0) roomMentions[room.id] = mentioned;
  }

  return { level, needsYou, unseen, humanUnread, roomsUnread, roomMentions, lastEventAt };
}

/**
 * Внимание работы из готового расчёта (ключ — workKey). Работе без расчёта (снимок работ
 * пришёл раньше) — `off` со временем карты: одно правило для порядка (`sidebar/sort.ts`) и
 * карточек (`sidebar/WorkSidebar.tsx`), раунд исправлений 1 куска 3.3.
 */
export function attentionOf(attention: Record<string, WorkAttention>, entry: WindowWorkEntry): WorkAttention {
  return (
    attention[workKey(entry.projectPath, entry.map.work.id)] ?? {
      level: 'off',
      needsYou: 0,
      unseen: 0,
      humanUnread: 0,
      roomsUnread: {},
      roomMentions: {},
      lastEventAt: entry.map.work.updatedAt,
    }
  );
}

/** Два счётчика по комнатам (`roomsUnread`, `roomMentions`) совпадают поштучно. */
function sameRoomCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const rooms = Object.keys(a);
  return rooms.length === Object.keys(b).length && rooms.every((id) => a[id] === b[id]);
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
  return (
    sameRoomCounts(a.roomsUnread, b.roomsUnread) && sameRoomCounts(a.roomMentions, b.roomMentions)
  );
}
