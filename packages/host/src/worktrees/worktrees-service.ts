/**
 * Изоляция сессии в своём worktree из окна: дифф, коммит, слияние и отбрасывание
 * (план, кусок 4.2; спека 8.1–8.3, 10). Сами операции над git — чистые функции
 * core (`worktree.ts`, кусок 4.1); здесь — привязка к сессии по ссылке из
 * протокола и правила отказа, которых у core нет (там нет понятия «сессии»).
 */

import {
  commitWorktree,
  discardWorktree,
  DirtyWorktreeError,
  isGitRepo,
  mergeWorktree,
  readMap,
  sessionTag,
  transitionSession,
  updateMap,
  worktreeDiff,
  type MergeResult,
  type WorktreeDiff,
  type WorktreeInfo,
} from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { HostError } from '../errors.js';
import type { SessionsService } from '../sessions/sessions-service.js';

export interface WorktreesService {
  /** Флажок «в своём worktree» в диалоге живёт, только пока проект — git-репозиторий. */
  available(projectPath: string): Promise<boolean>;
  diff(ref: SessionRef): Promise<WorktreeDiff>;
  commit(ref: SessionRef, message: string): Promise<string>;
  merge(ref: SessionRef): Promise<MergeResult>;
  /** `force` — грязный worktree отбрасывается вместе с незакоммиченным (второе подтверждение окна). */
  discard(ref: SessionRef, force: boolean): Promise<void>;
}

/** Сессия и её worktree по ссылке — общий отказ для всех методов ниже. */
async function requireWorktree(
  ref: SessionRef,
): Promise<{ label: string; worktree: WorktreeInfo }> {
  const map = await readMap(ref.projectPath, ref.workId);
  const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
  if (session === undefined) throw new HostError('not_found', `сессии ${ref.sessionId} нет в карте`);
  if (session.worktree === null) {
    throw new HostError('bad_request', `у сессии ${ref.sessionId} нет своего worktree`);
  }
  return { label: session.label, worktree: session.worktree };
}

export function createWorktreesService(
  sessions: Pick<SessionsService, 'stop'>,
): WorktreesService {
  return {
    available: (projectPath) => isGitRepo(projectPath),

    async diff(ref) {
      const { worktree } = await requireWorktree(ref);
      return worktreeDiff(ref.projectPath, worktree);
    },

    async commit(ref, message) {
      const { worktree } = await requireWorktree(ref);
      return commitWorktree(worktree, message);
    },

    async merge(ref) {
      const { label, worktree } = await requireWorktree(ref);
      const message = `harnas: влить ${sessionTag(ref.sessionId)} (${label}) из ${worktree.branch}`;
      return mergeWorktree(ref.projectPath, worktree, message);
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
  };
}
