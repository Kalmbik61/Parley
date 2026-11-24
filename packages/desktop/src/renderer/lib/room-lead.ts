/**
 * Ведущий комнаты в окне (дизайн комнат, 3.1–3.2) — копия правила `liveLead` из
 * `@parley/core` (`work/rooms.ts`): окно берёт из core только типы, его рантайм тянет модули
 * Node. Меняется правило — меняются оба места вместе.
 *
 * Назначенный `lead` (у карт до 2026-09-29 — первый из `members`), пока он жив; иначе первый
 * живой из `members`. Ведущего нет, когда в комнате не осталось ни
 * одной живой сессии: такая комната закрыта. Человек — не сессия и ведущим не бывает.
 */

import type { Room, WindowWorkMap } from '@parley/core';

function isAlive(map: WindowWorkMap, id: string): boolean {
  return map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
}

export function roomLiveLead(map: WindowWorkMap, room: Room): string | null {
  const declared = room.lead ?? room.members[0] ?? null;
  if (declared !== null && room.members.includes(declared) && isAlive(map, declared)) return declared;
  return room.members.find((id) => isAlive(map, id)) ?? null;
}

/**
 * Названный проверяющий пункта недоступен — копия `planVerifierUnavailable` из core (`work/plans.ts`): сессия закрыта
 * или не в комнате; человек доступен всегда. Меняется правило — меняются оба места вместе.
 */
export function roomVerifierUnavailable(map: WindowWorkMap, room: Room, verifier: string | null): boolean {
  return verifier !== null && verifier !== 'human' && !(room.members.includes(verifier) && isAlive(map, verifier));
}
