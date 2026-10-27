/**
 * Окно и компактный снимок работ (P35): хост присылает письма комнаты хвостом, а старше хвоста окно берёт страницами
 * (`context.messages`). Эти чистые функции держат ленту целой на стороне окна: письмо, которое уже было показано,
 * не пропадает, когда хвост сдвинулся, а подгруженные страницей письма встают на свои места.
 *
 * Окно с признаком `rooms-mail` получает снимок без писем (`compact` версии 2, спека rooms.mail 6.8): письма оно держит
 * само — страницами `context.messages` открытых комнат и Mail и событиями `rooms.mail` — и переносит их из снимка в снимок
 * (`keepHeld`). Снимок прежнего хоста (версия 1 или без `compact`) окно разбирает по-старому: `retainSeen`, хвосты, подсчёты.
 */

import type { MapCompact, MapCompactMail, Message, WindowWorkEntry } from '@parley/core';
import { humanDecisionOutcome } from '@parley/core/attention';
import type { RoomsMailEvent, RoomsMailRoom } from '@parley/protocol';
import { isHumanUnread } from '../attention/derive.js';

// Те же литералы и числа, что в `core` (`HUMAN`, `WINDOW_UNREAD_MAX`): значения из core рендерер не берёт, только типы.
const HUMAN = 'human';

/** Сколько кандидатов в упоминания окно держит по работе: потолок хоста (`WINDOW_UNREAD_MAX`, `core/work/context-pages.ts`). */
const MENTION_CANDIDATES_MAX = 200;

/** Сколько новейших писем окно держит на комнату и на Mail, не считая подгруженного человеком «раньше» (спека rooms.mail 6.9, 8). */
export const WINDOW_ROOM_KEEP = 300;

/**
 * Что окно знает о комнатах работы сверх самих писем (хранит `room-pages.ts`): какие открывались и докуда подгружена история.
 * Без него считается, что открыто всё, а подгруженного «раньше» нет.
 */
export interface HeldPolicy {
  /** Комната (`null` — Mail) открывалась: письма её событий окно держит, а у неоткрытой событие обновляет только числа. */
  isOpen(roomId: string | null): boolean;
  /** Номер, с которого человек подгрузил историю комнаты (письма от него и новее остаются при `keepHeld`); `0` — всю; `undefined` — не подгружал. */
  floor(roomId: string | null): number | undefined;
}

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

/**
 * Свежий снимок работы с письмами, которые окно уже держало. Снимок без писем (версия 2) их не несёт: письма открытых
 * комнат и Mail переходят в него из прежней карты, кроме комнат, которых больше нет (спека rooms.mail 6.9). На комнату
 * остаётся не больше `WINDOW_ROOM_KEEP` новейших писем плюс то, что человек подгрузил «раньше» (`floor`): это же срезает
 * дыру посреди комнаты, которую оставило прерванное дочитывание. Снимок прежнего хоста — по-старому, `retainSeen`.
 */
export function keepHeld(prev: WindowWorkEntry | undefined, next: WindowWorkEntry, floor?: HeldPolicy['floor']): WindowWorkEntry {
  if (next.map.compact?.version !== 2) return retainSeen(prev, next);
  if (prev === undefined || prev.map.messages.length === 0) return next;
  const rooms = roomIdsOf(next);
  const byRoom = new Map<string | null, Message[]>();
  for (const message of prev.map.messages) {
    if (message.roomId !== null && !rooms.has(message.roomId)) continue;
    const list = byRoom.get(message.roomId);
    if (list === undefined) byRoom.set(message.roomId, [message]);
    else list.push(message);
  }
  const kept: Message[] = [];
  for (const [roomId, list] of byRoom) {
    list.sort((a, b) => messageSeq(a) - messageSeq(b));
    const threshold = keepFrom(list, floor?.(roomId));
    for (const message of list) if (messageSeq(message) >= threshold) kept.push(message);
  }
  return { ...next, map: { ...next.map, messages: kept.sort((a, b) => messageSeq(a) - messageSeq(b)) } };
}

/**
 * Номер, с которого окно держит письма комнаты (`list` — по возрастанию номера): 300-е с конца письмо, а подгруженная
 * человеком история опускает порог до своей границы (`floor`). У комнаты не длиннее `WINDOW_ROOM_KEEP` порога нет — `0`.
 */
