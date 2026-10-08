import { createHash, randomUUID } from 'node:crypto';
import { MISSING_SHARED_VERSION, SharedStateError, prepareSharedIgnore, readSharedFile, sharedProjectPaths,
  withSharedProjectLock, writeSharedFile } from './store.js';
import type { SharedDiagnostic, SharedFileSnapshot, SharedProjectPaths, SharedWriteOptions } from './store.js';

export type MemoryKind = 'fact' | 'lesson' | 'agreement';
export interface MemoryProvenance {
  scope: 'project'; origin: 'human' | 'agent'; sourceKind: 'human-amendment' | 'project-observation' | 'agent-summary';
  sourceRefs: string[]; evidenceRefs: string[]; taskRevision?: number;
  state: 'current' | 'superseded'; completeness: 'complete' | 'partial';
  workId?: string; sessionId?: string; acceptedByHuman?: true; amendedByHuman?: true; factAmendedByHuman?: true; claimedHumanRequest?: true;
}
export interface MemoryItem {
  id: string | null; kind: MemoryKind; fact: string; details: string;
  by?: string; human?: true; onHumanRequest?: true; amendedByHuman?: true; factAmendedByHuman?: true; state?: 'current' | 'superseded'; provenance?: MemoryProvenance;
}
interface ParsedItem extends MemoryItem { start: number; lineEnd: number; end: number; body: string; eol: string; tokens: string[]; commentStart: number; comment: string; suffix: string }
export interface MemoryDocument { source: string; version: string; items: MemoryItem[] }
export interface MemoryInput { kind: MemoryKind; fact: string; details?: string; provenance?: MemoryProvenance }
export interface MemoryPatch { fact?: string; details?: string; state?: 'current' | 'superseded' }
export interface MemoryWriteOptions extends SharedWriteOptions { operationId?: string }
export interface MemoryWriteResult { id: string; document: MemoryDocument; diagnostics: SharedDiagnostic[]; duplicate?: true }
export interface MemorySuggestion {
  id: string; kind: MemoryKind; fact: string; details: string; why: string; provenance: MemoryProvenance;
  createdAt: string; status: 'pending' | 'accepted' | 'dismissed'; memoryId?: string;
}
interface MemoryOperation {
  id: string; memoryId: string; input: MemoryInput; beforeVersion: string; status: 'reserved' | 'applied' | 'undone' | 'conflicted';
  rowHash?: string; appliedVersion?: string;
}
export interface MemoryLocalState { version: 1; memorySeq: number; suggestionSeq: number; suggestions: MemorySuggestion[]; operations: MemoryOperation[] }
export interface MemoryTransaction { paths: SharedProjectPaths; local: SharedFileSnapshot; state: MemoryLocalState }
const sections: Record<MemoryKind, string> = { fact: 'Facts', lesson: 'Lessons', agreement: 'Agreements' };
const idPattern = /^m-\d{3,}$/;
const bounded = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < Number.MAX_SAFE_INTEGER;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const normalized = (s: string): string => s.trim().toLowerCase();
const nextId = (seq: number): string => `m-${String(seq).padStart(3, '0')}`;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function invalid(): never { throw new SharedStateError('memory-invalid'); }
/** Reject JSON lone surrogates before UTF-8 storage can replace them; check the bound first. */
export function validMemoryText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function validateOperationId(value: unknown): void {
  if (!validMemoryText(value, 1024) || !value.trim()) invalid();
}
function validRefs(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 32 && v.every(ref => validMemoryText(ref, 1024) && ref.length > 0 && !/[\r\n]/.test(ref));
}
export function validateMemoryProvenance(v: unknown): asserts v is MemoryProvenance {
  if (!record(v) || v['scope'] !== 'project' || !['human', 'agent'].includes(String(v['origin'])) ||
      !['human-amendment', 'project-observation', 'agent-summary'].includes(String(v['sourceKind'])) ||
      !validRefs(v['sourceRefs']) || !validRefs(v['evidenceRefs']) || !['current', 'superseded'].includes(String(v['state'])) ||
      !['complete', 'partial'].includes(String(v['completeness'])) || (v['taskRevision'] !== undefined && !bounded(v['taskRevision'])) ||
      (v['workId'] !== undefined && (typeof v['workId'] !== 'string' || !/^w-\d+$/.test(v['workId']))) ||
      (v['sessionId'] !== undefined && (typeof v['sessionId'] !== 'string' || !/^s-\d+$/.test(v['sessionId']))) ||
      (v['acceptedByHuman'] !== undefined && v['acceptedByHuman'] !== true) ||
      (v['amendedByHuman'] !== undefined && v['amendedByHuman'] !== true) ||
      (v['factAmendedByHuman'] !== undefined && v['factAmendedByHuman'] !== true) ||
      (v['claimedHumanRequest'] !== undefined && v['claimedHumanRequest'] !== true) ||
      Object.keys(v).some(key => !['scope', 'origin', 'sourceKind', 'sourceRefs', 'evidenceRefs', 'taskRevision', 'state', 'completeness', 'workId', 'sessionId', 'acceptedByHuman', 'amendedByHuman', 'factAmendedByHuman', 'claimedHumanRequest'].includes(key)) ||
      (v['origin'] === 'human' && (v['sourceKind'] !== 'human-amendment' || v['claimedHumanRequest'] !== undefined)) ||
      (v['origin'] === 'agent' && (v['sourceKind'] === 'human-amendment' || typeof v['workId'] !== 'string' || typeof v['sessionId'] !== 'string'))) invalid();
}
export function validateMemoryInput(input: MemoryInput): void {
  if (!record(input) || Object.keys(input).some(key => !['kind', 'fact', 'details', 'provenance'].includes(key)) || !Object.hasOwn(sections, input.kind) || !validMemoryText(input.fact, 4096) || !input.fact.trim() || /[\r\n]/.test(input.fact) ||
      input.fact.includes('<!--') || input.fact.includes('-->') ||
      (input.details !== undefined && !validMemoryText(input.details, 65536))) invalid();
  if (input.provenance !== undefined) validateMemoryProvenance(input.provenance);
}
/** Public human operations use this projection; an agent request flag never supplies human authorship. */
export function humanMemoryProvenance(): MemoryProvenance {
  return { scope: 'project', origin: 'human', sourceKind: 'human-amendment', sourceRefs: [], evidenceRefs: [], state: 'current', completeness: 'complete' };
}
function decodeProvenance(token: string): MemoryProvenance {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.slice('provenance: '.length), 'base64url').toString('utf8'));
    validateMemoryProvenance(value); return value;
  } catch { return invalid(); }
}
function parseItems(source: string): ParsedItem[] {
  if (/(?:^|[\r\n])<<<<<<<(?:[ \t]|[\r\n]|$)/.test(source)) throw new SharedStateError('memory-merge-conflict');
  const lines: { start: number; end: number; body: string; eol: string }[] = [];
  let offset = 0;
  for (const m of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!m[0]) continue;
    const eol = /(?:\r\n|\n|\r)$/.exec(m[0])?.[0] ?? '';
    lines.push({ start: offset, end: offset + m[0].length, body: m[0].slice(0, m[0].length - eol.length), eol }); offset += m[0].length;
  }
  let kind: MemoryKind | null = null;
  let fence: { ch: string; length: number } | null = null;
  const items: ParsedItem[] = []; const ids = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; const body = i === 0 ? line.body.replace(/^\uFEFF/, '') : line.body;
    const marker = /^ {0,3}(`{3,}|~{3,})([\s\S]*)(?![\s\S])/.exec(body);
    if (fence) {
      if (marker && marker[1]![0] === fence.ch && marker[1]!.length >= fence.length && /^[ \t]*$/.test(marker[2]!)) fence = null;
      continue;
    }
    if (marker) { fence = { ch: marker[1]![0]!, length: marker[1]!.length }; continue; }
    const heading = /^(#{1,6})[ \t]+([\s\S]+?)(?:[ \t]+#+)?[ \t]*(?![\s\S])/.exec(body);
    if (heading) { kind = heading[1] === '##' ? (Object.entries(sections).find(([, title]) => title === heading[2])?.[0] as MemoryKind | undefined) ?? null : null; continue; }
    if (kind === null) continue;
    const bullet = /^- [\t ]*([\s\S]+)(?![\s\S])/.exec(body);
    if (!bullet) continue;
    const comment = /[ \t]*<!-- (m-\d{3,})([\s\S]*?) -->[ \t]*(?![\s\S])/.exec(bullet[1]!);
    const id = comment?.[1] ?? null;
    if (id && (ids.has(id) || !bounded(Number(id.slice(2))))) invalid();
    if (id) ids.add(id);
    const tokens = comment ? comment[2]!.split('·').map(x => x.trim()).filter(Boolean) : [];
    const item: ParsedItem = { id, kind, fact: (comment ? bullet[1]!.slice(0, comment.index) : bullet[1]!).trim(), details: '',
      start: line.start, lineEnd: line.end, end: line.end, body: line.body, eol: line.eol, tokens, commentStart: comment ? body.indexOf(bullet[1]!, 2) + comment.index : line.body.length, comment: comment?.[0] ?? '', suffix: comment?.[2] ?? '' };
    for (const token of tokens) {
      if (token.startsWith('by: ')) item.by = token.slice(4);
      else if (token === 'human') item.human = true;
      else if (token === 'on request') item.onHumanRequest = true;
      else if (token === 'amended by human') item.amendedByHuman = true;
      else if (token === 'fact amended by human') item.factAmendedByHuman = true;
      else if (token.startsWith('state: ')) {
        if (!['current', 'superseded'].includes(token.slice(7)) || item.state !== undefined) invalid();
        item.state = token.slice(7) as 'current' | 'superseded';
      }
      else if (token.startsWith('provenance: ')) {
        if (item.provenance !== undefined) invalid();
        item.provenance = decodeProvenance(token);
      }
    }
    if (item.state !== undefined && item.provenance !== undefined && item.state !== item.provenance.state) invalid();
    const details: string[] = [];
    while (i + 1 < lines.length && /^ {2}/.test(lines[i + 1]!.body)) {
      const detail = lines[++i]!; details.push(detail.body.slice(2)); item.end = detail.end;
    }
    if (items.length >= 10000) invalid();
    item.details = details.join('\n'); items.push(item);
  }
  return items;
}
export function parseProjectMemory(source: string): MemoryItem[] {
  return parseItems(source).map(({ id, kind, fact, details, by, human, onHumanRequest, amendedByHuman, factAmendedByHuman, state, provenance }) => ({ id, kind, fact, details,
    ...(by === undefined ? {} : { by }), ...(human === undefined ? {} : { human }),
    ...(onHumanRequest === undefined ? {} : { onHumanRequest }), ...(amendedByHuman === undefined ? {} : { amendedByHuman }),
    ...(factAmendedByHuman === undefined ? {} : { factAmendedByHuman }), ...(state === undefined ? {} : { state }), ...(provenance === undefined ? {} : { provenance }) }));
}
function localState(snapshot: SharedFileSnapshot): MemoryLocalState {
  if (snapshot.version === MISSING_SHARED_VERSION) return { version: 1, memorySeq: 0, suggestionSeq: 0, suggestions: [], operations: [] };
  let v: unknown; try { v = JSON.parse(snapshot.text); } catch { throw new SharedStateError('memory-suggestions-invalid'); }
  if (!record(v) || v['version'] !== 1 || !bounded(v['memorySeq']) || !bounded(v['suggestionSeq']) ||
      !Array.isArray(v['suggestions']) || !Array.isArray(v['operations'])) throw new SharedStateError('memory-suggestions-invalid');
  const seen = new Set<string>(); const operations = new Set<string>(); const reservations = new Set<string>();
  try {
    for (const row of v['suggestions'] as unknown[]) {
      if (!record(row) || typeof row['id'] !== 'string' || !/^ms-\d{2,}$/.test(row['id']) || seen.has(row['id']) ||
          Number(row['id'].slice(3)) > v['suggestionSeq'] || typeof row['details'] !== 'string' || typeof row['why'] !== 'string' ||
          !validMemoryText(row['why'], 16384) || !row['why'].trim() || typeof row['createdAt'] !== 'string' ||
          !Number.isFinite(Date.parse(row['createdAt'])) || !['pending', 'accepted', 'dismissed'].includes(String(row['status'])) ||
          (row['memoryId'] !== undefined && (typeof row['memoryId'] !== 'string' || !idPattern.test(row['memoryId']))) ||
          (row['status'] === 'accepted' && row['memoryId'] === undefined)) invalid();
      validateMemoryInput({ kind: row['kind'], fact: row['fact'], details: row['details'], provenance: row['provenance'] } as MemoryInput); validateMemoryProvenance(row['provenance']); seen.add(row['id']);
    }
    for (const row of v['operations'] as unknown[]) {
      if (!record(row) || !validMemoryText(row['id'], 1024) || !row['id'].trim() || operations.has(row['id']) ||
          typeof row['memoryId'] !== 'string' || !idPattern.test(row['memoryId']) || reservations.has(row['memoryId']) ||
          Number(row['memoryId'].slice(2)) > v['memorySeq'] || typeof row['beforeVersion'] !== 'string' ||
          !['reserved', 'applied', 'undone', 'conflicted'].includes(String(row['status'])) ||
          (row['rowHash'] !== undefined && (typeof row['rowHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['rowHash']))) ||
          (row['appliedVersion'] !== undefined && typeof row['appliedVersion'] !== 'string')) invalid();
      validateMemoryInput(row['input'] as MemoryInput); operations.add(row['id']); reservations.add(row['memoryId']);
    }
  } catch { throw new SharedStateError('memory-suggestions-invalid'); }
  return v as unknown as MemoryLocalState;
}
export async function readMemoryLocal(paths: SharedProjectPaths): Promise<{ local: SharedFileSnapshot; state: MemoryLocalState }> {
  const local = await readSharedFile(paths.memorySuggestions); return { local, state: localState(local) };
}
export async function saveMemoryLocal(tx: MemoryTransaction): Promise<void> {
  await writeSharedFile(tx.paths.memorySuggestions, `${JSON.stringify(tx.state, null, 2)}\n`, tx.local);
  tx.local = await readSharedFile(tx.paths.memorySuggestions);
}
export async function withMemoryTransaction<T>(projectPath: string, options: SharedWriteOptions, body: (tx: MemoryTransaction) => Promise<T>): Promise<T> {
  const paths = await sharedProjectPaths(projectPath, options);
  try { return await withSharedProjectLock(paths, async () => body({ paths, ...await readMemoryLocal(paths) }), options); }
  catch (error) {
    if (error instanceof SharedStateError && error.code === 'backlog-conflict') throw new SharedStateError('memory-conflict');
    throw error;
  }
}
export async function readProjectMemory(projectPath: string, options: SharedWriteOptions = {}): Promise<MemoryDocument> {
  const snapshot = await readSharedFile((await sharedProjectPaths(projectPath, options)).memory);
  return { source: snapshot.text, version: snapshot.version, items: parseProjectMemory(snapshot.text) };
}
const eolOf = (source: string): string => /\r\n|\n|\r/.exec(source)?.[0] ?? '\n';
function allocateMissing(source: string, state: MemoryLocalState): string {
  const items = parseItems(source);
  for (const item of items) if (item.id) state.memorySeq = Math.max(state.memorySeq, Number(item.id.slice(2)));
  const edits: { start: number; end: number; text: string }[] = [];
  for (const item of items) if (item.id === null) {
    if (!bounded(state.memorySeq + 1)) invalid();
    edits.push({ start: item.start, end: item.lineEnd, text: `${item.body} <!-- ${nextId(++state.memorySeq)} -->${item.eol}` });
  }
  return edits.reverse().reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}
function tokensOf(provenance: MemoryProvenance | undefined): string[] {
  if (!provenance) return [];
  return [...(provenance.origin === 'human' ? ['human'] : [`by: ${provenance.sessionId}`]),
    ...(provenance.claimedHumanRequest ? ['on request'] : []),
    `provenance: ${Buffer.from(JSON.stringify(provenance)).toString('base64url')}`];
}
function renderInput(id: string, input: MemoryInput, eol: string): string {
  const tokens = tokensOf(input.provenance);
  return `- ${input.fact.trim()} <!-- ${id}${tokens.length ? ` · ${tokens.join(' · ')}` : ''} -->${eol}` +
    (input.details ? input.details.split(/\r\n|\n|\r/).map(line => `  ${line}${eol}`).join('') : '');
}
/** Find a real section boundary without interpreting fenced headings or foreign bytes. */
function sectionInsertion(source: string, kind: MemoryKind): number | null {
  let offset = 0; let section = false; let fence: { ch: string; length: number } | null = null;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    let body = match[0].replace(/(?:\r\n|\n|\r)$/, '');
    if (offset === 0) body = body.replace(/^\uFEFF/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})([\s\S]*)(?![\s\S])/.exec(body);
    if (fence) { if (marker && marker[1]![0] === fence.ch && marker[1]!.length >= fence.length && /^[ \t]*$/.test(marker[2]!)) fence = null; }
    else if (marker) fence = { ch: marker[1]![0]!, length: marker[1]!.length };
    else {
      const heading = /^(#{1,6})[ \t]+([\s\S]+?)(?:[ \t]+#+)?[ \t]*(?![\s\S])/.exec(body);
      if (heading) {
        if (section) return offset;
        section = heading[1] === '##' && heading[2] === sections[kind];
      }
    }
    offset += match[0].length;
  }
  if (fence) invalid(); // Appending after an unclosed fence would silently hide the new fact.
  return section ? source.length : null;
}
function appendSource(source: string, id: string, input: MemoryInput): string {
  const eol = eolOf(source); const block = renderInput(id, input, eol);
  const insertion = sectionInsertion(source, input.kind);
  if (insertion !== null) {
    const prefix = source.slice(0, insertion);
    return prefix + (prefix && !/[\r\n]$/.test(prefix) ? eol : '') + block + source.slice(insertion);
  }
  const base = source || `# Project memory${eol}`;
  return base + (/[\r\n]$/.test(base) ? '' : eol) + `${eol}## ${sections[input.kind]}${eol}` + block;
}
function document(snapshot: SharedFileSnapshot): MemoryDocument { return { source: snapshot.text, version: snapshot.version, items: parseProjectMemory(snapshot.text) }; }
export async function appendMemoryInTransaction(tx: MemoryTransaction, input: MemoryInput, options: MemoryWriteOptions = {}, operationId: string = randomUUID()): Promise<MemoryWriteResult> {
  validateMemoryInput(input);
  validateOperationId(operationId);
  input = { ...input, fact: input.fact.trim(), ...(input.details === undefined ? {} : { details: input.details.replace(/\r\n|\r/g, '\n') }) };
  let operation = tx.state.operations.find(row => row.id === operationId);
  if (operation && JSON.stringify(operation.input) !== JSON.stringify(input)) throw new SharedStateError('memory-conflict');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSharedFile(tx.paths.memory);
    if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('memory-conflict');
    let source = allocateMissing(before.text, tx.state);
    if (!operation) {
      if (!bounded(tx.state.memorySeq + 1)) invalid();
      operation = { id: operationId, memoryId: nextId(++tx.state.memorySeq), input, beforeVersion: before.version, status: 'reserved' };
      tx.state.operations.push(operation);
    }
    const existing = parseItems(before.text).find(row => row.id === operation!.memoryId);
    if (operation.status === 'undone' || operation.status === 'conflicted') throw new SharedStateError('memory-conflict');
    if (existing) {
      if (operation.rowHash !== hash(before.text.slice(existing.start, existing.end))) {
        operation.status = 'conflicted'; await saveMemoryLocal(tx); throw new SharedStateError('memory-conflict');
      }
      operation.status = 'applied'; operation.appliedVersion = before.version; await saveMemoryLocal(tx);
      return { id: operation.memoryId, document: document(before), diagnostics: [] };
    }
    if (operation.status === 'applied') throw new SharedStateError('memory-conflict'); // A human deletion is not undone by retry.
    source = appendSource(source, operation.memoryId, input);
    const inserted = parseItems(source).find(row => row.id === operation!.memoryId)!;
    operation.rowHash = hash(source.slice(inserted.start, inserted.end)); operation.beforeVersion = before.version;
    await saveMemoryLocal(tx); // Reserve IDs and recovery evidence before the shared write.
    const diagnostics = await prepareSharedIgnore(tx.paths, options);
    await options.beforeCommit?.(tx.paths.memory, attempt);
    try { await writeSharedFile(tx.paths.memory, source, before, 0o644); }
    catch (error) {
      if (error instanceof SharedStateError && error.code === 'backlog-conflict' && options.expectedVersion === undefined) continue;
      throw error;
    }
    const after = await readSharedFile(tx.paths.memory);
    operation.status = 'applied'; operation.appliedVersion = after.version; await saveMemoryLocal(tx);
    return { id: operation.memoryId, document: document(after), diagnostics };
  }
  throw new SharedStateError('memory-conflict');
}
/** Manual authenticated operator API; origin is constructed here rather than accepted from an agent flag. */
export async function addProjectMemory(projectPath: string, input: Omit<MemoryInput, 'provenance'>, options: MemoryWriteOptions = {}): Promise<MemoryWriteResult> {
  validateMemoryInput(input);
  if (options.operationId !== undefined) validateOperationId(options.operationId);
  return withMemoryTransaction(projectPath, options, async tx => {
    if (options.operationId && tx.state.operations.some(row => row.id === options.operationId))
      return appendMemoryInTransaction(tx, { kind: input.kind, fact: input.fact, ...(input.details === undefined ? {} : { details: input.details }), provenance: humanMemoryProvenance() }, options, options.operationId);
    const before = await readSharedFile(tx.paths.memory);
    if (options.expectedVersion !== undefined && options.expectedVersion !== before.version) throw new SharedStateError('memory-conflict');
    const duplicate = parseProjectMemory(before.text).find(row => row.state !== 'superseded' && row.provenance?.state !== 'superseded' && normalized(row.fact) === normalized(input.fact));
    if (duplicate) {
      const diagnostics = duplicate.id === null ? await ensureMemoryIdsInTransaction(tx, options) : [];
      const after = await readSharedFile(tx.paths.memory); const item = parseProjectMemory(after.text).find(row => row.state !== 'superseded' && row.provenance?.state !== 'superseded' && normalized(row.fact) === normalized(input.fact));
      if (!item?.id) throw new SharedStateError('memory-conflict');
      return { id: item.id, document: document(after), diagnostics, duplicate: true };
    }
    const added = await appendMemoryInTransaction(tx, { kind: input.kind, fact: input.fact,
      ...(input.details === undefined ? {} : { details: input.details }), provenance: humanMemoryProvenance() }, options, options.operationId);
    let settled = false;
    for (const row of tx.state.suggestions) if (row.status === 'pending' && normalized(row.fact) === normalized(input.fact)) { row.status = 'accepted'; row.memoryId = added.id; settled = true; }
    if (settled) await saveMemoryLocal(tx);
    return added;
  });
}
export async function ensureMemoryIdsInTransaction(tx: MemoryTransaction, options: SharedWriteOptions = {}): Promise<SharedDiagnostic[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSharedFile(tx.paths.memory);
    if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('memory-conflict');
    const source = allocateMissing(before.text, tx.state);
    if (source === before.text) return [];
    await saveMemoryLocal(tx); const diagnostics = await prepareSharedIgnore(tx.paths, options);
    await options.beforeCommit?.(tx.paths.memory, attempt);
    try { await writeSharedFile(tx.paths.memory, source, before, 0o644); return diagnostics; }
    catch (error) { if (!(error instanceof SharedStateError) || error.code !== 'backlog-conflict' || options.expectedVersion !== undefined) throw error; }
  }
  throw new SharedStateError('memory-conflict');
}
async function changeMemory(projectPath: string, locator: string | number, patch: MemoryPatch | null, options: MemoryWriteOptions): Promise<MemoryWriteResult> {
  if (typeof locator === 'string' ? !idPattern.test(locator) : !bounded(locator) || locator >= 10000 || typeof options.expectedVersion !== 'string') invalid();
  if (patch?.fact !== undefined) validateMemoryInput({ kind: 'fact', fact: patch.fact });
  if (patch?.details !== undefined && !validMemoryText(patch.details, 65536)) invalid();
  if (patch?.state !== undefined && !['current', 'superseded'].includes(patch.state)) invalid();
  return withMemoryTransaction(projectPath, options, async tx => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readSharedFile(tx.paths.memory);
      if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('memory-conflict');
      const original = parseItems(before.text); const index = typeof locator === 'number' ? locator : original.findIndex(row => row.id === locator);
      if (!original[index]) invalid();
      let source = allocateMissing(before.text, tx.state); const row = parseItems(source)[index]!; const id = row.id!;
      if (patch === null) source = source.slice(0, row.start) + source.slice(row.end);
      else if (Object.keys(patch).length > 0) {
        // Change known fields only; each foreign metadata segment retains its original bytes.
        const amendedFact = patch.fact !== undefined && patch.fact.trim() !== row.fact;
        const provenance = row.provenance ? { ...row.provenance, amendedByHuman: true as const,
          ...(amendedFact ? { factAmendedByHuman: true as const } : {}), state: patch.state ?? row.provenance.state } : null;
        const segments = row.suffix.split('·');
        let hasAmendment = false; let hasFactAmendment = false; let hasState = false;
        for (let n = 0; n < segments.length; n++) {
          const segment = segments[n]!; const token = segment.trim(); let replacement: string | null = null;
          if (token.startsWith('provenance: ') && provenance) replacement = `provenance: ${Buffer.from(JSON.stringify(provenance)).toString('base64url')}`;
          else if (token.startsWith('state: ')) { hasState = true; if (patch.state !== undefined) replacement = `state: ${patch.state}`; }
          else if (token === 'amended by human') hasAmendment = true;
          else if (token === 'fact amended by human') hasFactAmendment = true;
          if (replacement !== null) {
            const edge = segment.indexOf(token); segments[n] = segment.slice(0, edge) + replacement + segment.slice(edge + token.length);
          }
        }
        let suffix = segments.join('·');
        if (!hasAmendment) suffix += ' · amended by human';
        if (!row.provenance && amendedFact && !hasFactAmendment) suffix += ' · fact amended by human';
        if (!row.provenance && patch.state !== undefined && !hasState) suffix += ` · state: ${patch.state}`;
        const metadataStart = row.comment.indexOf(`<!-- ${id}`) + `<!-- ${id}`.length;
        const comment = row.comment.slice(0, metadataStart) + suffix + row.comment.slice(metadataStart + row.suffix.length);
        const eol = row.eol || (patch.details ? eolOf(source) : '');
        const prefix = patch.fact === undefined ? row.body.slice(0, row.commentStart) : `- ${patch.fact.trim()}`;
        const line = prefix + comment + eol;
        const details = patch.details === undefined ? source.slice(row.lineEnd, row.end) :
          patch.details.split(/\r\n|\n|\r/).map(detail => patch.details ? `  ${detail}${eol || eolOf(source)}` : '').join('');
        source = source.slice(0, row.start) + line + details + source.slice(row.end);
      }
      await saveMemoryLocal(tx); const diagnostics = await prepareSharedIgnore(tx.paths, options);
      await options.beforeCommit?.(tx.paths.memory, attempt);
      try { await writeSharedFile(tx.paths.memory, source, before, 0o644); }
      catch (error) { if (error instanceof SharedStateError && error.code === 'backlog-conflict' && options.expectedVersion === undefined) continue; throw error; }
      return { id, document: document(await readSharedFile(tx.paths.memory)), diagnostics };
    }
    throw new SharedStateError('memory-conflict');
  });
}
export const updateProjectMemory = (projectPath: string, id: string | number, patch: MemoryPatch, options: MemoryWriteOptions = {}): Promise<MemoryWriteResult> => changeMemory(projectPath, id, patch, options);
export const removeProjectMemory = (projectPath: string, id: string | number, options: MemoryWriteOptions = {}): Promise<MemoryWriteResult> => changeMemory(projectPath, id, null, options);
export async function undoProjectMemory(projectPath: string, operationId: string, options: MemoryWriteOptions = {}): Promise<{ status: 'undone' | 'missing'; id: string }> {
  validateOperationId(operationId);
  return withMemoryTransaction(projectPath, options, async tx => {
    const operation = tx.state.operations.find(row => row.id === operationId);
    if (!operation || (operation.status !== 'applied' && operation.status !== 'undone') || !operation.rowHash || !operation.appliedVersion) invalid();
    const before = await readSharedFile(tx.paths.memory);
    if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('memory-conflict');
    const row = parseItems(before.text).find(item => item.id === operation.memoryId);
    if (!row) { operation.status = 'undone'; await saveMemoryLocal(tx); return { status: 'missing', id: operation.memoryId }; }
    if (operation.status === 'undone' || hash(before.text.slice(row.start, row.end)) !== operation.rowHash) throw new SharedStateError('memory-conflict');
    await options.beforeCommit?.(tx.paths.memory, 0);
    await writeSharedFile(tx.paths.memory, before.text.slice(0, row.start) + before.text.slice(row.end), before, 0o644);
    operation.status = 'undone'; await saveMemoryLocal(tx); return { status: 'undone', id: operation.memoryId };
  });
}
export const normalizeMemoryFact = normalized;
