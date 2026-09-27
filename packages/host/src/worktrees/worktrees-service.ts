/**
 * Изоляция сессии в своём worktree из окна: дифф, коммит, слияние и отбрасывание
 * (план, кусок 4.2; спека 8.1–8.3, 10). Сами операции над git — чистые функции
 * core (`worktree.ts`, кусок 4.1); здесь — привязка к сессии по ссылке из
 * протокола и правила отказа, которых у core нет (там нет понятия «сессии»).
 */

import {
  commitProject,
  commitWorktree,
  discardWorktree,
  DirtyWorktreeError,
  GitStateError,
  InvalidRevisionError,
  isGitRepo,
  mergeCheck,
  mergeWorktree,
  NothingToCommitError,
  projectChanges,
  readMap,
  sessionTag,
  transitionSession,
  updateMap,
  worktreeDiff,
  type MergeCheck,
  type MergeResult,
  type ProjectChanges,
  type WorktreeDiff,
  type WorktreeInfo,
  type WorkSession,
} from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { HostError } from '../errors.js';
import type { SessionsService } from '../sessions/sessions-service.js';

export interface WorktreesService {
  /** Флажок «в своём worktree» в диалоге живёт, только пока проект — git-репозиторий. */
  available(projectPath: string): Promise<boolean>;
  /** `patch: false` — без текста патча: окну этапа 8 он не нужен, а строка протокола ограничена 8 МБ. */
  diff(ref: SessionRef, patch?: boolean): Promise<WorktreeDiff>;
  commit(ref: SessionRef, message: string): Promise<string>;
  merge(ref: SessionRef): Promise<MergeResult>;
  /** `force` — грязный worktree отбрасывается вместе с незакоммиченным (второе подтверждение окна). */
  discard(ref: SessionRef, force: boolean): Promise<void>;
  /** Конфликты слияния ветки в базу — без касания рабочих копий. */
  mergeCheck(ref: SessionRef): Promise<MergeCheck>;
  /** Изменения папки проекта — только у сессии без своего worktree (спека 11.5). */
  projectChanges(ref: SessionRef, patch?: boolean): Promise<ProjectChanges>;
  /** «Закоммитить всё в папке» — по кнопке человека, без `.harnas/`. */
  commitProject(ref: SessionRef, message: string): Promise<{ commit: string }>;
}

/**
 * Ошибка git → HostError с причиной в data: окно показывает свой английский текст по ней (8.2a), сообщение
 * хоста — только в консоль. GitStateError: git-missing — internal, not-a-repo и no-commits — bad_request,
 * data: { reason }; NothingToCommitError — conflict; InvalidRevisionError (база или ветка карты — не ревизия) —
 * bad_request без data; прочее — internal без data.
 */
export function gitFailure(error: unknown): HostError {
  if (error instanceof HostError) return error;
  if (error instanceof GitStateError) {
    const code = error.reason === 'git-missing' ? 'internal' : 'bad_request';
    return new HostError(code, error.message, { reason: error.reason });
  }
  if (error instanceof NothingToCommitError) return new HostError('conflict', 'нет изменений для коммита');
  if (error instanceof InvalidRevisionError) return new HostError('bad_request', error.message);
  return new HostError('internal', error instanceof Error ? error.message : String(error));
}

/** Вызов core с ошибкой git, переведённой в код протокола. */
async function viaGit<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw gitFailure(error);
  }
}

async function requireSession(ref: SessionRef): Promise<WorkSession> {
  const map = await readMap(ref.projectPath, ref.workId);
  const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
  if (session === undefined) throw new HostError('not_found', `сессии ${ref.sessionId} нет в карте`);
  return session;
}

/** Сессия и её worktree по ссылке — общий отказ для всех методов ниже. */
async function requireWorktree(
  ref: SessionRef,
): Promise<{ label: string; worktree: WorktreeInfo }> {
  const session = await requireSession(ref);
  if (session.worktree === null) {
    throw new HostError('bad_request', `у сессии ${ref.sessionId} нет своего worktree`);
  }
  return { label: session.label, worktree: session.worktree };
}

/** `changes.*` — только у сессии, что работает прямо в папке проекта: у своей копии свой дифф. */
async function requireNoWorktree(ref: SessionRef): Promise<void> {
  const session = await requireSession(ref);
  if (session.worktree !== null) {
    throw new HostError('bad_request', `у сессии ${ref.sessionId} свой worktree — смотрите worktrees.diff`);
  }
}

export function createWorktreesService(
  sessions: Pick<SessionsService, 'stop'>,
): WorktreesService {
  return {
    available: (projectPath) => isGitRepo(projectPath),

    async diff(ref, patch) {
      const { worktree } = await requireWorktree(ref);
      return viaGit(() => worktreeDiff(ref.projectPath, worktree, patch === undefined ? {} : { patch }));
    },

    async commit(ref, message) {
      const { worktree } = await requireWorktree(ref);
      return commitWorktree(worktree, message);
    },

    async merge(ref) {
      const { label, worktree } = await requireWorktree(ref);
      const message = `harnas: влить ${sessionTag(ref.sessionId)} (${label}) из ${worktree.branch}`;
      try {
        return await mergeWorktree(ref.projectPath, worktree, message);
      } catch (error) {
        // Только отказ по ревизии — bad_request; прочий сбой merge идёт как раньше (internal с логом сервера).
        if (error instanceof InvalidRevisionError) throw gitFailure(error);
        throw error;
      }
    },

    async discard(ref, force) {
      const { worktree } = await requireWorktree(ref);
      // Сначала процесс: работающий агент с открытой рабочей копией под ногами
      // пережил бы удаление своего же каталога (спека 8.3).
      await sessions.stop(ref);
      if (worktree.createdAt !== null) {
        try {
          await discardWorktree(ref.projectPath, worktree, { force });
        } catch (error) {
          if (error instanceof DirtyWorktreeError) throw new HostError('conflict', error.message);
          if (error instanceof InvalidRevisionError) throw gitFailure(error);
          throw error;
        }
      }
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session !== undefined && session.lifecycle !== 'closed') {
          transitionSession(map, ref.sessionId, 'closed');
        }
      });
    },

    async mergeCheck(ref) {
      const { worktree } = await requireWorktree(ref);
      return viaGit(() => mergeCheck(ref.projectPath, worktree));
    },

    async projectChanges(ref, patch) {
      await requireNoWorktree(ref);
      return viaGit(() => projectChanges(ref.projectPath, patch === undefined ? {} : { patch }));
    },

    async commitProject(ref, message) {
      await requireNoWorktree(ref);
      return viaGit(() => commitProject(ref.projectPath, message));
    },
  };
}
