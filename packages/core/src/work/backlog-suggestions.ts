import { appendBacklogInTransaction, ensureBacklogIdsInTransaction, parseBacklog, readBacklogLocal, saveBacklogLocal, validateBacklogInput, withBacklogTransaction } from './backlog.js';
import type { BacklogSuggestion, BacklogTransaction, SuggestionKind } from './backlog.js';
import { readPreferencesAt } from './project-preferences.js';
import { SharedStateError, readSharedFile, sharedProjectPaths } from './store.js';
import type { SharedDiagnostic, SharedWriteOptions } from './store.js';

export interface BacklogSuggestionInput {
  kind: SuggestionKind; title: string; details?: string; why: string; workId: string; sessionId: string;
}
export interface SuggestionOptions extends SharedWriteOptions { now?: () => Date }
export interface BacklogSuggestionResult { status: 'added' | 'pending' | 'duplicate'; id: string; diagnostics: SharedDiagnostic[] }
const normalizedTitle = (title: string): string => title.trim().toLowerCase();
const operationId = (id: string): string => `suggestion:${id}`;

async function openDuplicate(tx: BacklogTransaction, title: string, options: SharedWriteOptions): Promise<{ id: string; diagnostics: SharedDiagnostic[] } | null> {
  const items = parseBacklog((await readSharedFile(tx.paths.backlog)).text);
  // Done/accepted/dismissed records remain for identity/recovery only, not semantic deduplication.
  const open = items.find(item => !item.checked && normalizedTitle(item.title) === normalizedTitle(title));
  // Handwritten items need a public ID on the next write; don't invent an ephemeral duplicate ID.
  if (open && open.id === null) {
    const diagnostics = await ensureBacklogIdsInTransaction(tx, options);
    const id = parseBacklog((await readSharedFile(tx.paths.backlog)).text).find(item => !item.checked && normalizedTitle(item.title) === normalizedTitle(title))?.id;
    return id ? { id, diagnostics } : null;
  }
  const id = open?.id ?? tx.state.suggestions.find(row => row.status === 'pending' && normalizedTitle(row.title) === normalizedTitle(title))?.id;
  return id ? { id, diagnostics: [] } : null;
}
async function settleAccepted(tx: BacklogTransaction): Promise<void> {
  let changed = false;
  for (const row of tx.state.suggestions) {
    const operation = tx.state.operations.find(item => item.id === operationId(row.id));
    if (row.status === 'pending' && operation?.status === 'applied') {
      row.status = 'accepted'; row.backlogId = operation.backlogId; changed = true;
    }
  }
  if (changed) await saveBacklogLocal(tx);
}
export async function listBacklogSuggestions(projectPath: string, options: SharedWriteOptions = {}): Promise<BacklogSuggestion[]> {
  const { state } = await readBacklogLocal(await sharedProjectPaths(projectPath, options));
  return state.suggestions.filter(row => row.status === 'pending');
}
export async function suggestBacklog(projectPath: string, input: BacklogSuggestionInput, options: SuggestionOptions = {}): Promise<BacklogSuggestionResult> {
  validateBacklogInput({ title: input.title, ...(input.details === undefined ? {} : { details: input.details }) });
  if (!['bug', 'debt', 'idea'].includes(input.kind) || typeof input.why !== 'string' || !input.why.trim() ||
      input.why.length > 16_384 || input.why.includes('\0') || !/^w-\d+$/.test(input.workId) || !/^s-\d+$/.test(input.sessionId))
    throw new SharedStateError('suggestions-invalid');
  return withBacklogTransaction(projectPath, options, async tx => {
    await settleAccepted(tx);
    const duplicate = await openDuplicate(tx, input.title, options);
    if (duplicate) return { status: 'duplicate', ...duplicate };
    const { backlogRule } = await readPreferencesAt(tx.paths);
    if (!Number.isSafeInteger(tx.state.suggestionSeq + 1)) throw new SharedStateError('suggestions-invalid');
    const id = `sg-${String(++tx.state.suggestionSeq).padStart(2, '0')}`;
    const row: BacklogSuggestion = { id, kind: input.kind, title: input.title.trim(), details: input.details?.replace(/\r\n|\r/g, '\n') ?? '',
      why: input.why, workId: input.workId, sessionId: input.sessionId, createdAt: (options.now?.() ?? new Date()).toISOString(), status: 'pending' };
    tx.state.suggestions.push(row); await saveBacklogLocal(tx);
    if (backlogRule === 'ask' || (backlogRule === 'problems' && input.kind === 'idea')) return { status: 'pending', id, diagnostics: [] };
    const added = await appendBacklogInTransaction(tx, { title: row.title, details: row.details, by: row.sessionId }, options, operationId(id));
    row.status = 'accepted'; row.backlogId = added.id; await saveBacklogLocal(tx);
    return { status: 'added', id: added.id, diagnostics: added.diagnostics };
  });
}
export async function acceptBacklogSuggestion(projectPath: string, id: string,
  edit: { title?: string; details?: string } = {}, options: SharedWriteOptions = {}): Promise<BacklogSuggestionResult> {
  return withBacklogTransaction(projectPath, options, async tx => {
    await settleAccepted(tx);
    const row = tx.state.suggestions.find(item => item.id === id);
    if (!row || row.status === 'dismissed') throw new SharedStateError('suggestions-invalid');
    if (row.status === 'accepted') return { status: 'added', id: row.backlogId!, diagnostics: [] };
    const title = edit.title ?? row.title; const details = edit.details ?? row.details;
    validateBacklogInput({ title, details });
    // Ignore this pending record when checking another item's/suggestion's title.
    const otherPending = tx.state.suggestions.find(item => item.id !== id && item.status === 'pending' && normalizedTitle(item.title) === normalizedTitle(title));
    if (otherPending) return { status: 'duplicate', id: otherPending.id, diagnostics: [] };
    const idDiagnostics = await ensureBacklogIdsInTransaction(tx, options);
    const open = parseBacklog((await readSharedFile(tx.paths.backlog)).text)
      .find(item => !item.checked && normalizedTitle(item.title) === normalizedTitle(title));
    if (open && open.id === null) throw new SharedStateError('backlog-conflict');
    const added = open?.id ? { id: open.id, diagnostics: [] } :
      await appendBacklogInTransaction(tx, { title, details, by: row.sessionId }, options, operationId(id));
    row.title = title.trim(); row.details = details.replace(/\r\n|\r/g, '\n');
    row.status = 'accepted'; row.backlogId = added.id; await saveBacklogLocal(tx);
    return { status: 'added', id: added.id, diagnostics: [...new Map([...idDiagnostics, ...added.diagnostics].map(row => [row.code, row])).values()] };
  });
}
export async function dismissBacklogSuggestion(projectPath: string, id: string, options: SharedWriteOptions = {}): Promise<void> {
  await withBacklogTransaction(projectPath, options, async tx => {
    await settleAccepted(tx);
    const row = tx.state.suggestions.find(item => item.id === id);
    if (!row || row.status === 'accepted') throw new SharedStateError('suggestions-invalid');
    row.status = 'dismissed'; await saveBacklogLocal(tx);
  });
}
