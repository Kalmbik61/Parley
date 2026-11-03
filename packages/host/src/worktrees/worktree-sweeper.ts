/**
 * Фоновая уборка копий git (спека 2026-11-03, 4.1). Копия сессии, чей хозяин закончил (сессия закрыта, работа или комната
 * в архиве), убирается с диска: каталог уходит, ветка остаётся, если не влита в базу, а в записи сессии появляется
 * `removedAt`. Что убрать не удалось, остаётся «остатком»: окно показывает его человеку, решение за ним.
 *
 * Проход идёт только при открытом окне (без него неизвестно, держит ли вкладка несохранённые правки), копии — по одной.
 * Запись `removedAt` делается внутри замка сессии (`sweepGuard`): запуск, что ждёт этот замок, иначе успел бы создать
 * копию заново, и поздняя запись пометила бы живую копию убранной.
 */

import { execFile } from 'node:child_process';
import {
  removeWorktreeCopy,
  sessionWorktreeFinished,
  updateMap,
  type RemoveCopyResult,
  type WorktreeLeftover,
  type WorkSession,
  type WorktreeInfo,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WorksService } from '../works/works-service.js';
import type { WorktreeHolds } from './holds.js';

export interface WorktreeSweeperDeps {
  works: Pick<WorksService, 'snapshot' | 'onChange'>;
  sessions: Pick<SessionsService, 'sweepGuard'>;
  holds: Pick<WorktreeHolds, 'held' | 'windowPresent'>;
  /** Уборка одной копии; тесты подменяют. */
  remove?: typeof removeWorktreeCopy;
  /** Размер каталога в байтах; сбой — `null`. По умолчанию `du -sk`. */
  size?: (dir: string) => Promise<number | null>;
  now?: () => Date;
}

export interface WorktreeSweeper {
  start(): void;
  stop(): void;
  /** Один проход (или ожидание идущего вместе с повтором, если он заказан). */
  pass(): Promise<void>;
  leftovers(): WorktreeLeftover[];
  /** Принудительная уборка по просьбе человека: грязная копия тоже уходит. */
  removeCopy(ref: SessionRef): Promise<RemoveCopyResult>;
}

/** `du -sk -- <dir>` без оболочки; любой сбой — `null`. */
function duSize(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', '--', dir], (error, stdout) => {
      const kib = error === null ? Number.parseInt(stdout, 10) : Number.NaN;
      resolve(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

export function createWorktreeSweeper(host: HostContext, deps: WorktreeSweeperDeps): WorktreeSweeper {
  const remove = deps.remove ?? removeWorktreeCopy;
  const measure = deps.size ?? duSize;
  const now = deps.now ?? ((): Date => new Date());

  let list: WorktreeLeftover[] = [];
  /** Размеры по пути копии: считаются один раз, в фоне. */
  const sizes = new Map<string, number | null>();
  const measuring = new Set<string>();
  let loop: Promise<void> | null = null;
  let again = false;
  let unsubscribe: (() => void) | null = null;

  function sizeOf(dir: string): number | null {
    if (sizes.has(dir)) return sizes.get(dir) ?? null;
    if (!measuring.has(dir)) {
      measuring.add(dir);
      void measure(dir)
        .catch(() => null)
        .then((bytes) => {
          sizes.set(dir, bytes);
          measuring.delete(dir);
          for (const item of list) if (item.path === dir) item.sizeBytes = bytes;
        });
    }
    return null;
  }

  function leftover(
    ref: SessionRef,
    session: WorkSession,
    info: WorktreeInfo,
    reason: WorktreeLeftover['reason'],
    extra: { files?: number; message?: string } = {},
  ): WorktreeLeftover {
    return {
      ref,
      label: session.label,
      path: info.path,
      branch: info.branch,
      reason,
      files: extra.files ?? null,
      message: extra.message ?? null,
      sizeBytes: sizeOf(info.path),
    };
  }

  /** Запись `removedAt`, пока замок сессии ещё у уборки; только если запись всё та же и ещё не помечена. */
  async function markRemoved(ref: SessionRef, dir: string): Promise<void> {
    const at = now().toISOString();
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const info = map.sessions.find((session) => session.id === ref.sessionId)?.worktree;
      if (info != null && info.path === dir && (info.removedAt == null || info.removedAt === '')) info.removedAt = at;
    });
  }

  async function onePass(): Promise<void> {
    if (!deps.holds.windowPresent()) {
      list = [];
      return;
    }
    const held = deps.holds.held();
    const next: WorktreeLeftover[] = [];
    for (const entry of deps.works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        const info = session.worktree;
        if (info == null || info.createdAt === null || info.removedAt != null) continue;
        if (!sessionWorktreeFinished(entry.map, session.id)) continue;
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        try {
          if (held.has(refKey(ref))) {
            next.push(leftover(ref, session, info, 'unsaved'));
            continue;
          }
          const result = await deps.sessions.sweepGuard(ref, async () => {
            const outcome = await remove(entry.projectPath, info);
            if (outcome.removed) await markRemoved(ref, info.path);
            return outcome;
          });
          if (result === null) {
            next.push(leftover(ref, session, info, 'in-use'));
          } else if (result.removed) {
            host.log.info('копия сессии убрана', { ref, path: info.path, branchDeleted: result.branchDeleted });
          } else if (result.reason === 'dirty') {
            next.push(leftover(ref, session, info, 'dirty', { files: result.files }));
          } else {
            next.push(leftover(ref, session, info, 'refused', { message: result.message }));
          }
        } catch (error) {
          host.log.warn('уборка копии сессии не удалась', { ref, error: String(error) });
        }
      }
    }
    // Размер мог досчитаться посреди прохода, когда записи ещё не было в `list`.
    for (const item of next) item.sizeBytes = sizes.get(item.path) ?? item.sizeBytes;
    list = next;
  }

  function request(): Promise<void> {
    if (loop !== null) {
      again = true;
      return loop;
    }
    const running = (async (): Promise<void> => {
      do {
        again = false;
        try {
          await onePass();
        } catch (error) {
          host.log.error('уборка копий: проход не удался', { error: String(error) });
        }
      } while (again);
    })().finally(() => {
      loop = null;
    });
    loop = running;
    return running;
  }

  return {
    start() {
      if (unsubscribe !== null) return;
      unsubscribe = deps.works.onChange(() => {
        void request();
      });
      void request();
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      again = false;
    },

    pass: request,

    leftovers: () => list.map((item) => ({ ...item })),

    async removeCopy(ref) {
      const entry = deps.works.snapshot().entries.find((candidate) => candidate.map.work.id === ref.workId && candidate.projectPath === ref.projectPath);
      const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (entry === undefined || session === undefined || session.worktree == null) {
        throw new HostError('bad_request', 'The session has no worktree copy.');
      }
      if (!sessionWorktreeFinished(entry.map, session.id)) {
        throw new HostError('bad_request', 'The session is not finished yet.');
      }
      const info = session.worktree;
      const result = await deps.sessions.sweepGuard(ref, async () => {
        const outcome = await remove(ref.projectPath, info, { force: true });
        if (outcome.removed) await markRemoved(ref, info.path);
        return outcome;
      });
      if (result === null) throw new HostError('conflict', 'The session is running.');
      if (result.removed) {
        const key = refKey(ref);
        list = list.filter((item) => refKey(item.ref) !== key);
      }
      return result;
    },
  };
}
