import path from 'node:path';
import { readMap, sessionRoleCatalog, roleSummaries } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
export function createRolesList(catalog = sessionRoleCatalog): Handler<'roles.list'> {
  return async ({ projectPath, ref }) => {
    if (!path.isAbsolute(projectPath) || (ref && ref.projectPath !== projectPath)) throw new HostError('bad_request', 'projectPath must match the session project');
    let cwd = projectPath;
    if (ref) {
      const map = await readMap(projectPath, ref.workId);
      const session = map.sessions.find(item => item.id === ref.sessionId);
      if (!session) throw new HostError('not_found', 'session not found');
      cwd = session.worktree?.path ?? projectPath;
    }
    return roleSummaries(await catalog(cwd, { codex: true }));
  };
}
