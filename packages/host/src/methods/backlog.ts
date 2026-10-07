import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  SharedStateError, inspectSharedIgnore, isRoomClosed, acceptBacklogSuggestion, addBacklogItem, dismissBacklogSuggestion, listBacklogSuggestions,
  parseBacklog, parseMap, readBacklog, readProjectPreferences, readSharedFile, setBacklogRule, sharedProjectPaths,
  takeBacklogItem, updateBacklogItem, removeBacklogItem, workPaths, worksIndexPath,
} from '@parley/core';
import type { SharedDiagnostic } from '@parley/core';
import { BACKLOG_SNAPSHOT_MAX_BYTES, backlogMethodSchemas, backlogSnapshot } from '@parley/protocol';
import type { BacklogAuthor, BacklogMethodName, BacklogMethodParams, BacklogMethodResults, BacklogSnapshot } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import type { BacklogService } from '../backlog/backlog-service.js';
import { HostError } from '../errors.js';

export type BacklogHandlers = { [M in BacklogMethodName]: (params: BacklogMethodParams<M>, request?: RequestInfo) => Promise<BacklogMethodResults[M]> };

function safeError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  const code = error instanceof SharedStateError ? error.code : 'backlog-operation-failed';
  const category = ['backlog-conflict', 'backlog-merge-conflict', 'backlog-lock-timeout'].includes(code) ? 'conflict' :
    ['project-unavailable', 'git-context-unverified', 'main-project-unavailable'].includes(code) ? 'not_found' : 'internal';
  // Do not include the supplied path, Markdown, parser exception, or filesystem error in messages/logs.
  return new HostError(category, 'The backlog operation could not be completed.', { code });
}
function absolute(projectPath: string): void {
  if (!path.isAbsolute(projectPath) || projectPath.includes('\0')) throw new HostError('bad_request', 'An absolute project path is required.');
}

async function knownMap(projectPath: string, workId: string) {
  const canonicalProject = await realpath(projectPath);
  const file = workPaths(canonicalProject, workId).map;
  if (await realpath(file) !== file) throw new SharedStateError('shared-state-unsafe');
  const snapshot = await readSharedFile(file);
  const map = parseMap(snapshot.text, file);
  if (map.work.id !== workId || map.sessions.length > 100_000) throw new SharedStateError('shared-state-unsafe');
  return { map, canonicalProject, revision: snapshot.version };
}

/** Suggestions lack a persisted project identity. Only a unique verified known map proves the author. */
async function authors(sharedProjectPath: string, suggestions: Awaited<ReturnType<typeof listBacklogSuggestions>>): Promise<Map<string, BacklogAuthor>> {
  const result = new Map<string, BacklogAuthor>();
  if (suggestions.length === 0) return result;
  try {
    const index: unknown = JSON.parse((await readSharedFile(worksIndexPath())).text);
    if (typeof index !== 'object' || index === null || !('schemaVersion' in index) || index.schemaVersion !== 1 ||
      !('works' in index) || !Array.isArray(index.works) || index.works.length > 10_000) return result;
    const workIds = new Set(suggestions.map(row => row.workId));
    const candidates = new Map<string, { projectPath: string; workId: string }>();
    for (const row of index.works as unknown[]) {
      if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') return result;
      if (!workIds.has(row.id)) continue;
      if (!('projectPath' in row) || typeof row.projectPath !== 'string' || !path.isAbsolute(row.projectPath) || row.projectPath.includes('\0')) return result;
      candidates.set(`${row.projectPath}\0${row.id}`, { projectPath: row.projectPath, workId: row.id });
    }
    // Bound native canonical-context work as well as JSON size/count; incomplete proof supplies no guessed author.
    if (candidates.size > 32) return result;
    const identities = new Map<string, Map<string, BacklogAuthor>>();
    for (const candidate of candidates.values()) {
      const paths = await sharedProjectPaths(candidate.projectPath);
      if (paths.context.projectPath !== sharedProjectPath) continue;
      const current = await knownMap(candidate.projectPath, candidate.workId);
      for (const row of suggestions) {
        if (row.workId !== candidate.workId) continue;
        const session = current.map.sessions.find(item => item.id === row.sessionId);
        if (!session) continue;
        let matches = identities.get(row.id);
        if (!matches) { matches = new Map(); identities.set(row.id, matches); }
        matches.set(`${current.canonicalProject}\0${candidate.workId}\0${session.id}`, {
          projectPath: current.canonicalProject, workId: candidate.workId, sessionId: session.id,
          label: session.label, role: session.role ?? null, revision: current.revision });
      }
    }
    for (const [id, matches] of identities) if (matches.size === 1) result.set(id, matches.values().next().value!);
  } catch { /* Deleted, ambiguous or unreadable source: retain only the original work/session IDs. */ }
  return result;
}

