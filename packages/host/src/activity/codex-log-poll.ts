/**
 * Опрос журналов запущенных сессий Codex. Рекурсивный `fs.watch` на `~/.codex/sessions` под macOS дозаписи
 * rollout-файлов не доставляет (Codex держит файл открытым): индекс логов застывал на моменте создания файла,
 * и активность, расход токенов, модель и субагенты ждали перезапуска. Поэтому раз в две секунды смотрим
 * размер и mtime файлов запущенных сессий и перечитываем изменившиеся — после затишья (не посреди записи),
 * но не реже `CODEX_LOG_MAX_STALE_MS` у непрерывно растущего файла.
 */

import { stat as fsStat } from 'node:fs/promises';
import type { ActivityService } from './activity-service.js';
import type { PtyManager } from '../pty/pty-manager.js';

export const CODEX_LOG_POLL_MS = 2_000;
export const CODEX_LOG_QUIET_MS = 2_000;
export const CODEX_LOG_MAX_STALE_MS = 30_000;

export interface CodexLogPoller {
  start(): void;
  stop(): void;
  /** Один проход; тестам. */
  tick(): Promise<void>;
}

interface Tracked {
  /** Последняя увиденная подпись `size:mtimeMs` и когда она сменилась. */
  seen: string;
  changedAt: number;
  /** Подпись последнего перечитывания и его момент; `null` — ещё не перечитывали. */
  reindexed: string | null;
  reindexedAt: number;
}

export function createCodexLogPoller(deps: {
  pty: Pick<PtyManager, 'list'>;
  activity: Pick<ActivityService, 'codexLogFiles' | 'reindexLog'>;
  stat?: (file: string) => Promise<{ size: number; mtimeMs: number } | null>;
  now?: () => number;
  intervalMs?: number;
  quietMs?: number;
  maxStaleMs?: number;
}): CodexLogPoller {
  const stat = deps.stat ?? (async (file) => fsStat(file).then((info) => ({ size: info.size, mtimeMs: info.mtimeMs }), () => null));
  const now = deps.now ?? Date.now;
  const quietMs = deps.quietMs ?? CODEX_LOG_QUIET_MS;
  const maxStaleMs = deps.maxStaleMs ?? CODEX_LOG_MAX_STALE_MS;
  const tracked = new Map<string, Tracked>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const targets = new Set<string>();
      for (const handle of deps.pty.list()) {
        if (handle.provider !== 'codex') continue;
        for (const file of deps.activity.codexLogFiles(handle.ref)) targets.add(file);
      }
      for (const file of tracked.keys()) if (!targets.has(file)) tracked.delete(file);

      for (const file of targets) {
        const info = await stat(file);
        if (info === null) continue;
        const signature = `${info.size}:${info.mtimeMs}`;
        const at = now();
        let entry = tracked.get(file);
        if (entry === undefined) {
          // Первое знакомство — изменение: перечитаем после затишья.
          entry = { seen: signature, changedAt: at, reindexed: null, reindexedAt: at };
          tracked.set(file, entry);
        } else if (entry.seen !== signature) {
          entry.seen = signature;
          entry.changedAt = at;
        }
        if (signature === entry.reindexed) continue;
        if (at - entry.changedAt < quietMs && at - entry.reindexedAt < maxStaleMs) continue;
        entry.reindexed = signature;
        entry.reindexedAt = at;
        try {
          await deps.activity.reindexLog(file);
        } catch {
          // Сбой разбора одного файла опрос не роняет; следующая смена подписи попробует снова.
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), deps.intervalMs ?? CODEX_LOG_POLL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      tracked.clear();
    },
    tick,
  };
}
