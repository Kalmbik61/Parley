/**
 * Методы `worktrees.*`: доступность, дифф, коммит, слияние и отбрасывание
 * (план, кусок 4.2), проверка конфликтов до слияния (кусок 8.1). Правила живут в `worktrees/worktrees-service.ts` — здесь
 * только разбор параметров протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { WorktreeHolds } from '../worktrees/holds.js';
import type { WorktreeSweeper } from '../worktrees/worktree-sweeper.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';

export interface WorktreesMethodDeps {
  worktrees: WorktreesService;
  /** Удержания окон; без них `worktrees.hold` ничего не запоминает. */
  holds?: WorktreeHolds;
  /** Служба уборки копий; без неё остатков нет и убрать копию нельзя. */
  sweeper?: WorktreeSweeper;
}

export interface WorktreesHandlers {
  worktreesAvailable: Handler<'worktrees.available'>;
  worktreesDiff: Handler<'worktrees.diff'>;
  worktreesCommit: Handler<'worktrees.commit'>;
  worktreesMerge: Handler<'worktrees.merge'>;
  worktreesDiscard: Handler<'worktrees.discard'>;
  worktreesMergeCheck: Handler<'worktrees.mergeCheck'>;
  worktreesHold: Handler<'worktrees.hold'>;
  worktreesLeftovers: Handler<'worktrees.leftovers'>;
  worktreesRemoveCopy: Handler<'worktrees.removeCopy'>;
}

export function createWorktreesHandlers(deps: WorktreesMethodDeps): WorktreesHandlers {
  return {
    worktreesAvailable: async (params) => {
      const [available, gitRoot] = await Promise.all([
        deps.worktrees.available(params.projectPath),
        deps.worktrees.gitRoot(params.projectPath),
      ]);
      return { available, gitRoot };
    },

    worktreesDiff: async (params) => deps.worktrees.diff(params.ref, params.patch),

    worktreesCommit: async (params) => ({
      commit: await deps.worktrees.commit(params.ref, params.message),
    }),

    worktreesMerge: async (params) => deps.worktrees.merge(params.ref),

    worktreesDiscard: async (params) => {
      await deps.worktrees.discard(params.ref, params.force);
      return { ok: true };
    },

    worktreesMergeCheck: async (params) => deps.worktrees.mergeCheck(params.ref),

    worktreesHold: async (params, request) => {
      deps.holds?.set(request.client, params.refs);
      return { ok: true };
    },

    worktreesLeftovers: async () => ({ items: deps.sweeper?.leftovers() ?? [] }),

    worktreesRemoveCopy: async (params) => {
      if (deps.sweeper === undefined) throw new HostError('internal', 'The worktree sweeper is not available.');
      return deps.sweeper.removeCopy(params.ref);
    },
  };
}
