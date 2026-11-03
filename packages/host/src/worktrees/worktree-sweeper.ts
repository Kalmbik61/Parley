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
  isGitRepo,
  readMap,
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
import { gitFailure } from './worktrees-service.js';
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
  /** Проект — репозиторий git; по умолчанию `isGitRepo` core, тесты подменяют. */
  isRepo?: (projectPath: string) => Promise<boolean>;
  /** Не чаще одного прохода за столько мс по `nudge()`; по умолчанию 10 с. */
  throttleMs?: number;
  /** Сколько мс помнить, что копию убрать не вышло (`dirty`/`refused`), прежде чем пробовать снова; по умолчанию 5 мин. */
  recheckMs?: number;
}

export interface WorktreeSweeper {
  start(): void;
  stop(): void;
  /** Просьба о проходе из потока изменений: проходы идут не чаще `throttleMs`, лишние просьбы сливаются в один. */
  nudge(): void;
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
  const isRepo = deps.isRepo ?? isGitRepo;
  const throttleMs = deps.throttleMs ?? 10_000;
  const recheckMs = deps.recheckMs ?? 300_000;

  let list: WorktreeLeftover[] = [];
  /** Размеры по пути копии: считаются один раз, в фоне. */
  const sizes = new Map<string, number | null>();
  const measuring = new Set<string>();
  /** Очередь замеров: `du` по одному, а не по одному на каждый новый остаток разом. */
  let sizeQueue: Promise<void> = Promise.resolve();
  /** Проекты не под git, о которых хост уже написал в журнал (один раз за запуск). */
  const notRepoLogged = new Set<string>();
  let loop: Promise<void> | null = null;
  let again = false;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | null = null;
  /** Неудачные уборки: ключ `refKey` + путь → когда проверено и что показано человеку. */
  const checked = new Map<string, { at: number; item: WorktreeLeftover }>();
  const checkKey = (ref: SessionRef, dir: string): string => `${refKey(ref)}\0${dir}`;
  /** Результат замка, когда хозяин или запись изменились с решения прохода: копию не трогали. */
  const SKIPPED = Symbol('skipped');
  /** Результат замка, когда перед самой уборкой пришло удержание окна: копия остаётся остатком `unsaved`. */
  const HELD = Symbol('held');

