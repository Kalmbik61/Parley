/**
 * Перетаскивание сессии на строки сайдбара (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5) — чистая часть:
 * что бросок значит для карты работы и можно ли его делать. Разбор самого события — `dnd.ts#sidebarDropFromDragEnd`,
 * бросок в раскладку — `dnd.ts#applyDrop` (работает как раньше).
 *
 * Только внутри одной работы: цель другой работы отбрасывает `layoutCollision` (чужой `workKey`), а строки других
 * карточек сессию не принимают (`sidebar/use-drop-target.ts`). Сессию можно бросить:
 * - на другую сессию — диалог «New room» из двух сессий (1.6): `merge`;
 * - на строку комнаты, где сессии нет, — `rooms.addMember`: `join`.
 * Нельзя: на себя, в свою комнату (и на участника своей комнаты), закрытую сессию и на закрытую (хост закрытых в
 * комнату не берёт), на сессию или комнату, которых в карте уже нет. Цель, на которую бросить нельзя, не подсвечивается.
 *
 * «Своя комната» — та, в которой сайдбар ставит сессию (`sidebar/sort.ts#homeRoomOf`): сессия старой карты в
 * нескольких комнатах стоит в самой ранней (решение 4), поэтому бросок её в другую из них разрешён, а правило одной
 * комнаты проводит хост в `rooms.addMember`.
 */

import type { WorkMap } from '@harnas/core';
import { homeRoomOf } from '../sidebar/sort.js';
import type { SidebarTarget } from './dnd.js';

/** Что делает бросок: собрать комнату из двух сессий или ввести сессию в комнату. */
export type SidebarDrop =
  | { kind: 'merge'; dragged: string; target: string }
  | { kind: 'join'; sessionId: string; roomId: string };

/** Значение броска сессии `sessionId` на цель `target` в работе `map`; `null` — бросить нельзя. */
export function resolveSidebarDrop(map: WorkMap, sessionId: string, target: SidebarTarget): SidebarDrop | null {
  const dragged = map.sessions.find((session) => session.id === sessionId);
  if (dragged === undefined || dragged.lifecycle === 'closed') return null;

  if (target.kind === 'session-row') {
    const other = map.sessions.find((session) => session.id === target.sessionId);
    if (other === undefined || other.id === dragged.id || other.lifecycle === 'closed') return null;
    // Две сессии одной комнаты — это её же участники: строку участника цель не принимает, но и разрешать такой бросок
    // незачем, новая комната собрала бы их из этой же.
    const home = homeRoomOf(map, dragged.id);
    if (home !== null && home.id === homeRoomOf(map, other.id)?.id) return null;
    return { kind: 'merge', dragged: dragged.id, target: other.id };
  }

  const room = map.rooms.find((candidate) => candidate.id === target.roomId);
  if (room === undefined || homeRoomOf(map, dragged.id)?.id === room.id) return null;
  return { kind: 'join', sessionId: dragged.id, roomId: room.id };
}
