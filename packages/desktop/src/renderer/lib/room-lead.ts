/**
 * Ведущий комнаты в окне (дизайн комнат, 3.1–3.2) — копия правила `liveLead` из
 * `@parley/core` (`work/rooms.ts`): окно берёт из core только типы, его рантайм тянет модули
 * Node. Меняется правило — меняются оба места вместе.
 *
 * Назначенный `lead` (у карт до 2026-09-29 — первый из `members`), пока он жив; иначе первый
 * живой из `members`, за ним создатель-сессия. Ведущего нет, когда в комнате не осталось ни
 * одной живой сессии: такая комната закрыта. Человек — не сессия и ведущим не бывает.
 */

import type { Room, WorkMap } from '@parley/core';

function isAlive(map: WorkMap, id: string): boolean {
  return map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
}

export function roomLiveLead(map: WorkMap, room: Room): string | null {
  const declared = room.lead ?? room.members[0] ?? null;
  if (declared !== null && isAlive(map, declared)) return declared;
  return [...room.members, room.creator].find((id) => isAlive(map, id)) ?? null;
}