/** Reads are side-effect free. Retry a bounded set of file versions instead of creating a lock/state directory on GET. */
export async function readBacklogSnapshot(projectPath: string, diagnostics: SharedDiagnostic[] = []): Promise<BacklogSnapshot> {
  absolute(projectPath);
  const paths = await sharedProjectPaths(projectPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await Promise.all([readSharedFile(paths.backlog), readSharedFile(paths.suggestions), readSharedFile(paths.preferences)]);
    const suggestions = await listBacklogSuggestions(projectPath);
    const preferences = await readProjectPreferences(projectPath);
    const authorById = await authors(paths.context.projectPath, suggestions);
    const after = await Promise.all([readSharedFile(paths.backlog), readSharedFile(paths.suggestions), readSharedFile(paths.preferences)]);
    if (before.some((file, index) => file.version !== after[index]!.version)) continue;
    const assembled = { projectPath, sharedProjectPath: paths.context.projectPath,
      file: { relativePath: path.basename(paths.dir) === '.harnas' ? '.harnas/backlog.md' : '.parley/backlog.md', exists: before[0]!.version !== 'missing' },
      version: before[0]!.version, items: parseBacklog(before[0]!.text),
      suggestions: suggestions.map(row => ({ id: row.id, kind: row.kind, title: row.title, details: row.details,
        why: row.why, workId: row.workId, sessionId: row.sessionId, createdAt: row.createdAt, status: 'pending' as const,
        ...(authorById.has(row.id) ? { author: authorById.get(row.id)! } : {}) })),
      rule: preferences.backlogRule, diagnostics: [...new Map([...diagnostics, ...await inspectSharedIgnore(paths)].map(row => [row.code, { code: row.code }])).values()] };
    if (Buffer.byteLength(JSON.stringify(assembled), 'utf8') > BACKLOG_SNAPSHOT_MAX_BYTES)
      throw new HostError('internal', 'The backlog snapshot is too large.', { code: 'backlog-snapshot-too-large' });
    const projected = backlogSnapshot.safeParse(assembled);
    if (!projected.success) throw new SharedStateError('backlog-invalid');
    return projected.data;
  }
  throw new SharedStateError('backlog-conflict');
}

async function take(params: BacklogMethodParams<'backlog.take'>): Promise<SharedDiagnostic[]> {
  absolute(params.target.projectPath);
  const [source, target] = await Promise.all([sharedProjectPaths(params.projectPath), sharedProjectPaths(params.target.projectPath)]);
  if (source.context.projectPath !== target.context.projectPath) throw new HostError('bad_request', 'The target belongs to another project.');
  const map = (await knownMap(params.target.projectPath, params.target.workId).catch(() => null))?.map;
  if (!map || map.work.status !== 'active') throw new HostError('not_found', 'An active target workspace is required.');
  let taken: string;
  if ('roomId' in params.target) {
    const roomId = params.target.roomId;
    const room = map.rooms.find(row => row.id === roomId);
    if (!room || isRoomClosed(map, room))
      throw new HostError('not_found', 'A live target room is required.');
    taken = `${params.target.workId}/${params.target.roomId}`;
  } else {
    const sessionId = params.target.sessionId;
    const session = map.sessions.find(row => row.id === sessionId);
    if (!session || session.lifecycle === 'closed') throw new HostError('not_found', 'A live target session is required.');
    taken = `${params.target.workId}/${params.target.sessionId}`;
  }
  const document = await readBacklog(params.projectPath);
  if (params.index !== undefined && document.version !== params.version) throw new SharedStateError('backlog-conflict');
  const item = params.id === undefined ? document.items[params.index!] : document.items.find(row => row.id === params.id);
  if (!item) throw new HostError('not_found', 'The backlog item no longer exists.');
  if (item.checked || (item.taken !== undefined && item.taken !== taken)) throw new SharedStateError('backlog-conflict');
  // A lost successful response may be retried for the same existing target without recreating a room.
  if (item.taken === taken) return [];
  return (await takeBacklogItem(params.projectPath, params.id ?? params.index!, taken, { expectedVersion: params.version })).diagnostics;
}

