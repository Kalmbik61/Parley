/**
 * Окно и компактный снимок работ (P35): хост присылает письма комнаты хвостом, а старше хвоста окно берёт страницами
 * (`context.messages`). Эти чистые функции держат ленту целой на стороне окна: письмо, которое уже было показано,
 * не пропадает, когда хвост сдвинулся, а подгруженные страницей письма встают на свои места.
 */

import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import type { RoomsMailEvent, RoomsMailRoom } from '@parley/protocol';
import { isHumanUnread } from '../attention/derive.js';

/** Номер письма из id `m-12`; нарастает вместе с перепиской. */
export function messageSeq(message: Pick<Message, 'id'>): number {
  return Number(message.id.slice(2)) || 0;
}

/** Объединение по id, по возрастанию номера; при совпадении побеждает письмо из `base` (оно свежее). */
function union(base: readonly Message[], extra: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of extra) byId.set(message.id, message);
  for (const message of base) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => messageSeq(a) - messageSeq(b));
}

/**
 * Свежий снимок работы с письмами, которые окно уже держало: хвост хоста сдвинулся, а человек листал историю. Не
 * переносятся письма, непрочитанные человеком в прежней копии: такое письмо в снимке всегда есть, пока не прочитано, а
 * исчезнув из него, оно прочитано — стухшая копия с `readBy` без отметки горела бы счётчиком вечно. Письма комнат,
 * которых в карте больше нет, тоже не переносятся. Полная карта прежнего хоста (без `compact`) возвращается как есть.
 */
export function retainSeen(prev: WindowWorkEntry | undefined, next: WindowWorkEntry): WindowWorkEntry {
  if (prev === undefined || next.map.compact === undefined) return next;
  const rooms = new Set(next.map.rooms.map((room) => room.id));
  const have = new Set(next.map.messages.map((message) => message.id));
  const kept = prev.map.messages.filter(
    (message) => !have.has(message.id) && (message.roomId === null || rooms.has(message.roomId)) && !isHumanUnread(message),
  );
  if (kept.length === 0) return next;
  return { ...next, map: { ...next.map, messages: union(next.map.messages, kept) } };
}

/** Работа с письмами, пришедшими страницей: в ленте они встают по номеру, письма снимка остаются как были. */
export function withMessages(entry: WindowWorkEntry, messages: readonly Message[]): WindowWorkEntry {
  if (messages.length === 0) return entry;
  return { ...entry, map: { ...entry.map, messages: union(entry.map.messages, messages) } };
}

/** Сколько писем комнаты хост держит, а окно ещё нет: всего минус то, что в карте окна. `0` — карта полная. */
export function earlierRemaining(entry: WindowWorkEntry, roomId: string): number {
  // Снимок без писем (`compact.version === 2`) окно разбирает отдельно (спека rooms.mail 6.9): итоги комнат в нём другие.
  const compact = entry.map.compact;
  const total = compact?.version === 1 ? compact.messages.rooms[roomId]?.total : undefined;
  if (total === undefined) return 0;
  let held = 0;
  for (const message of entry.map.messages) if (message.roomId === roomId) held += 1;
  return Math.max(0, total - held);
}

/** С чего начинать подгрузку старых писем комнаты: курсор перед хвостом без дыр; без хвоста — с самых новых. */
export function earlierCursor(entry: WindowWorkEntry, roomId: string): string | undefined {
  const compact = entry.map.compact;
  const from = (compact?.version === 1 ? compact.messages.rooms[roomId]?.tailFrom : undefined) ?? null;
  return from === null ? undefined : `before:${from}`;
}

/**
 * Письмо со свежей копией. Отметки прочтения и пометка «удалено» только прибавляются, поэтому запоздавшая старая копия
 * (событие или страница, обогнанные более новым) их не откатывает: письмо, прочитанное человеком, не загорится снова.
 */
function freshLetter(held: Message | undefined, incoming: Message): Message {
  if (held === undefined) return incoming;
  const next: Message = { ...incoming, readBy: { ...held.readBy, ...incoming.readBy } };
  if (held.deleted === true) next.deleted = true;
  return next;
}

/** Объединение по id, по возрастанию номера; при совпадении побеждает свежая копия (`freshLetter`). */
function unionFresh(base: readonly Message[], extra: readonly Message[]): Message[] {
  const byId = new Map(base.map((message) => [message.id, message] as const));
  for (const message of extra) byId.set(message.id, freshLetter(byId.get(message.id), message));
  return [...byId.values()].sort((a, b) => messageSeq(a) - messageSeq(b));
}

/** Что окно держит по комнатам: наименьший и наибольший номер письма; ключ `null` — прямые письма (Mail). */
export function heldRanges(entry: WindowWorkEntry): Map<string | null, { min: number; max: number }> {
  const ranges = new Map<string | null, { min: number; max: number }>();
  for (const message of entry.map.messages) {
    const seq = messageSeq(message);
    const range = ranges.get(message.roomId);
    if (range === undefined) ranges.set(message.roomId, { min: seq, max: seq });
    else ranges.set(message.roomId, { min: Math.min(range.min, seq), max: Math.max(range.max, seq) });
  }
  return ranges;
}

const roomIdsOf = (entry: WindowWorkEntry): Set<string> => new Set(entry.map.rooms.map((room) => room.id));

