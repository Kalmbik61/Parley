import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HistorySearchError, SharedStateError, searchHistory, sharedProjectPaths } from '@parley/core';
import type { HistoryHit } from '@parley/core';
import { HISTORY_SEARCH_DEFAULT_LIMIT, SHARED_FILE_PATH, historyMethodSchemas, historySearchResult } from '@parley/protocol';
import type { HistoryHitView, HistoryMethodName, HistoryMethodParams, HistoryMethodResults } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import { HostError } from '../errors.js';

export type HistoryHandlers = { [M in HistoryMethodName]: (params: HistoryMethodParams<M>, request?: RequestInfo) => Promise<HistoryMethodResults[M]> };

/** Путь файла относительно каталога; `null` — файл вне него. */
function inside(roots: readonly string[], file: string): string | null {
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return null;
}

/**
 * Файл находки: внутри папки проекта — путь от неё; иначе (linked worktree: общий каталог лежит в основной копии) —
 * только известный файл общего каталога, путь от него и признак `sharedFile`. Остальное окно не откроет.
 */
function locate(roots: readonly string[], sharedRoots: readonly string[], file: string): { file: string; sharedFile?: true } | null {
  const relative = inside(roots, file);
  if (relative !== null) return { file: relative };
  const shared = inside(sharedRoots, file);
  return shared !== null && SHARED_FILE_PATH.test(shared) ? { file: shared, sharedFile: true } : null;
}

function project(roots: readonly string[], sharedRoots: readonly string[], hit: HistoryHit): HistoryHitView {
  const located = hit.file === undefined ? null : locate(roots, sharedRoots, hit.file);
  return { source: hit.source, title: hit.title, excerpt: hit.excerpt, date: hit.date,
    ...(located === null ? {} : { ...located, ...(hit.line === undefined ? {} : { line: hit.line }) }),
    ...(hit.id === undefined ? {} : { id: hit.id }), ...(hit.workId === undefined ? {} : { workId: hit.workId }),
    ...(hit.roomId === undefined ? {} : { roomId: hit.roomId }), ...(hit.sessionId === undefined ? {} : { sessionId: hit.sessionId }),
    ...(hit.state === undefined ? {} : { state: hit.state }), ...(hit.shared ? { shared: true as const } : {}),
    ...(hit.alsoShared ? { alsoShared: true as const } : {}), complete: hit.complete };
}

export function createHistoryHandlers(): HistoryHandlers {
  return {
    'history.search': async params => {
      const parsed = historyMethodSchemas['history.search'].safeParse(params);
      if (!parsed.success || !path.isAbsolute(parsed.data.projectPath)) throw new HostError('bad_request', 'Invalid history search request.');
      const { projectPath, query, scope, limit } = parsed.data;
      try {
        const found = await searchHistory(projectPath, { query, ...(scope === undefined ? {} : { scope }), limit: limit ?? HISTORY_SEARCH_DEFAULT_LIMIT });
        const roots = [projectPath, await realpath(projectPath).catch(() => projectPath)];
        const { dir } = await sharedProjectPaths(projectPath);
        const sharedRoots = [dir, await realpath(dir).catch(() => dir)];
        const projected = historySearchResult.safeParse({ query: found.query, scope: found.scope, limit: found.limit, total: found.total,
          hits: found.hits.map(hit => project(roots, sharedRoots, hit)), unavailable: found.unavailable });
        if (!projected.success) throw new SharedStateError('shared-state-unsafe');
        return projected.data;
      } catch (error) {
        if (error instanceof HostError) throw error;
        if (error instanceof HistorySearchError) throw new HostError('bad_request', 'Invalid history search request.', { code: error.code });
        const code = error instanceof SharedStateError ? error.code : 'history-search-failed';
        throw new HostError('internal', 'The history search could not be completed.', { code });
      }
    },
  };
}
