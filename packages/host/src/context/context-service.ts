/**
 * Опрос заполненности контекста (спека 2026-10-15, 4.3): раз в 5 секунд хост перечитывает `context/<сессия>.json`
 * каждой запущенной сессии не-Codex (Claude Code, GLM) и отдаёт значение `ActivityService.setContext` — тот
 * пересчитывает метрики только при изменении. Файл пишет строка статуса, а не хук: без опроса значение после
 * последнего ответа могло бы ждать следующего события. У Codex процент — из индекса лога, здесь он не читается.
 */

import { readContextFill, workPaths, type ContextFill } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { PtyManager } from '../pty/pty-manager.js';

export const CONTEXT_POLL_MS = 5_000;

export interface ContextService {
  start(): void;
  stop(): void;
  /** Один проход опроса; тестам и первому чтению. */
  tick(): Promise<void>;
}

export function createContextService(deps: {
  pty: Pick<PtyManager, 'list'>;
  activity: Pick<ActivityService, 'setContext'>;
  read?: (workDir: string, sessionId: string) => Promise<ContextFill | null>;
  intervalMs?: number;
}): ContextService {
  const read = deps.read ?? readContextFill;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    const handles = deps.pty.list().filter((handle) => handle.provider !== 'codex');
    await Promise.all(
      handles.map(async ({ ref }) => {
        deps.activity.setContext(ref, await read(workPaths(ref.projectPath, ref.workId).dir, ref.sessionId));
      }),
    );
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        // Медленный диск: следующий проход не начинается поверх незаконченного.
        if (inFlight) return;
        inFlight = true;
        void tick()
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      }, deps.intervalMs ?? CONTEXT_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