export function createBacklogHandlers(service?: BacklogService): BacklogHandlers {
  const validate = <M extends BacklogMethodName>(method: M, params: BacklogMethodParams<M>): BacklogMethodParams<M> => {
    const parsed = backlogMethodSchemas[method].safeParse(params);
    if (!parsed.success) throw new HostError('bad_request', 'Invalid backlog request.');
    absolute(parsed.data.projectPath); return parsed.data as BacklogMethodParams<M>;
  };
  const run = async <M extends Exclude<BacklogMethodName, 'backlog.unsubscribe' | 'backlog.prepareTake'>>(method: M, params: BacklogMethodParams<M>,
    body: (input: BacklogMethodParams<M>) => Promise<SharedDiagnostic[] | void>): Promise<BacklogSnapshot> => {
    try {
      const input = validate(method, params);
      const diagnostics = await body(input);
      return await readBacklogSnapshot(params.projectPath, diagnostics ?? []);
    } catch (error) { throw safeError(error); }
  };
  return {
    'backlog.subscribe': async (params, request) => {
      try {
        const input = validate('backlog.subscribe', params);
        if (!service || !request) throw new HostError('internal', 'Live backlog updates are unavailable.', { code: 'backlog-watch-unavailable' });
        return await service.subscribe(input.projectPath, request.client.id, data => request.client.send({ event: 'backlog.changed', data }));
      } catch (error) { throw safeError(error); }
    },
    'backlog.unsubscribe': async (params, request) => {
      try {
        const input = validate('backlog.unsubscribe', params);
        if (!service || !request) throw new HostError('internal', 'Live backlog updates are unavailable.', { code: 'backlog-watch-unavailable' });
        service.unsubscribe(input.projectPath, request.client.id); return { ok: true };
      } catch (error) { throw safeError(error); }
    },
    'backlog.prepareTake': async params => {
      try {
        const input = validate('backlog.prepareTake', params);
        const prepared = await updateBacklogItem(input.projectPath, input.id ?? input.index!, {}, { expectedVersion: input.version });
        return { id: prepared.id, snapshot: await readBacklogSnapshot(input.projectPath, prepared.diagnostics) };
      } catch (error) { throw safeError(error); }
    },
    'backlog.get': params => run('backlog.get', params, async () => {}),
    'backlog.add': params => run('backlog.add', params, async input => (await addBacklogItem(input.projectPath,
      { title: input.title, ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.section === undefined ? {} : { section: input.section }) },
      input.version === undefined ? {} : { expectedVersion: input.version })).diagnostics),
    'backlog.update': params => run('backlog.update', params, async input => (await updateBacklogItem(input.projectPath, input.id ?? input.index!,
      { ...(input.patch.title === undefined ? {} : { title: input.patch.title }),
        ...(input.patch.details === undefined ? {} : { details: input.patch.details }),
        ...(input.patch.checked === undefined ? {} : { checked: input.patch.checked, done: input.patch.checked ? new Date().toISOString().slice(0, 10) : null }) },
      { expectedVersion: input.version })).diagnostics),
    'backlog.remove': params => run('backlog.remove', params, async input =>
      (await removeBacklogItem(input.projectPath, input.id ?? input.index!, { expectedVersion: input.version })).diagnostics),
    'backlog.take': params => run('backlog.take', params, take),
    'backlog.suggestions.accept': params => run('backlog.suggestions.accept', params, async input =>
      (await acceptBacklogSuggestion(input.projectPath, input.id, {
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.details === undefined ? {} : { details: input.details }) })).diagnostics),
    'backlog.suggestions.dismiss': params => run('backlog.suggestions.dismiss', params, async input => { await dismissBacklogSuggestion(input.projectPath, input.id); }),
    'backlog.preferences.set': params => run('backlog.preferences.set', params, async input => { await setBacklogRule(input.projectPath, input.rule); }),
  };
}