  function sizeOf(dir: string): number | null {
    if (sizes.has(dir)) return sizes.get(dir) ?? null;
    if (!measuring.has(dir)) {
      measuring.add(dir);
      sizeQueue = sizeQueue.then(() =>
        measure(dir)
          .catch(() => null)
          .then((bytes) => {
            sizes.set(dir, bytes);
            measuring.delete(dir);
            for (const item of list) if (item.path === dir) item.sizeBytes = bytes;
          }),
      );
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

  /** Запись всё ещё говорит, что копию пора убрать (карта перечитана под замком сессии). */
  async function stillDue(ref: SessionRef, dir: string): Promise<boolean> {
    const map = await readMap(ref.projectPath, ref.workId);
    const info = map.sessions.find((session) => session.id === ref.sessionId)?.worktree;
    return (
      info != null &&
      info.path === dir &&
      info.createdAt !== null &&
      info.removedAt == null &&
      sessionWorktreeFinished(map, ref.sessionId)
    );
  }

  async function onePass(): Promise<void> {
    if (!deps.holds.windowPresent()) {
      list = [];
      return;
    }
    const held = deps.holds.held();
    const next: WorktreeLeftover[] = [];
    const seen = new Set<string>();
    for (const entry of deps.works.snapshot().entries) {
      let repo: boolean | null = null;
      for (const session of entry.map.sessions) {
        if (stopped) return;
        const info = session.worktree;
        if (info == null || info.createdAt === null || info.removedAt != null) continue;
        if (!sessionWorktreeFinished(entry.map, session.id)) continue;
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        const key = checkKey(ref, info.path);
        try {
          repo ??= await isRepo(entry.projectPath);
          if (!repo) {
            if (!notRepoLogged.has(entry.projectPath)) {
              notRepoLogged.add(entry.projectPath);
              host.log.warn('проект не под git: копии его сессий не убираются', { projectPath: entry.projectPath });
            }
            continue;
          }
          if (held.has(refKey(ref))) {
            next.push(leftover(ref, session, info, 'unsaved'));
            continue;
          }
          const previous = checked.get(key);
          if (previous !== undefined && Date.now() - previous.at < recheckMs) {
            seen.add(key);
            next.push({ ...previous.item });
            continue;
          }
          const result = await deps.sessions.sweepGuard(ref, async () => {
            if (!(await stillDue(ref, info.path))) return SKIPPED;
            // Окно могло закрыться или принести несохранённую вкладку, пока проход ждал замок.
            if (!deps.holds.windowPresent()) return SKIPPED;
            if (deps.holds.held().has(refKey(ref))) return HELD;
            const outcome = await remove(entry.projectPath, info);
            if (outcome.removed) await markRemoved(ref, info.path);
            return outcome;
          });
          if (result === SKIPPED) continue;
          if (result === HELD) {
            next.push(leftover(ref, session, info, 'unsaved'));
            continue;
          }
          if (result === null) {
            next.push(leftover(ref, session, info, 'in-use'));
            continue;
          }
          if (result.removed) {
            checked.delete(key);
            host.log.info('копия сессии убрана', { ref, path: info.path, branchDeleted: result.branchDeleted });
            continue;
          }
          const item =
            result.reason === 'dirty'
              ? leftover(ref, session, info, 'dirty', { files: result.files })
              : leftover(ref, session, info, 'refused', { message: result.message });
          checked.set(key, { at: Date.now(), item });
          seen.add(key);
          next.push(item);
        } catch (error) {
          host.log.warn('уборка копии сессии не удалась', { ref, error: String(error) });
          // Остаток с текстом ошибки; запомненный, он не даёт повторять предупреждение на каждом проходе.
          const item = leftover(ref, session, info, 'refused', { message: String(error) });
          checked.set(key, { at: Date.now(), item });
          seen.add(key);
          next.push(item);
        }
      }
    }
    for (const key of checked.keys()) if (!seen.has(key)) checked.delete(key);
    // Размер мог досчитаться посреди прохода, когда записи ещё не было в `list`.
    for (const item of next) item.sizeBytes = sizes.get(item.path) ?? item.sizeBytes;
    const paths = new Set(next.map((item) => item.path));
    for (const dir of sizes.keys()) if (!paths.has(dir)) sizes.delete(dir);
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
      } while (again && !stopped);
    })().finally(() => {
      loop = null;
    });
    loop = running;
    return running;
  }

  function startPass(): void {
    lastStart = Date.now();
    void request();
  }

  function nudge(): void {
    if (stopped || timer !== null) return;
    const wait = lastStart + throttleMs - Date.now();
    if (wait <= 0) {
      startPass();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) startPass();
    }, wait);
    timer.unref();
  }

  return {
    start() {
      if (unsubscribe !== null) return;
      stopped = false;
      unsubscribe = deps.works.onChange(nudge);
      startPass();
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      again = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },

    nudge,

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
      checked.delete(checkKey(ref, info.path));
      let result: RemoveCopyResult | typeof SKIPPED | null;
      try {
        result = await deps.sessions.sweepGuard(ref, async () => {
          if (!(await stillDue(ref, info.path))) return SKIPPED;
          const outcome = await remove(ref.projectPath, info, { force: true });
          if (outcome.removed) await markRemoved(ref, info.path);
          return outcome;
        });
      } catch (error) {
        throw gitFailure(error);
      }
      if (result === null) throw new HostError('conflict', 'The session is running.');
      if (result === SKIPPED) throw new HostError('bad_request', 'The session is not finished yet.');
      if (result.removed) {
        const key = refKey(ref);
        list = list.filter((item) => refKey(item.ref) !== key);
      }
      return result;
    },
  };
}
