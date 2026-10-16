/**
 * Опрос заполненности контекста (спека 2026-10-15, 4.3): раз в 5 секунд хост перечитывает `context/<сессия>.json`
 * каждой запущенной сессии не-Codex (Claude Code, GLM) и отдаёт значение `ActivityService.setContext` — тот
 * пересчитывает метрики только при изменении. Файл пишет строка статуса, а не хук: без опроса значение после
 * последнего ответа могло бы ждать следующего события. У Codex процент — из последней записи `token_count`
 * в хвосте rollout-лога (хвост на сессию): `fs.watch` на `~/.codex/sessions` дозаписи не доставляет, индекс логов
 * для Codex застывает (приёмка 2026-10-16).
 */

import { codexContextFill, readContextFill, workPaths, type ContextFill, type RolloutRecord } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { createRolloutTail } from '../feed/codex-source.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { PtyManager } from '../pty/pty-manager.js';

export const CONTEXT_POLL_MS = 5_000;
/** Первое чтение хвоста Codex берёт последний мегабайт, чтобы найти последний `token_count`. */
const CODEX_SEED_BYTES = 1024 * 1024;

export interface ContextService {
  start(): void;
  stop(): void;
  /** Один проход опроса; тестам и первому чтению. */
  tick(): Promise<void>;
}

export function createContextService(deps: {
  pty: Pick<PtyManager, 'list'>;
  activity: Pick<ActivityService, 'setContext' | 'logFile'>;
  read?: (workDir: string, sessionId: string) => Promise<ContextFill | null>;
  codexTail?: (file: string, seedMaxBytes: number) => { read(): Promise<RolloutRecord[]> };
  intervalMs?: number;
}): ContextService {
  const read = deps.read ?? readContextFill;
  const codexTail = deps.codexTail ?? ((file: string, seedMaxBytes: number) => createRolloutTail(file, { seedMaxBytes }));
  const tails = new Map<string, { file: string; tail: { read(): Promise<RolloutRecord[]> } }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tickCodex(ref: SessionRef): Promise<void> {
    const key = refKey(ref);
    const file = deps.activity.logFile(ref);
    if (file === null) return;
    let entry = tails.get(key);
    if (entry === undefined || entry.file !== file) {
      entry = { file, tail: codexTail(file, CODEX_SEED_BYTES) };
      tails.set(key, entry);
    }
    let fill: ContextFill | null = null;
    for (const record of await entry.tail.read()) {
      if (record.type !== 'event_msg' || record.payload['type'] !== 'token_count') continue;
      fill = codexContextFill(record.payload['info'], record.at) ?? fill;
    }
    // Новых token_count нет — прежнее значение не стираем.
    if (fill !== null) deps.activity.setContext(ref, fill);
  }

  const tick = async (): Promise<void> => {
    const handles = deps.pty.list();
    const live = new Set(handles.map((handle) => refKey(handle.ref)));
    for (const key of Array.from(tails.keys())) if (!live.has(key)) tails.delete(key);
    await Promise.all(
      handles.map(async ({ ref, provider }) => {
        if (provider === 'codex') await tickCodex(ref);
        else deps.activity.setContext(ref, await read(workPaths(ref.projectPath, ref.workId).dir, ref.sessionId));
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
