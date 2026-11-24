/**
 * Методы `changes.*`: изменения папки проекта и «закоммитить всё в папке» для
 * сессии без своего worktree (кусок 8.1, спека 11.5). Правила — в
 * `worktrees/worktrees-service.ts`, как у `worktrees.*`; здесь — только разбор
 * параметров протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';

export interface ChangesMethodDeps {
  worktrees: WorktreesService;
}

export interface ChangesHandlers {
  changesProject: Handler<'changes.project'>;
  changesVersion: Handler<'changes.version'>;
  changesCommitProject: Handler<'changes.commitProject'>;
}

export function createChangesHandlers(deps: ChangesMethodDeps): ChangesHandlers {
  return {
    changesProject: async (params) => deps.worktrees.projectChanges(params.ref, params.patch),
    changesVersion: async (params) => ({ version: await deps.worktrees.projectVersion(params.ref) }),
    changesCommitProject: async (params) => deps.worktrees.commitProject(params.ref, params.message),
  };
}
