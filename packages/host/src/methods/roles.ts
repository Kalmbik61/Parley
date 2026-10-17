import path from 'node:path';
import { readMap, sessionRoleCatalog, roleSummaries } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { WorksService } from '../works/works-service.js';
export function createRolesList(catalog = sessionRoleCatalog, works?: Pick<WorksService, 'entry'>): Handler<'roles.list'> {
  return async ({ projectPath, ref }) => {
    if (!path.isAbsolute(projectPath) || (ref && ref.projectPath !== projectPath)) throw new HostError('bad_request', 'projectPath must match the session project');
    let cwd = projectPath;
    if (ref) {
      // Сессия из памяти сервиса работ: чип роли шлёт запрос на каждую плашку, диск перечитывать незачем.
      // Не нашли (работа или сессия только появились) — карта с диска, как раньше.
      const find = (map: { sessions: Array<{ id: string; worktree?: { path: string } | null }> }) =>
        map.sessions.find(item => item.id === ref.sessionId);
      const cached = works?.entry(projectPath, ref.workId)?.map;
      const session = (cached && find(cached)) ?? find(await readMap(projectPath, ref.workId));
      if (!session) throw new HostError('not_found', 'session not found');
      cwd = session.worktree?.path ?? projectPath;
    }
    return roleSummaries(await catalog(cwd, { codex: true }));
  };
}
