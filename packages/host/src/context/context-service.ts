/**
 * Опрос заполненности контекста (спека 2026-10-15, 4.3): раз в 5 секунд хост перечитывает `context/<сессия>.json`
 * каждой запущенной сессии не-Codex (Claude Code, GLM) и отдаёт значение `ActivityService.setContext` — тот
 * пересчитывает метрики только при изменении. Файл пишет строка статуса, а не хук: без опроса значение после
 * последнего ответа могло бы ждать следующего события. У Codex процент — из последней записи `token_count`
 * в хвосте rollout-лога (хвост на сессию): `fs.watch` на `~/.codex/sessions` дозаписи не доставляет, индекс логов
 * для Codex застывает (приёмка 2026-10-16).
 */

import { byFamily, codexContextFill, openEvents, qwenContextFill, readContextFill, workPaths, type ContextFill, type EventRecord, type EventsLog, type RolloutRecord } from '@parley/core';
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
  /** Qwen hook journal of a session (its `Stop` carries `context_usage`); tests substitute it. */
  qwenEvents?: (ref: SessionRef) => Promise<readonly EventRecord[] | null>;
  intervalMs?: number;
}): ContextService {
  const read = deps.read ?? readContextFill;
  const codexTail = deps.codexTail ?? ((file: string, seedMaxBytes: number) => createRolloutTail(file, { seedMaxBytes }));
  const tails = new Map<string, { file: string; tail: { read(): Promise<RolloutRecord[]> } }>();
  // One journal reader per work, parsed as Qwen: it keeps its offsets and reads only new lines.
  const qwenJournals = new Map<string, EventsLog>();
  const qwenEvents = deps.qwenEvents ?? ((ref: SessionRef) => {
    const dir = workPaths(ref.projectPath, ref.workId).events;
    let journal = qwenJournals.get(dir);
    if (journal === undefined) {
      journal = openEvents(dir, 'qwen');
      qwenJournals.set(dir, journal);
    }
    return journal.read(ref.sessionId);
  });

  /** Qwen: the context fill of the latest `Stop` with `context_usage` (spec 2026-11-11, 3.4); none yet — keep the old value. */
  async function tickQwen(ref: SessionRef): Promise<void> {
    const events = await qwenEvents(ref).catch(() => null);
    const stop = events?.findLast((event) => event.name === 'Stop' && event.contextUsage !== undefined);
    const fill = stop === undefined ? null : qwenContextFill(stop.contextUsage, stop.contextLimit, stop.at);
    if (fill !== null) deps.activity.setContext(ref, fill);
  }
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
        await byFamily(provider ?? 'claude', {
          claude: async () => deps.activity.setContext(ref, await read(workPaths(ref.projectPath, ref.workId).dir, ref.sessionId)),
          codex: () => tickCodex(ref),
          qwen: () => tickQwen(ref),
          opencode: async () => undefined,
          neutral: async () => undefined,
        })();
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