/**
 * Страница писем, пришедшая после разрыва (`repairWork`, `followRoom`): свежие копии встают в карту, письма комнат,
 * которых в карте уже нет, — нет: запоздавшая страница не воскрешает удалённую комнату. Числа страница не трогает —
 * их ставят события и снимки.
 */
export function withFreshMessages(entry: WindowWorkEntry, messages: readonly Message[]): WindowWorkEntry {
  const rooms = roomIdsOf(entry);
  const known = messages.filter((message) => message.roomId === null || rooms.has(message.roomId));
  if (known.length === 0) return entry;
  return { ...entry, map: { ...entry.map, messages: unionFresh(entry.map.messages, known) } };
}

/** Отметки прочтения и пометки «удалено» события на держимых письмах; порядок писем сохраняется. */
function withMarks(messages: Message[], rooms: readonly RoomsMailRoom[]): Message[] {
  if (rooms.every((room) => room.reads.length === 0 && room.deleted.length === 0)) return messages;
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  for (const room of rooms) {
    for (const { id, reader, at } of room.reads) {
      const message = byId.get(id);
      if (message !== undefined && message.readBy[reader] === undefined) byId.set(id, { ...message, readBy: { ...message.readBy, [reader]: at } });
    }
    // Письмо с пометкой остаётся в ленте, как в снимке хоста: ответить на него уже некому, переписку задним числом не правят.
    for (const id of room.deleted) {
      const message = byId.get(id);
      if (message !== undefined && message.deleted !== true) byId.set(id, { ...message, deleted: true });
    }
  }
  return messages.map((message) => byId.get(message.id) ?? message);
}

/**
 * Числа события в `compact` карты: итоги комнат и работы, непрочитанное у человека. Они **абсолютные**, не прибавки
 * (спека rooms.mail 6.3): повторённое событие ставит те же числа. В событии `unread.rooms['']` — прямые письма, а
 * `unread.letters` — всего по работе; в снимке `unread.letters` — только прямые письма, поэтому берётся ключ `''`.
 */
function withNumbers(compact: MapCompact, event: RoomsMailEvent, touched: readonly RoomsMailRoom[], messages: readonly Message[]): MapCompact {
  const rooms = { ...compact.messages.rooms };
  let total = compact.messages.total;
  for (const id of event.droppedRooms) {
    const gone = rooms[id];
    if (gone === undefined) continue;
    total -= gone.total;
    delete rooms[id];
  }
  const heldBy = new Map<string | null, number>();
  for (const message of messages) heldBy.set(message.roomId, (heldBy.get(message.roomId) ?? 0) + 1);
  let latest = compact.messages.latestId === null ? 0 : messageSeq({ id: compact.messages.latestId });
  for (const room of touched) {
    const key = room.roomId ?? 'direct';
    const prev = rooms[key];
    total += room.total - (prev?.total ?? 0);
    // Хвост без дыр: у комнаты без хвоста его начинает первое письмо события, но не событие с `reread` — письма там пришли не все.
    let tailFrom = prev?.tailFrom ?? null;
    if (tailFrom === null && room.reread !== true && room.letters.length > 0) tailFrom = Math.min(...room.letters.map(messageSeq));
    rooms[key] = { total: room.total, included: heldBy.get(room.roomId) ?? 0, tailFrom };
    if (room.top > latest) latest = room.top;
  }
  const { '': direct, ...unreadRooms } = event.unread.rooms;
  return {
    ...compact,
    messages: { total, included: messages.length, latestId: latest === 0 ? compact.messages.latestId : `m-${latest}`, rooms },
    unread: { letters: direct ?? 0, rooms: unreadRooms },
  };
}

/**
 * Работа с событием `rooms.mail` (спека rooms.mail 6.3-6.4). Письма встают по номеру, свежая копия события заменяет
 * держимую (отметки при этом только прибавляются); `reads` ставят отметки, `deleted` — пометки, `droppedRooms` убирают
 * письма и итоги комнат; числа ставятся из события, а `map.work.updatedAt` — по нему же.
 *
 * `stale` — событие не новее того, что окно уже держит (его версия не больше версии окна: снимок или предыдущее событие
 * обогнали его): письма и отметки сливаются, числа, `updatedAt` и `droppedRooms` не трогаются, чтобы старое событие не
 * откатило свежее. Письма комнат, которых в карте нет (удалены или структура ещё в пути), не встают в ленту.
 */
export function withMail(entry: WindowWorkEntry, event: RoomsMailEvent, stale = false): WindowWorkEntry {
  const known = roomIdsOf(entry);
  const touched = event.rooms.filter((room) => room.roomId === null || known.has(room.roomId));
  const dropped = new Set(stale ? [] : event.droppedRooms);
  const kept = dropped.size === 0 ? entry.map.messages : entry.map.messages.filter((message) => message.roomId === null || !dropped.has(message.roomId));
  const messages = withMarks(unionFresh(kept, touched.flatMap((room) => room.letters)), touched);
  const compact = stale || entry.map.compact === undefined ? entry.map.compact : withNumbers(entry.map.compact, event, touched, messages);
  const work = stale ? entry.map.work : { ...entry.map.work, updatedAt: event.updatedAt };
  return { ...entry, map: { ...entry.map, work, messages, ...(compact === undefined ? {} : { compact }) } };
}
