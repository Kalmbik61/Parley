/**
 * Окно и компактный снимок работ (P35): хост присылает письма комнаты хвостом, а старше хвоста окно берёт страницами
 * (`context.messages`). Эти чистые функции держат ленту целой на стороне окна: письмо, которое уже было показано,
 * не пропадает, когда хвост сдвинулся, а подгруженные страницей письма встают на свои места.
 */

import type { Message, WorkEntry } from '@parley/core';
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
export function retainSeen(prev: WorkEntry | undefined, next: WorkEntry): WorkEntry {
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
export function withMessages(entry: WorkEntry, messages: readonly Message[]): WorkEntry {
  if (messages.length === 0) return entry;
  return { ...entry, map: { ...entry.map, messages: union(entry.map.messages, messages) } };
}

/** Сколько писем комнаты хост держит, а окно ещё нет: всего минус то, что в карте окна. `0` — карта полная. */
export function earlierRemaining(entry: WorkEntry, roomId: string): number {
  const total = entry.map.compact?.messages.rooms[roomId]?.total;
  if (total === undefined) return 0;
  let held = 0;
  for (const message of entry.map.messages) if (message.roomId === roomId) held += 1;
  return Math.max(0, total - held);
}

/** С чего начинать подгрузку старых писем комнаты: курсор перед хвостом без дыр; без хвоста — с самых новых. */
export function earlierCursor(entry: WorkEntry, roomId: string): string | undefined {
  const from = entry.map.compact?.messages.rooms[roomId]?.tailFrom ?? null;
  return from === null ? undefined : `before:${from}`;
}
