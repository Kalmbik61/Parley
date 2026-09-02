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

export interface IdleScanOptions extends IdleOptions {
  /**
   * Жив ли процесс сессии у харнесса. `idle` — это «жив, но молчит»
   * (спецификация, раздел 6), а у сессии, запущенной вне TUI, PTY у нас нет:
   * молчащую от мёртвой там не отличить, и статус мы ей не переписываем.
   */
  alive: (projectPath: string, workId: string, sessionId: string) => boolean;
}

/**
 * Переходы по молчанию логов для всех видимых работ. Метрики живой сессии
 * приходят из индекса логов, который и так живёт по событиям watcher.
 */
export function idleTransitions(
  works: readonly WorkEntry[],
  live: (session: WorkEntry['map']['sessions'][number]) => LiveMetrics,
  { alive, ...options }: IdleScanOptions,
): StatusTransition[] {
  const found: StatusTransition[] = [];
  for (const entry of works) {
    for (const session of entry.map.sessions) {
      if (session.status !== 'active' && session.status !== 'idle') continue;
      const to = deriveStatus(session.status, live(session).lastRecordAt, options);
      if (to === null) continue;
      // Обратный переход условия «процесс жив» не требует: новая запись в логе
      // сама доказывает, что сессия работает.
      if (to === 'idle' && !alive(entry.projectPath, entry.map.work.id, session.id)) continue;
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
