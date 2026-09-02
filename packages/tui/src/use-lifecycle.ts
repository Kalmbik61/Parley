import { transitionSession, updateMap, type WorkEntry, type WorkSession } from '@harnas/core';
import { useEffect, useRef } from 'react';
import type { LiveMetrics } from './work-rows.js';
import { idleTransitions, transitionKey } from './work-lifecycle.js';

export interface LifecycleOptions {
  works: readonly WorkEntry[];
  /** Метрики живой сессии из индекса логов: от них считается молчание. */
  live: (session: WorkSession) => LiveMetrics;
  /** Жив ли процесс сессии у харнесса: без него `active → idle` не ставится. */
  alive: (projectPath: string, workId: string, sessionId: string) => boolean;
  /** Порог молчания; по умолчанию порог core. */
  idleMs?: number;
  now?: number;
}

/**
 * Статусы, которые ведёт харнесс: `active ↔ idle` по молчанию лога
 * (спецификация координации, раздел 6).
 *
 * Пересчёт идёт по событиям watcher — карт и логов, — а не по таймеру: своего
 * цикла опроса в UI нет (specs/ui.md). Поэтому `active → idle` записывается на
 * ближайшем событии после того, как порог пройден.
 */
export function useLifecycle({ works, live, alive, idleMs, now }: LifecycleOptions): void {
  // Запись асинхронна: пока она идёт, тот же переход не отправляется второй раз.
  const inFlight = useRef(new Set<string>());
  // Живые процессы — через ref: их набор меняется на каждый рендер панели, а
  // пересчитывать переходы надо только по событиям watcher.
  const running = useRef(alive);
  running.current = alive;

  useEffect(() => {
    const wanted = idleTransitions(works, live, {
      alive: (projectPath, workId, sessionId) => running.current(projectPath, workId, sessionId),
      ...(idleMs === undefined ? {} : { idleMs }),
      ...(now === undefined ? {} : { now }),
    });

    for (const transition of wanted) {
      const key = transitionKey(transition);
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);

      void updateMap(transition.projectPath, transition.workId, (map) => {
        transitionSession(map, transition.sessionId, transition.to);
      })
        // Карта занята или статус успел уехать — следующее событие watcher
        // попробует снова; ронять TUI из-за метрики простоя нельзя.
        .catch(() => {})
        .finally(() => inFlight.current.delete(key));
    }
  }, [works, live, idleMs, now]);
}
