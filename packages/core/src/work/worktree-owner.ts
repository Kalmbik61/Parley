import { isRoomArchived } from './rooms.js';
import type { WorkMap } from './types.js';

/**
 * Копия сессии, которую уборка не тронула, и почему (спека 2026-11-03, 4.1): окно показывает такие
 * строки человеку, решение за ним.
 */
export interface WorktreeLeftover {
  ref: { projectPath: string; workId: string; sessionId: string };
  label: string;
  path: string;
  branch: string;
  reason: 'dirty' | 'unsaved' | 'refused' | 'in-use';
  files: number | null;
  message: string | null;
  sizeBytes: number | null;
}

/**
 * Закончил ли хозяин копии (спека 4.1): сессия закрыта, работа в архиве или комната сессии в архиве.
 * Сон, `report(done)` и итог `accepted` хозяина не заканчивают: сессию можно разбудить. Удалённая
 * комната по карте не видна — её членов в карте нет, поэтому она сама ничего не решает.
 */
export function sessionWorktreeFinished(map: WorkMap, sessionId: string): boolean {
  if (map.work.status === 'archived') return true;
  if (map.sessions.some((session) => session.id === sessionId && session.lifecycle === 'closed')) return true;
  // Сессия состоит не больше чем в одной комнате.
  const room = map.rooms.find((candidate) => candidate.members.includes(sessionId));
  return room !== undefined && isRoomArchived(room);
}
