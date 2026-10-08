import { appendMemoryInTransaction, ensureMemoryIdsInTransaction, normalizeMemoryFact, parseProjectMemory,
  readMemoryLocal, saveMemoryLocal, validMemoryText, validateMemoryInput, validateMemoryProvenance, withMemoryTransaction } from './project-memory.js';
import type { MemoryKind, MemoryProvenance, MemorySuggestion, MemoryTransaction, MemoryWriteOptions } from './project-memory.js';
import { SharedStateError, readSharedFile, sharedProjectPaths } from './store.js';
import type { SharedDiagnostic } from './store.js';

export interface RememberInput {
  kind: MemoryKind; fact: string; details?: string; why: string; workId: string; sessionId: string;
  onHumanRequest?: boolean;
  sourceKind?: 'project-observation' | 'agent-summary'; sourceRefs?: string[]; evidenceRefs?: string[];
  taskRevision?: number; completeness?: 'complete' | 'partial';
}
export interface RememberOptions extends MemoryWriteOptions { now?: () => Date }
export interface MemorySuggestionResult {
  status: 'pending' | 'remembered' | 'duplicate'; id: string; diagnostics: SharedDiagnostic[];
  /** Opaque local operation identity for Undo; not an attestation that a human made the request. */
  undoOperationId?: string;
}
const operationId = (id: string): string => `remember:${id}`;
function provenance(input: RememberInput): MemoryProvenance {
  const value: MemoryProvenance = { scope: 'project', origin: 'agent', sourceKind: input.sourceKind ?? 'project-observation',
    sourceRefs: input.sourceRefs ?? [], evidenceRefs: input.evidenceRefs ?? [], state: 'current', completeness: input.completeness ?? 'complete',
    workId: input.workId, sessionId: input.sessionId,
    ...(input.taskRevision === undefined ? {} : { taskRevision: input.taskRevision }),
    ...(input.onHumanRequest ? { claimedHumanRequest: true } : {}) };
  validateMemoryProvenance(value); return value;
}
async function settle(tx: MemoryTransaction): Promise<void> {
  let changed = false;
  for (const row of tx.state.suggestions) {
    const operation = tx.state.operations.find(op => op.id === operationId(row.id));
    if (row.status === 'pending' && operation?.status === 'applied') {
      row.status = 'accepted'; row.memoryId = operation.memoryId; changed = true;
    }
  }
  if (changed) await saveMemoryLocal(tx);
}
async function existing(tx: MemoryTransaction, fact: string, options: MemoryWriteOptions): Promise<{ id: string; diagnostics: SharedDiagnostic[] } | null> {
  const rows = parseProjectMemory((await readSharedFile(tx.paths.memory)).text);
  const item = rows.find(row => row.state !== 'superseded' && row.provenance?.state !== 'superseded' && normalizeMemoryFact(row.fact) === normalizeMemoryFact(fact));
  if (item && item.id === null) {
    const diagnostics = await ensureMemoryIdsInTransaction(tx, options);
    const id = parseProjectMemory((await readSharedFile(tx.paths.memory)).text)
      .find(row => row.state !== 'superseded' && row.provenance?.state !== 'superseded' && normalizeMemoryFact(row.fact) === normalizeMemoryFact(fact))?.id;
    if (!id) throw new SharedStateError('memory-conflict');
    return { id, diagnostics };
  }
  return item?.id ? { id: item.id, diagnostics: [] } : null;
}
export async function listMemorySuggestions(projectPath: string, options: MemoryWriteOptions = {}): Promise<MemorySuggestion[]> {
  const { state } = await readMemoryLocal(await sharedProjectPaths(projectPath, options));
  return state.suggestions.filter(row => row.status === 'pending');
}
/** Запись, сделанная по заявленной просьбе человека и ещё не отменённая: окно предлагает для неё Undo. */
export interface UndoableMemory { operationId: string; memoryId: string; fact: string; workId?: string; sessionId?: string }
const UNDOABLE_LIMIT = 20;
/** Последние записи «по просьбе» с применённой операцией, новые первыми. Чтение ничего не пишет. */
export async function listUndoableMemory(projectPath: string, options: MemoryWriteOptions = {}): Promise<UndoableMemory[]> {
  const { state } = await readMemoryLocal(await sharedProjectPaths(projectPath, options));
  return state.suggestions
    .filter(row => row.status === 'accepted' && row.memoryId !== undefined && row.provenance.claimedHumanRequest === true &&
      state.operations.some(op => op.id === operationId(row.id) && op.status === 'applied' && op.memoryId === row.memoryId))
    .slice(-UNDOABLE_LIMIT).reverse()
    .map(row => ({ operationId: operationId(row.id), memoryId: row.memoryId!, fact: row.fact,
      ...(row.provenance.workId === undefined ? {} : { workId: row.provenance.workId }),
      ...(row.provenance.sessionId === undefined ? {} : { sessionId: row.provenance.sessionId }) }));
}
export async function rememberProjectMemory(projectPath: string, input: RememberInput, options: RememberOptions = {}): Promise<MemorySuggestionResult> {
  const source = provenance(input);
  validateMemoryInput({ kind: input.kind, fact: input.fact, ...(input.details === undefined ? {} : { details: input.details }), provenance: source });
  if (!validMemoryText(input.why, 16384) || !input.why.trim() ||
      (input.onHumanRequest !== undefined && typeof input.onHumanRequest !== 'boolean') ||
      Object.keys(input).some(key => !['kind', 'fact', 'details', 'why', 'workId', 'sessionId', 'onHumanRequest', 'sourceKind', 'sourceRefs', 'evidenceRefs', 'taskRevision', 'completeness'].includes(key)))
    throw new SharedStateError('memory-suggestions-invalid');
  return withMemoryTransaction(projectPath, options, async tx => {
    await settle(tx);
    const ownRequest = input.onHumanRequest ? tx.state.suggestions.find(row => normalizeMemoryFact(row.fact) === normalizeMemoryFact(input.fact) &&
      row.provenance.claimedHumanRequest && row.provenance.workId === input.workId && row.provenance.sessionId === input.sessionId &&
      JSON.stringify(row.provenance) === JSON.stringify(source) && row.kind === input.kind && row.details === (input.details?.replace(/\r\n|\r/g, '\n') ?? '')) : undefined;
    if (ownRequest?.status === 'pending' && tx.state.operations.some(op => op.id === operationId(ownRequest.id))) {
      const recovered = await appendMemoryInTransaction(tx, { kind: ownRequest.kind, fact: ownRequest.fact, details: ownRequest.details, provenance: ownRequest.provenance }, options, operationId(ownRequest.id));
      ownRequest.status = 'accepted'; ownRequest.memoryId = recovered.id; await saveMemoryLocal(tx);
      return { status: 'remembered', id: recovered.id, diagnostics: recovered.diagnostics, undoOperationId: operationId(ownRequest.id) };
    }
    const known = await existing(tx, input.fact, options);
    if (known) return { status: 'duplicate', ...known, ...(ownRequest?.status === 'accepted' && ownRequest.memoryId === known.id && tx.state.operations.some(op => op.id === operationId(ownRequest.id) && op.status === 'applied' && op.memoryId === known.id) ? { undoOperationId: operationId(ownRequest.id) } : {}) };
    let row = tx.state.suggestions.find(item => item.status === 'pending' && normalizeMemoryFact(item.fact) === normalizeMemoryFact(input.fact));
    if (row) {
      // A request retry can finish its own reserved write; another caller cannot promote a pending suggestion.
      if (!input.onHumanRequest || !row.provenance.claimedHumanRequest || row.provenance.workId !== input.workId ||
          row.provenance.sessionId !== input.sessionId || JSON.stringify(row.provenance) !== JSON.stringify(source) ||
          row.kind !== input.kind || row.details !== (input.details?.replace(/\r\n|\r/g, '\n') ?? ''))
        return { status: 'duplicate', id: row.id, diagnostics: [] };
    } else {
      if (!Number.isSafeInteger(tx.state.suggestionSeq + 1)) throw new SharedStateError('memory-suggestions-invalid');
      row = { id: `ms-${String(++tx.state.suggestionSeq).padStart(2, '0')}`, kind: input.kind, fact: input.fact.trim(),
        details: input.details?.replace(/\r\n|\r/g, '\n') ?? '', why: input.why, provenance: source,
        createdAt: (options.now?.() ?? new Date()).toISOString(), status: 'pending' };
      tx.state.suggestions.push(row); await saveMemoryLocal(tx);
    }
    if (!input.onHumanRequest) return { status: 'pending', id: row.id, diagnostics: [] };
    const added = await appendMemoryInTransaction(tx, { kind: row.kind, fact: row.fact, details: row.details, provenance: row.provenance }, options, operationId(row.id));
    row.status = 'accepted'; row.memoryId = added.id; await saveMemoryLocal(tx);
    return { status: 'remembered', id: added.id, diagnostics: added.diagnostics, undoOperationId: operationId(row.id) };
  });
}
/** Authenticated manual acceptance records acceptance separately from the agent's authorship. */
export async function acceptMemorySuggestion(projectPath: string, id: string, edit: { fact?: string; details?: string } = {}, options: MemoryWriteOptions = {}): Promise<MemorySuggestionResult> {
  if (edit.fact !== undefined || edit.details !== undefined) validateMemoryInput({ kind: 'fact', fact: edit.fact ?? 'Validation', ...(edit.details === undefined ? {} : { details: edit.details }) });
  return withMemoryTransaction(projectPath, options, async tx => {
    await settle(tx);
    const row = tx.state.suggestions.find(item => item.id === id);
    if (!row || row.status === 'dismissed') throw new SharedStateError('memory-suggestions-invalid');
    if (row.status === 'accepted') return { status: 'remembered', id: row.memoryId!, diagnostics: [] };
    const fact = edit.fact ?? row.fact; const details = edit.details ?? row.details;
    validateMemoryInput({ kind: row.kind, fact, details });
    const other = tx.state.suggestions.find(item => item.id !== id && item.status === 'pending' && normalizeMemoryFact(item.fact) === normalizeMemoryFact(fact));
    if (other) return { status: 'duplicate', id: other.id, diagnostics: [] };
    const known = await existing(tx, fact, options);
    const added = known ?? await appendMemoryInTransaction(tx, { kind: row.kind, fact, details,
      provenance: { ...row.provenance, acceptedByHuman: true,
        ...(fact.trim() !== row.fact ? { amendedByHuman: true, factAmendedByHuman: true } : details !== row.details ? { amendedByHuman: true } : {}) } }, options, operationId(id));
    row.fact = fact.trim(); row.details = details.replace(/\r\n|\r/g, '\n'); row.status = 'accepted'; row.memoryId = added.id;
    await saveMemoryLocal(tx);
    return { status: known ? 'duplicate' : 'remembered', id: added.id, diagnostics: added.diagnostics };
  });
}
export async function dismissMemorySuggestion(projectPath: string, id: string, options: MemoryWriteOptions = {}): Promise<void> {
  await withMemoryTransaction(projectPath, options, async tx => {
    await settle(tx);
    const row = tx.state.suggestions.find(item => item.id === id);
    if (!row || row.status === 'accepted') throw new SharedStateError('memory-suggestions-invalid');
    row.status = 'dismissed'; await saveMemoryLocal(tx);
  });
}
