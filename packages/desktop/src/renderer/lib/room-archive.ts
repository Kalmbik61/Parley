/**
 * Архив комнат в окне (спека 2026-10-08, 3.1, 3.2, 5): правила `isRoomArchived` и «кого архивация оставит без открытой
 * комнаты» — копии правил `@parley/core` (`work/rooms.ts`): окно берёт из core только типы, а модуль комнат тянет диск.
 * Меняется правило в core — меняется и здесь.
 */

import type { Room, WorkMap, WorkSession } from '@parley/core';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts`: из core рендерер берёт только типы.
const HUMAN = 'human';

/**
 * В архиве ли комната: проверка по строке, а не по `=== null`. Комната из старой карты или фикстуры без поля
 * `archivedAt` открыта (так же, как в core).
 */
export function isRoomArchived(room: Room): boolean {
  return typeof room.archivedAt === 'string';
}

/** Id архивных комнат карты — для фильтров, которым нужна принадлежность письма (`attention/derive.ts`). */
export function archivedRoomIds(map: WorkMap): Set<string> {
  return new Set(map.rooms.filter(isRoomArchived).map((room) => room.id));
}

/**
 * Сессии, которых архивация комнаты оставит без открытой комнаты: участники (создатель-сессия и `members`, без человека
 * и без сессий, которых нет в карте), не числящиеся в другой неархивной комнате. Правило шага 5 `archiveRoom` в core —
 * по нему хост выбирает, кого остановить флажком «Also stop its N agents…»; число во флажке считает то же.
 */
export function agentsLeftWithoutRoom(map: WorkMap, room: Room): WorkSession[] {
  const ids = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  return ids.flatMap((id) => {
    const session = map.sessions.find((candidate) => candidate.id === id);
    if (session === undefined) return [];
    const inOther = map.rooms.some(
      (other) => other.id !== room.id && !isRoomArchived(other) && (other.creator === id || other.members.includes(id)),
    );
    return inOther ? [] : [session];
  });
}