function keepFrom(list: readonly Message[], floor: number | undefined): number {
  const edge = list.length > WINDOW_ROOM_KEEP ? messageSeq(list[list.length - WINDOW_ROOM_KEEP]!) : 0;
  return Math.min(edge, floor ?? Number.POSITIVE_INFINITY);
}

/**
 * Тот же срез для писем, что пришли событием (спека rooms.mail 6.9, «Память окна»): письма только пишутся, снимка между
 * событиями нет, и открытая шумная комната иначе росла бы без предела. Срез — у комнат `rooms`, куда события что-то
 * положили; остальные комнаты и Mail не трогаются. `messages` — по возрастанию номера.
 */
function capRooms(messages: Message[], rooms: ReadonlySet<string | null>, floor?: HeldPolicy['floor']): Message[] {
  const byRoom = new Map<string | null, Message[]>();
  for (const message of messages) {
    if (!rooms.has(message.roomId)) continue;
    const list = byRoom.get(message.roomId);
    if (list === undefined) byRoom.set(message.roomId, [message]);
    else list.push(message);
  }
  const from = new Map<string | null, number>();
  for (const [roomId, list] of byRoom) {
    const threshold = keepFrom(list, floor?.(roomId));
    if (threshold > 0) from.set(roomId, threshold);
  }
  if (from.size === 0) return messages;
  return messages.filter((message) => messageSeq(message) >= (from.get(message.roomId) ?? 0));
}

/** Работа с письмами, пришедшими страницей: в ленте они встают по номеру, письма снимка остаются как были. */
export function withMessages(entry: WindowWorkEntry, messages: readonly Message[]): WindowWorkEntry {
  if (messages.length === 0) return entry;
  return { ...entry, map: { ...entry.map, messages: union(entry.map.messages, messages) } };
}

/** Сколько писем комнаты хост держит, а окно ещё нет: всего минус то, что в карте окна. `0` — карта полная. */
export function earlierRemaining(entry: WindowWorkEntry, roomId: string): number {
  // Снимок без писем (версия 2) несёт итог комнаты в `rooms`, прежний — в `messages.rooms` (спека rooms.mail 6.9).
  const compact = entry.map.compact;
  const total = compact?.version === 2 ? compact.rooms[roomId]?.total : compact?.version === 1 ? compact.messages.rooms[roomId]?.total : undefined;
  if (total === undefined) return 0;
  let held = 0;
  for (const message of entry.map.messages) if (message.roomId === roomId) held += 1;
  return Math.max(0, total - held);
}

/**
 * С чего начинать подгрузку старых писем комнаты. Снимок без писем (версия 2): перед наименьшим держимым номером, а если
 * комната ничего не держит — с самых новых. Прежний снимок: перед хвостом без дыр; без хвоста — с самых новых.
 */
