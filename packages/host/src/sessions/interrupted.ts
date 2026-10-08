/**
 * Кого хост прервал посреди хода (спецификация 10, «Упал хост»): PTY гибнут
 * вместе с хостом, сверка живости переводит сессии в `sleeping`, но часть из
 * них в этот момент работала. Окно показывает их списком с кнопкой «поднять
 * всех» — поднимать без согласия человека нельзя.
 */

import { activityOf, type EventRecord, type WorkEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';

/** Хуки, которыми ход (или сама сессия) закончился штатно. */
const ENDED = new Set(['Stop', 'SessionEnd']);

/**
 * `Notification` простоя приходит уже после `Stop` (агент ждёт человека): ход
 * он не начинает, и последним хуком сессия, закончившая ход, прерванной от
 * него не становится.
 */
const isIdleNotice = (event: EventRecord): boolean =>
  event.name === 'Notification' && event.notificationType === 'idle_prompt';

/**
 * Строки, которые дописывает MCP-сервер сессии, а не Claude Code (начало и конец `wait_for`): они могут
 * лечь и после `Stop` — вызов, брошенный прерыванием, дожидается своего таймаута, — и ход не начинают и
 * не заканчивают.
 */
const isWaitLine = (event: EventRecord): boolean =>
  event.name === 'ParleyWaitStart' || event.name === 'ParleyWaitEnd';

/**
 * Начало и конец работы субагентов: помощники Claude Code останавливаются и после `Stop` — десятками, — а
 * субагент посреди хода ход не заканчивает. Концом или началом хода они не служат.
 */
const isSubagentLine = (event: EventRecord): boolean =>
  event.name === 'SubagentStart' || event.name === 'SubagentStop';

/**
 * Лид закончил ход (`Stop`), а в последнем снимке были работающие фоновые субагенты: они гибнут вместе с
 * хостом, и работа лида прервана, хотя его собственный ход окончен. Состояние берётся на момент последнего
 * события, и давность падения не важна: хост мог лежать неделю.
 */
function hadBackgroundWork(journal: readonly EventRecord[]): boolean {
  const lastAt = Date.parse(journal.at(-1)?.at ?? '');
  return activityOf({ events: journal, now: lastAt }).tasks.some((task) => task.background);
}

/**
 * Упали посреди хода: последний хук хода журнала — не Stop и не SessionEnd, либо это `Stop` лида, чьи
 * фоновые субагенты ещё работали.
 */
export async function findInterrupted(
  entries: WorkEntry[],
  events: (ref: SessionRef) => Promise<readonly EventRecord[] | null>,
): Promise<SessionRef[]> {
  const found: SessionRef[] = [];
  for (const entry of entries) {
    // Архивную работу хост не поднимает до Reopen — предлагать её сессии некому.
    if (entry.map.work.status === 'archived') continue;
    for (const session of entry.map.sessions) {
      // Живые и закрытые не прерваны; `pending` ещё не начинала.
      if (session.lifecycle !== 'sleeping') continue;
      const ref: SessionRef = {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        sessionId: session.id,
      };
      const journal = await events(ref);
      if (journal === null) continue;
      const last = journal
        .filter((event) => !isIdleNotice(event) && !isWaitLine(event) && !isSubagentLine(event))
        .at(-1);
      if (last === undefined) continue;
      if (!ENDED.has(last.name) || (last.name === 'Stop' && hadBackgroundWork(journal))) {
        found.push(ref);
      }
    }
  }
  return found;
}
