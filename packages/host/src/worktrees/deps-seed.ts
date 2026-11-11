/**
 * Шаг запуска «клон зависимостей в новую копию» на хосте: очередь клонов (не больше двух сразу),
 * вызов `seedWorktree` из core, уведомления человеку (каждый вид раз на проект за жизнь службы)
 * и запись итога для карты. Сбой шага наружу не бросается: запуск сессии идёт дальше.
 */
import {
  seedWorktree,
  sessionTag,
  toWorktreeSeed,
  type WorktreeInfo,
  type WorktreeSeed,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';

export interface DepsSeederDeps {
  seed?: typeof seedWorktree;
  now?: () => Date;
  /** Сколько клонов идёт сразу; по умолчанию 2. */
  concurrency?: number;
}

export interface DepsSeeder {
  /** Клон и уведомления; запись для карты или null. Не бросает. */
  run(ref: SessionRef, info: WorktreeInfo): Promise<WorktreeSeed | null>;
}

const DEFAULT_CONCURRENCY = 2;

export function createDepsSeeder(host: HostContext, deps: DepsSeederDeps = {}): DepsSeeder {
  const seed = deps.seed ?? seedWorktree;
  const now = deps.now ?? (() => new Date());
  const limit = deps.concurrency ?? DEFAULT_CONCURRENCY;

  // Очередь: счётчик идущих клонов и FIFO ждущих; освободившееся место переходит первому в очереди.
  let active = 0;
  const waiting: Array<() => void> = [];
  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  function release(): void {
    const next = waiting.shift();
    if (next !== undefined) next();
    else active -= 1;
  }

  const notified: Record<'deps-clone-unavailable' | 'deps-clone-mismatch', Set<string>> = {
    'deps-clone-unavailable': new Set(),
    'deps-clone-mismatch': new Set(),
  };
  function notifyOnce(kind: keyof typeof notified, ref: SessionRef, text: string): void {
    if (notified[kind].has(ref.projectPath)) return;
    notified[kind].add(ref.projectPath);
    host.broadcast('host.notice', { kind, ref, text, at: now().toISOString() });
  }

  return {
    async run(ref, info) {
      await acquire();
      try {
        const report = await seed(ref.projectPath, info.path);
        if (report === null) return null;
        const tag = sessionTag(ref.sessionId);
        if (report.unavailable) {
          notifyOnce(
            'deps-clone-unavailable',
            ref,
            `Dependencies were not cloned into the worktree of ${tag}: the worktree root is on another volume or not on APFS. Set the worktree root to a folder on the same volume as ${report.sourceRoot}.`,
          );
        }
        if (report.lockMismatch.length > 0 || report.stale) {
          notifyOnce(
            'deps-clone-mismatch',
            ref,
            `Dependencies cloned from ${report.sourceRoot} do not match the lock file of the worktree of ${tag}; its agent has to run the install. If this repeats, update the dependencies in ${report.sourceRoot}.`,
          );
        }
        return toWorktreeSeed(report, now().toISOString());
      } catch (error) {
        host.log.warn('клон зависимостей в копию не удался', { ref, error: String(error) });
        return null;
      } finally {
        release();
      }
    },
  };
}
