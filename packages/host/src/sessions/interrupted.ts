/**
 * Кого хост прервал посреди хода (спецификация 10, «Упал хост»): PTY гибнут
 * вместе с хостом, сверка живости переводит сессии в `sleeping`, но часть из
 * них в этот момент работала. Окно показывает их списком с кнопкой «поднять
 * всех» — поднимать без согласия человека нельзя.
 */

import type { EventRecord, WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';

/** Хуки, которыми ход (или сама сессия) закончился штатно. */
const ENDED = new Set(['Stop', 'SessionEnd']);

/**
 * `Notification` простоя приходит уже после `Stop` (агент ждёт человека): ход
 * он не начинает, и последним хуком сессия, закончившая ход, прерванной от
 * него не становится.
 */
const isIdleNotice = (event: EventRecord): boolean =>
  event.name === 'Notification' && event.notificationType === 'idle_prompt';

/** Упали посреди хода: последний хук журнала — не Stop и не SessionEnd. */
export async function findInterrupted(
  entries: WorkEntry[],
  events: (ref: SessionRef) => Promise<readonly EventRecord[] | null>,
): Promise<SessionRef[]> {
  const found: SessionRef[] = [];
  for (const entry of entries) {
    for (const session of entry.map.sessions) {
      // Живые и закрытые не прерваны; `pending` ещё не начинала.
      if (session.lifecycle !== 'sleeping') continue;
      const ref: SessionRef = {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        sessionId: session.id,
      };
      const journal = await events(ref);
      const last = journal?.filter((event) => !isIdleNotice(event)).at(-1);
      if (last !== undefined && !ENDED.has(last.name)) found.push(ref);
    }
  }
  return found;
}
