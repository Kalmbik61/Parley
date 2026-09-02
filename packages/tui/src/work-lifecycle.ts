/**
 * Жизненный цикл сессий, который ведёт харнесс: `active ↔ idle` по молчанию
 * лога провайдера (спецификация координации, раздел 6).
 *
 * Здесь только чистый расчёт: что и куда перевести. Запись в карту делает
 * `use-lifecycle`, выход процесса — PTY-слой (у него есть код выхода).
 */

import { deriveStatus, type IdleOptions, type SessionStatus, type WorkEntry } from '@harnas/core';
import type { LiveMetrics } from './work-rows.js';

export interface StatusTransition {
  projectPath: string;
  workId: string;
  sessionId: string;
  to: SessionStatus;
}

/** Ключ перехода: по нему повторная попытка не отправляется, пока идёт запись. */
export const transitionKey = (transition: StatusTransition): string =>
  `${transition.projectPath} ${transition.workId} ${transition.sessionId} ${transition.to}`;

/**
 * Переходы по молчанию логов для всех видимых работ. Метрики живой сессии
 * приходят из индекса логов, который и так живёт по событиям watcher.
 */
export function idleTransitions(
  works: readonly WorkEntry[],
  live: (session: WorkEntry['map']['sessions'][number]) => LiveMetrics,
  options: IdleOptions = {},
): StatusTransition[] {
  const found: StatusTransition[] = [];
  for (const entry of works) {
    for (const session of entry.map.sessions) {
      if (session.status !== 'active' && session.status !== 'idle') continue;
      const to = deriveStatus(session.status, live(session).lastRecordAt, options);
      if (to === null) continue;
      found.push({
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        sessionId: session.id,
        to,
      });
    }
  }
  return found;
}
