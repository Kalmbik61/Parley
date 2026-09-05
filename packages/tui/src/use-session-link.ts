import type { MetricsRoots, SessionIndex, WorkEntry } from '@harnas/core';
import { useEffect, useRef } from 'react';
import { linkSession } from './work-launch.js';

export interface SessionLinkOptions {
  works: readonly WorkEntry[];
  /**
   * Индекс логов. Здесь он не читается: его обновление — сигнал, что у
   * провайдера появился новый лог, и привязку стоит попробовать ещё раз.
   */
  sessions: readonly SessionIndex[];
  roots?: MetricsRoots;
}

/**
 * Привязка живых сессий к логам провайдеров, которые не принимают id снаружи
 * (codex): id ищется по cwd и времени запуска (спецификация, раздел 5).
 *
 * Лог появляется через мгновение после запуска процесса, поэтому попытка
 * повторяется на событиях watcher — карт и логов, — а не по таймеру: своего
 * цикла опроса в UI нет (specs/ui.md). Привязанная сессия из кандидатов уходит.
 */
export function useSessionLink({ works, sessions, roots }: SessionLinkOptions): void {
  // Поиск асинхронен: пока он идёт, та же сессия второй раз не берётся.
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        if (session.providerSessionId !== null || session.startedAt === null) continue;
        if (session.status !== 'active') continue;

        const key = `${entry.projectPath} ${entry.map.work.id} ${session.id}`;
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);

        void linkSession(entry.projectPath, entry.map.work.id, session, roots)
          // Неизвестный провайдер, занятая карта, нечитаемый лог — следующее
          // событие попробует снова; ронять TUI из-за привязки нельзя.
          .catch(() => {})
          .finally(() => inFlight.current.delete(key));
      }
    }
  }, [works, sessions, roots]);
}
