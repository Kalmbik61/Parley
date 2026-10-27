/**
 * Снимок без писем (`MapCompactMail`, спека rooms.mail 6.8) для тестов окна: компактная карта версии 2 и работа с ней.
 * Отдельный файл от `work-fixtures.ts`, чтобы фикстуры шага 2 не пересекались с правками соседних задач.
 */

import type { MapCompactMail, Message, WindowWorkEntry } from '@parley/core';

type RoomNumbers = MapCompactMail['rooms'][string];

/** Числа комнаты в снимке: по умолчанию пусто — ни писем, ни непрочитанного, решения нет. */
export function makeRoomNumbers(patch: Partial<RoomNumbers> = {}): RoomNumbers {
  return { total: 0, top: 0, lastAt: null, unread: 0, decision: null, ...patch };
}

/** `compact` версии 2; ключ `''` в `rooms` и `unread.rooms` — прямые письма. */
export function makeCompactMail(patch: Partial<MapCompactMail> = {}): MapCompactMail {
  return { version: 2, rooms: {}, unread: { letters: 0, rooms: {} }, mentionCandidates: [], cut: [], omitted: {}, ...patch };
}

/** Работа с компактной картой версии 2; письма карты (`messages`) — то, что окно держит само. */
export function withCompactMail(entry: WindowWorkEntry, compact: MapCompactMail, held: Message[] = []): WindowWorkEntry {
  return { ...entry, map: { ...entry.map, messages: held, compact } };
}