export function earlierCursor(entry: WindowWorkEntry, roomId: string): string | undefined {
  const compact = entry.map.compact;
  if (compact?.version === 2) {
    const range = heldRanges(entry).get(roomId);
    return range === undefined ? undefined : `before:${range.min}`;
  }
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
 * Итог последнего решения комнаты после события: письма человека с ответом, новейшее побеждает; событие без такого
 * письма оставляет прежний итог. Слова ответа — `humanDecisionOutcome` (core), те же, по которым итог считает хост.
 */
function decisionAfter(letters: readonly Message[], prev: 'accepted' | 'returned' | null): 'accepted' | 'returned' | null {
  let outcome = prev;
  let latest = 0;
  for (const letter of letters) {
    if (letter.from !== HUMAN) continue;
    const answer = humanDecisionOutcome(letter.text);
    if (answer === null || messageSeq(letter) < latest) continue;
    outcome = answer;
    latest = messageSeq(letter);
  }
  return outcome;
}

/**
 * Набор кандидатов в упоминания человека после события (ruling R5): новые кандидаты события дописываются, повтор по id
 * заменяется свежей копией; уходят id, прочитанные человеком (`reads` с читателем `human` — и в комнатах, которых окно
 * не держит), `deleted`, письма комнат из `droppedRooms` и комнат, которых нет в карте; остаётся не больше
 * `MENTION_CANDIDATES_MAX` новейших. Точное правило «@вы» применяет окно позже (`derive.ts`).
 */
function candidatesAfter(current: readonly Message[], event: RoomsMailEvent, known: ReadonlySet<string>): Message[] {
  const byId = new Map(current.map((message) => [message.id, message] as const));
  for (const message of event.mentionCandidates) byId.set(message.id, message);
  for (const room of event.rooms) {
    for (const read of room.reads) if (read.reader === HUMAN) byId.delete(read.id);
    for (const id of room.deleted) byId.delete(id);
  }
  const dropped = new Set(event.droppedRooms);
  const alive = [...byId.values()].filter((message) => message.roomId !== null && known.has(message.roomId) && !dropped.has(message.roomId));
  return alive.sort((a, b) => messageSeq(a) - messageSeq(b)).slice(-MENTION_CANDIDATES_MAX);
}

/**
 * Числа события в `compact` версии 2 (ruling R11): итоги затронутых комнат и непрочитанное по работе ставятся из события
 * как есть — `''` в обоих местах означает прямые письма, перевода ключей нет. Непрочитанное нетронутых комнат тоже
 * обновляется: событие несёт его по всей работе, а отметка прочтения меняет не только комнаты со своими письмами.
 */
function withMailNumbers(compact: MapCompactMail, event: RoomsMailEvent, touched: readonly RoomsMailRoom[], known: ReadonlySet<string>): MapCompactMail {
  const rooms = { ...compact.rooms };
  for (const id of event.droppedRooms) delete rooms[id];
  const keys = new Set<string>();
  for (const room of touched) {
    const key = room.roomId ?? '';
    keys.add(key);
    rooms[key] = {
      total: room.total,
      top: room.top,
      lastAt: room.lastAt,
      unread: event.unread.rooms[key] ?? 0,
      decision: decisionAfter(room.letters, rooms[key]?.decision ?? null),
    };
  }
  for (const [key, numbers] of Object.entries(rooms)) if (!keys.has(key)) rooms[key] = { ...numbers, unread: event.unread.rooms[key] ?? 0 };
  return {
    ...compact,
    rooms,
    unread: { letters: event.unread.letters, rooms: { ...event.unread.rooms } },
    mentionCandidates: candidatesAfter(compact.mentionCandidates, event, known),
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
 *
 * Снимок без писем (версия 2): письма события встают только в комнаты, которые окно открывало (`isOpen`, по умолчанию —
 * все), а у неоткрытых событие обновляет одни числа (спека rooms.mail 6.9). В комнате, куда письма встали, остаётся не
 * больше `WINDOW_ROOM_KEEP` новейших плюс подгруженное человеком «раньше» (`floor`, как у `keepHeld`): срез идёт и по
 * устаревшему событию. Числа, кандидаты в упоминания и итог решения берутся из события по правилам R5 и R11
 * (`withMailNumbers`); у прежнего снимка — перевод в `compact` версии 1.
 */
export function withMail(
  entry: WindowWorkEntry,
  event: RoomsMailEvent,
  stale = false,
  isOpen: HeldPolicy['isOpen'] = () => true,
  floor?: HeldPolicy['floor'],
): WindowWorkEntry {
  const known = roomIdsOf(entry);
  const touched = event.rooms.filter((room) => room.roomId === null || known.has(room.roomId));
  const dropped = new Set(stale ? [] : event.droppedRooms);
  const kept = dropped.size === 0 ? entry.map.messages : entry.map.messages.filter((message) => message.roomId === null || !dropped.has(message.roomId));
  const current = entry.map.compact;
  // Без писем в снимке письма события держит только открытая комната: у остальных память окна не растёт на каждое письмо.
  const holding = current?.version === 2 ? touched.filter((room) => isOpen(room.roomId)) : touched;
  const merged = withMarks(unionFresh(kept, holding.flatMap((room) => room.letters)), touched);
  const messages = current?.version === 2 ? capRooms(merged, new Set(holding.filter((room) => room.letters.length > 0).map((room) => room.roomId)), floor) : merged;
  const compact =
    stale || current === undefined
      ? current
      : current.version === 2
        ? withMailNumbers(current, event, touched, known)
        : withNumbers(current, event, touched, messages);
  const work = stale ? entry.map.work : { ...entry.map.work, updatedAt: event.updatedAt };
  return { ...entry, map: { ...entry.map, work, messages, ...(compact === undefined ? {} : { compact }) } };
}
