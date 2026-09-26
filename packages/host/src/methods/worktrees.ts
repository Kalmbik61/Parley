/**
 * Методы `worktrees.*`: доступность, дифф, коммит, слияние и отбрасывание
 * (план, кусок 4.2). Правила живут в `worktrees/worktrees-service.ts` — здесь
 * только разбор параметров протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';

export interface WorktreesMethodDeps {
  worktrees: WorktreesService;
}

export interface WorktreesHandlers {
  worktreesAvailable: Handler<'worktrees.available'>;
  worktreesDiff: Handler<'worktrees.diff'>;
  worktreesCommit: Handler<'worktrees.commit'>;
  worktreesMerge: Handler<'worktrees.merge'>;
  worktreesDiscard: Handler<'worktrees.discard'>;
}

export function createWorktreesHandlers(deps: WorktreesMethodDeps): WorktreesHandlers {
  return {
    worktreesAvailable: async (params) => ({
      available: await deps.worktrees.available(params.projectPath),
    }),

    worktreesDiff: async (params) => deps.worktrees.diff(params.ref),

    worktreesCommit: async (params) => ({
      commit: await deps.worktrees.commit(params.ref, params.message),
    }),

    worktreesMerge: async (params) => deps.worktrees.merge(params.ref),

    worktreesDiscard: async (params) => {
      await deps.worktrees.discard(params.ref, params.force);
      return { ok: true };
    },
  };
}
