import path from 'node:path';
import {
  SharedStateError, acceptMemorySuggestion, addProjectMemory, dismissMemorySuggestion, inspectSharedIgnore, listMemorySuggestions,
  listUndoableMemory, readProjectMemory, readSharedFile, sharedProjectPaths, undoProjectMemory, updateProjectMemory,
} from '@parley/core';
import type { MemoryItem, SharedDiagnostic } from '@parley/core';
import { MEMORY_SNAPSHOT_MAX_BYTES, memoryMethodSchemas, memorySnapshot } from '@parley/protocol';
import type { MemoryItemView, MemoryMethodName, MemoryMethodParams, MemoryMethodResults, MemorySnapshot } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import { HostError } from '../errors.js';

export type MemoryHandlers = { [M in MemoryMethodName]: (params: MemoryMethodParams<M>, request?: RequestInfo) => Promise<MemoryMethodResults[M]> };

/** Сообщения фиксированные: путь, текст файла, разбор и сообщения ОС в ответ не попадают. */
function safeError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  const code = error instanceof SharedStateError ? error.code : 'memory-operation-failed';
  const category = ['memory-conflict', 'memory-merge-conflict', 'backlog-conflict', 'backlog-lock-timeout'].includes(code) ? 'conflict'
    : ['memory-invalid', 'memory-suggestions-invalid'].includes(code) ? 'bad_request'
      : ['project-unavailable', 'git-context-unverified', 'main-project-unavailable'].includes(code) ? 'not_found' : 'internal';
  return new HostError(category, 'The memory operation could not be completed.', { code });
}

function view(item: MemoryItem): MemoryItemView {
  const origin = item.human === true || item.provenance?.origin === 'human' ? 'human'
    : item.by !== undefined || item.provenance?.origin === 'agent' ? 'agent' : 'unknown';
  const by = item.by ?? item.provenance?.sessionId;
  return { id: item.id, kind: item.kind, fact: item.fact, details: item.details, state: item.state ?? item.provenance?.state ?? 'current',
    author: origin, ...(by === undefined ? {} : { by }),
    onRequest: item.onHumanRequest === true || item.provenance?.claimedHumanRequest === true,
    amended: item.amendedByHuman === true || item.provenance?.amendedByHuman === true };
}

/** Чтение ничего не пишет: версии файлов сверяются до и после, при расхождении чтение повторяется. */
export async function readMemorySnapshot(projectPath: string, diagnostics: SharedDiagnostic[] = []): Promise<MemorySnapshot> {
  const paths = await sharedProjectPaths(projectPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await Promise.all([readSharedFile(paths.memory), readSharedFile(paths.memorySuggestions)]);
    const document = await readProjectMemory(projectPath);
    const suggestions = await listMemorySuggestions(projectPath);
    const undoable = await listUndoableMemory(projectPath);
    const after = await Promise.all([readSharedFile(paths.memory), readSharedFile(paths.memorySuggestions)]);
    if (before.some((file, index) => file.version !== after[index]!.version)) continue;
    const assembled = { projectPath,
      file: { relativePath: path.basename(paths.dir) === '.harnas' ? '.harnas/memory.md' : '.parley/memory.md', exists: before[0].version !== 'missing' },
      version: document.version, items: document.items.map(view),
      suggestions: suggestions.map(row => ({ id: row.id, kind: row.kind, fact: row.fact, details: row.details, why: row.why,
        ...(row.provenance.workId === undefined ? {} : { workId: row.provenance.workId }),
        ...(row.provenance.sessionId === undefined ? {} : { sessionId: row.provenance.sessionId }), createdAt: row.createdAt })),
      undoable,
      diagnostics: [...new Map([...diagnostics, ...await inspectSharedIgnore(paths)].map(row => [row.code, { code: row.code }])).values()] };
    if (Buffer.byteLength(JSON.stringify(assembled), 'utf8') > MEMORY_SNAPSHOT_MAX_BYTES)
      throw new HostError('internal', 'The memory snapshot is too large.', { code: 'memory-snapshot-too-large' });
    const projected = memorySnapshot.safeParse(assembled);
    if (!projected.success) throw new SharedStateError('memory-invalid');
    return projected.data;
  }
  throw new SharedStateError('memory-conflict');
}

export function createMemoryHandlers(): MemoryHandlers {
  const validate = <M extends MemoryMethodName>(method: M, params: MemoryMethodParams<M>): MemoryMethodParams<M> => {
    const parsed = memoryMethodSchemas[method].safeParse(params);
    if (!parsed.success) throw new HostError('bad_request', 'Invalid memory request.');
    const data = parsed.data as MemoryMethodParams<M>;
    if (!path.isAbsolute(data.projectPath)) throw new HostError('bad_request', 'An absolute project path is required.');
    return data;
  };
  const run = async <M extends MemoryMethodName>(method: M, params: MemoryMethodParams<M>,
    body: (input: MemoryMethodParams<M>) => Promise<SharedDiagnostic[] | void>): Promise<MemorySnapshot> => {
    try {
      const input = validate(method, params);
      const diagnostics = await body(input);
      return await readMemorySnapshot(input.projectPath, diagnostics ?? []);
    } catch (error) { throw safeError(error); }
  };
  return {
    'memory.get': params => run('memory.get', params, async () => {}),
    'memory.add': params => run('memory.add', params, async input => (await addProjectMemory(input.projectPath,
      { kind: input.kind, fact: input.fact, ...(input.details === undefined ? {} : { details: input.details }) },
      input.version === undefined ? {} : { expectedVersion: input.version })).diagnostics),
    'memory.update': params => run('memory.update', params, async input => (await updateProjectMemory(input.projectPath, input.id,
      { ...(input.patch.fact === undefined ? {} : { fact: input.patch.fact }), ...(input.patch.details === undefined ? {} : { details: input.patch.details }) },
      { expectedVersion: input.version })).diagnostics),
    'memory.accept': params => run('memory.accept', params, async input => (await acceptMemorySuggestion(input.projectPath, input.id,
      { ...(input.fact === undefined ? {} : { fact: input.fact }), ...(input.details === undefined ? {} : { details: input.details }) })).diagnostics),
    'memory.dismiss': params => run('memory.dismiss', params, async input => { await dismissMemorySuggestion(input.projectPath, input.id); }),
    'memory.undo': params => run('memory.undo', params, async input => { await undoProjectMemory(input.projectPath, input.operationId); }),
  };
}
