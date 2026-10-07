import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { MISSING_SHARED_VERSION, SharedStateError, prepareSharedIgnore, readSharedFile, sharedProjectPaths,
  withSharedProjectLock, writeSharedFile } from './store.js';
import type { SharedDiagnostic, SharedFileSnapshot, SharedProjectPaths, SharedWriteOptions } from './store.js';

export interface BacklogItem {
  id: string | null; title: string; details: string; checked: boolean; section: string | null;
  taken?: string; done?: string; by?: string;
}
interface ParsedItem extends BacklogItem {
  start: number; lineEnd: number; end: number; body: string; eol: string; tokens: string[];
}
export interface BacklogDocument { source: string; items: BacklogItem[]; version: string }
export interface BacklogInput { title: string; details?: string; section?: string; by?: string }
export interface BacklogPatch { title?: string; details?: string; checked?: boolean; taken?: string | null; done?: string | null }
export interface BacklogWriteResult { id: string; document: BacklogDocument; diagnostics: SharedDiagnostic[] }
export type SuggestionKind = 'bug' | 'debt' | 'idea';
export interface BacklogSuggestion {
  id: string; kind: SuggestionKind; title: string; details: string; why: string;
  workId: string; sessionId: string; createdAt: string;
  status: 'pending' | 'accepted' | 'dismissed'; backlogId?: string;
}
interface AppendOperation {
  id: string; backlogId: string; input: BacklogInput; beforeVersion: string; status: 'reserved' | 'applied';
}
/** LOCAL-only counters/terminal records. No sequence or suggestion data is put into Markdown. */
export interface BacklogLocalState {
  version: 1; backlogSeq: number; suggestionSeq: number;
  suggestions: BacklogSuggestion[]; operations: AppendOperation[];
}
export interface BacklogTransaction {
  paths: SharedProjectPaths; state: BacklogLocalState; local: SharedFileSnapshot;
}
const validId = (value: string): boolean => /^b-\d{3,}$/.test(value);
const nextId = (sequence: number): string => `b-${String(sequence).padStart(3, '0')}`;
const boundedSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(): never { throw new SharedStateError('backlog-invalid'); }
export function validateBacklogInput(input: BacklogInput): void {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 4096 || /[\r\n]/.test(input.title) || input.title.includes('\0')) fail();
  if (input.details !== undefined && (typeof input.details !== 'string' || input.details.length > 65_536 || input.details.includes('\0'))) fail();
  if (input.section !== undefined && (typeof input.section !== 'string' || !input.section.trim() || /[\r\n]/.test(input.section) || input.section.includes('\0'))) fail();
  if (input.by !== undefined && !/^s-\d+$/.test(input.by)) fail();
}

/** Offset parser: foreign paragraphs/tables/lists/fenced Markdown remain verbatim. */
export function parseBacklog(source: string): BacklogItem[] {
  return parseItems(source).map(item => ({ id: item.id, title: item.title, details: item.details, checked: item.checked, section: item.section,
    ...(item.taken === undefined ? {} : { taken: item.taken }), ...(item.done === undefined ? {} : { done: item.done }),
    ...(item.by === undefined ? {} : { by: item.by }) }));
}
function parseItems(source: string): ParsedItem[] {
  if (/(?:^|[\r\n])<<<<<<<(?:[ \t]|[\r\n]|$)/.test(source)) throw new SharedStateError('backlog-merge-conflict');
  const lines: { start: number; end: number; body: string; eol: string }[] = [];
  let offset = 0;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const eol = /(?:\r\n|\n|\r)$/.exec(match[0])?.[0] ?? '';
    lines.push({ start: offset, end: offset + match[0].length, body: match[0].slice(0, match[0].length - eol.length), eol });
    offset += match[0].length;
  }
  const items: ParsedItem[] = [];
  const ids = new Set<string>();
  let section: string | null = null;
  let fence: { character: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const body = index === 0 ? line.body.replace(/^\uFEFF/, '') : line.body;
    const marker = /^ {0,3}(`{3,}|~{3,})([\s\S]*)(?![\s\S])/.exec(body);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && /^[ \t]*$/.test(marker[2]!)) fence = null;
      continue;
    }
    if (marker) { fence = { character: marker[1]![0]!, length: marker[1]!.length }; continue; }
    const heading = /^#{1,6}[ \t]+([\s\S]+?)(?:[ \t]+#+)?[ \t]*(?![\s\S])/.exec(body);
    if (heading) { section = heading[1]!; continue; }
    const checkbox = /^- \[([ x])\][ \t]+([\s\S]*)(?![\s\S])/.exec(body);
    if (!checkbox) continue;
    const comment = /[ \t]*<!-- (b-\d{3,})([\s\S]*?) -->[ \t]*(?![\s\S])/.exec(checkbox[2]!);
    const id = comment?.[1] ?? null;
    if (id && ids.has(id)) fail();
    if (id) ids.add(id);
    const tokens = comment ? comment[2]!.split('·').map(token => token.trim()).filter(Boolean) : [];
    const item: ParsedItem = { id, title: (comment ? checkbox[2]!.slice(0, comment.index) : checkbox[2]!).trim(),
      checked: checkbox[1] === 'x', section, details: '', start: line.start, lineEnd: line.end, end: line.end,
      body: line.body, eol: line.eol, tokens };
    for (const token of tokens) {
      if (token.startsWith('taken: ')) item.taken = token.slice(7);
      else if (token.startsWith('done: ')) item.done = token.slice(6);
      else if (token.startsWith('by: ')) item.by = token.slice(4);
    }
    const details: string[] = [];
    while (index + 1 < lines.length && /^ {2}/.test(lines[index + 1]!.body)) {
      const detail = lines[++index]!;
      details.push(detail.body.slice(2)); item.end = detail.end;
    }
    item.details = details.join('\n'); items.push(item);
  }
  return items;
}

function localState(text: string, missing: boolean): BacklogLocalState {
  if (missing) return { version: 1, backlogSeq: 0, suggestionSeq: 0, suggestions: [], operations: [] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new SharedStateError('suggestions-invalid'); }
  if (!object(value) || value['version'] !== 1 || !boundedSequence(value['backlogSeq']) || !boundedSequence(value['suggestionSeq']) ||
      !Array.isArray(value['suggestions']) || !Array.isArray(value['operations'])) throw new SharedStateError('suggestions-invalid');
  const ids = new Set<string>();
  for (const row of value['suggestions'] as unknown[]) {
    if (!object(row) || typeof row['id'] !== 'string' || !/^sg-\d{2,}$/.test(row['id']) || ids.has(row['id']) ||
        !['bug', 'debt', 'idea'].includes(String(row['kind'])) || typeof row['title'] !== 'string' || !row['title'].trim() ||
        typeof row['details'] !== 'string' || typeof row['why'] !== 'string' || !row['why'].trim() ||
        typeof row['workId'] !== 'string' || !/^w-\d+$/.test(row['workId']) ||
        typeof row['sessionId'] !== 'string' || !/^s-\d+$/.test(row['sessionId']) ||
        typeof row['createdAt'] !== 'string' || !Number.isFinite(Date.parse(row['createdAt'])) ||
        !['pending', 'accepted', 'dismissed'].includes(String(row['status'])) ||
        (row['backlogId'] !== undefined && (typeof row['backlogId'] !== 'string' || !validId(row['backlogId']))) ||
        (row['status'] === 'accepted' && row['backlogId'] === undefined)) throw new SharedStateError('suggestions-invalid');
    if (Number(row['id'].slice(3)) > value['suggestionSeq']) throw new SharedStateError('suggestions-invalid');
    ids.add(row['id']);
  }
  const operations = new Set<string>(); const reserved = new Set<string>();
  for (const row of value['operations'] as unknown[]) {
    if (!object(row) || typeof row['id'] !== 'string' || !row['id'] || operations.has(row['id']) ||
        typeof row['backlogId'] !== 'string' || !validId(row['backlogId']) || reserved.has(row['backlogId']) ||
        Number(row['backlogId'].slice(2)) > value['backlogSeq'] || !object(row['input']) ||
        typeof row['beforeVersion'] !== 'string' || !['reserved', 'applied'].includes(String(row['status'])))
      throw new SharedStateError('suggestions-invalid');
    try { validateBacklogInput(row['input'] as unknown as BacklogInput); } catch { throw new SharedStateError('suggestions-invalid'); }
    operations.add(row['id']); reserved.add(row['backlogId']);
  }
  return value as unknown as BacklogLocalState;
}

export async function readBacklogLocal(paths: SharedProjectPaths): Promise<{ state: BacklogLocalState; local: SharedFileSnapshot }> {
  const local = await readSharedFile(paths.suggestions);
  return { local, state: localState(local.text, local.version === MISSING_SHARED_VERSION) };
}
export async function saveBacklogLocal(tx: BacklogTransaction): Promise<void> {
  await writeSharedFile(tx.paths.suggestions, `${JSON.stringify(tx.state, null, 2)}\n`, tx.local);
  tx.local = await readSharedFile(tx.paths.suggestions);
}
export async function withBacklogTransaction<T>(projectPath: string, options: SharedWriteOptions,
  body: (tx: BacklogTransaction) => Promise<T>): Promise<T> {
  const locked = await sharedProjectPaths(projectPath, options);
  return withSharedProjectLock(locked, async () => {
    // Пока ждали замок, человек мог сменить файл бэклога: пути — заново, под замком. Замок у обоих файлов один.
    const paths = await sharedProjectPaths(projectPath, options);
    if (paths.dir !== locked.dir) throw new SharedStateError('backlog-conflict');
    const tx = { paths, ...await readBacklogLocal(paths) };
    // Recover only reserved appends whose known base or already-written identity proves the operation.
    for (const operation of tx.state.operations.filter(row => row.status === 'reserved')) await applyAppend(tx, operation, options, true);
    return body(tx);
  }, options);
}
/** Права записи бэклога: у существующего файла — его собственные (бит исполнения у TODOS.md человека видит git), у нового — 0o644. */
export async function backlogMode(file: string): Promise<number> {
  try { return (await lstat(file)).mode & 0o777; } catch { return 0o644; }
}
export async function readBacklog(projectPath: string, options: SharedWriteOptions = {}): Promise<BacklogDocument> {
  const snapshot = await readSharedFile((await sharedProjectPaths(projectPath, options)).backlog);
  return { source: snapshot.text, version: snapshot.version, items: parseBacklog(snapshot.text) };
}

function eolOf(source: string): string { return /\r\n|\n|\r/.exec(source)?.[0] ?? '\n'; }
function renderLine(item: BacklogItem, tokens: string[], eol: string): string {
  const metadata = [item.id, ...tokens].filter(Boolean).join(' · ');
  return `- [${item.checked ? 'x' : ' '}] ${item.title} <!-- ${metadata} -->${eol}`;
}
function applyReplacements(source: string, replacements: { start: number; end: number; text: string }[]): string {
  for (const row of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, row.start) + row.text + source.slice(row.end);
  return source;
}
function allocateMissing(source: string, state: BacklogLocalState): string {
  const items = parseItems(source);
  for (const item of items) if (item.id) {
    const sequence = Number(item.id.slice(2)); if (!boundedSequence(sequence)) fail();
    state.backlogSeq = Math.max(state.backlogSeq, sequence);
  }
  const replacements = items.filter(item => !item.id).map(item => {
    if (!boundedSequence(state.backlogSeq + 1)) fail();
    state.backlogSeq++;
    return { start: item.start, end: item.lineEnd,
      text: `${item.body} <!-- ${nextId(state.backlogSeq)} -->${item.eol}` };
  });
  return applyReplacements(source, replacements);
}
function insertBlock(source: string, block: string, section?: string): string {
  const eol = eolOf(source);
  if (!source) source = `# Backlog${eol}`;
  const headings = sectionHeadings(source);
  if (section) {
    const selected = headings.findIndex(heading => heading.title === section.trim());
    if (selected >= 0) {
      const at = headings[selected + 1]?.start ?? source.length;
      const before = source.slice(0, at);
      const separator = before.endsWith('\n') || before.endsWith('\r') ? '' : eol;
      return before + separator + block + source.slice(at);
    }
    if (!source.endsWith('\n') && !source.endsWith('\r')) source += eol;
    source += `${eol}## ${section.trim()}${eol}`;
  }
  const separator = source.endsWith('\n') || source.endsWith('\r') ? '' : eol;
  return source + separator + block;
}
function appendSource(source: string, id: string, input: BacklogInput): string {
  const eol = eolOf(source);
  const tokens = input.by ? [`by: ${input.by}`] : [];
  const block = renderLine({ id, title: input.title.trim(), details: '', checked: false, section: null }, tokens, eol) +
    (input.details ? input.details.split(/\r\n|\n|\r/).map(line => `  ${line}${eol}`).join('') : '');
  return insertBlock(source, block, input.section);
}

/** Дописывает в target пункты source, чьих ID в target ещё нет: строка с пометками и подробности — как есть, в свой раздел
 * (нет раздела — новый `## <раздел>` в конце). Пустой target — это source целиком. Повтор ничего не дублирует. */
export function mergeBacklogInto(target: string, source: string): string {
  const present = new Map(parseItems(target).filter(item => item.id !== null).map(item => [item.id!, item]));
  const moving = parseItems(source).filter(item => {
    const known = item.id === null ? undefined : present.get(item.id);
    // Тот же ID с другим текстом — чужой пункт (ID выданы в разных клонах): пропуск потерял бы его вместе с файлом-источником.
    if (known && (known.title !== item.title || known.details !== item.details)) throw new SharedStateError('backlog-conflict');
    return !known;
  });
  if (moving.length === 0) return target;
  if (!target) return source;
  let result = target;
  for (const item of moving) {
    const raw = source.slice(item.start, item.end).replace(/^\uFEFF/, '');
    result = insertBlock(result, /[\r\n]$/.test(raw) ? raw : raw + eolOf(target), item.section ?? undefined);
  }
  parseItems(result); // Дубль ID или маркеры конфликта — ошибка до записи.
  return result;
}

/** Проверка целевого файла до любых изменений: незакрытый блок кода, маркеры конфликта, дубли ID — ошибка. */
export function assertBacklogReadable(source: string): void {
  parseItems(source); sectionHeadings(source);
}

/** Счётчик ID — не ниже любого ID в тексте. Счётчик сохраняется только при записи, а у оставленного файла записей нет:
 * без этого новый пункт повторил бы ID из него, и следующий перенос счёл бы пункт уже перенесённым. */
export function raiseBacklogSeq(state: BacklogLocalState, source: string): void {
  for (const item of parseItems(source)) if (item.id) {
    const sequence = Number(item.id.slice(2)); if (!boundedSequence(sequence)) fail();
    state.backlogSeq = Math.max(state.backlogSeq, sequence);
  }
}

function sectionHeadings(source: string): { title: string; start: number }[] {
  const headings: { title: string; start: number }[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const body = match[0].replace(/[\r\n]+$/, '').replace(/^\uFEFF/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})([\s\S]*)(?![\s\S])/.exec(body);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && /^[ \t]*$/.test(marker[2]!)) fence = null;
      continue;
    }
    if (marker) { fence = { character: marker[1]![0]!, length: marker[1]!.length }; continue; }
    const heading = /^#{1,6}[ \t]+([\s\S]+?)(?:[ \t]+#+)?[ \t]*(?![\s\S])/.exec(body);
    if (heading) headings.push({ title: heading[1]!, start: match.index! });
  }
  if (fence) throw new SharedStateError('backlog-invalid');
  return headings;
}

async function applyAppend(tx: BacklogTransaction, operation: AppendOperation, options: SharedWriteOptions, recovering = false, preparedSource?: string): Promise<BacklogWriteResult> {
  let diagnostics: SharedDiagnostic[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSharedFile(tx.paths.backlog);
    if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('backlog-conflict');
    const items = parseBacklog(before.text);
    if (operation.status === 'applied') return { id: operation.backlogId, document: { source: before.text, version: before.version, items }, diagnostics };
    const existing = items.find(item => item.id === operation.backlogId);
    if (existing) {
      if (existing.title !== operation.input.title.trim() || existing.details !== (operation.input.details ?? '') || existing.by !== operation.input.by)
        throw new SharedStateError('backlog-conflict');
      operation.status = 'applied'; await saveBacklogLocal(tx);
      return { id: operation.backlogId, document: { source: before.text, version: before.version, items }, diagnostics };
    }
    if (recovering && before.version !== operation.beforeVersion) throw new SharedStateError('backlog-conflict');
    // The prepared text belongs to the preparation snapshot, never to a fresh external version.
    let source = attempt === 0 && preparedSource !== undefined && before.version === operation.beforeVersion ?
      preparedSource : allocateMissing(before.text, tx.state);
    operation.beforeVersion = before.version;
    source = appendSource(source, operation.backlogId, operation.input);
    await saveBacklogLocal(tx); // Reserve counters/operation before writing shared Markdown.
    diagnostics = await prepareSharedIgnore(tx.paths, options);
    await options.beforeCommit?.(tx.paths.backlog, attempt);
    try { await writeSharedFile(tx.paths.backlog, source, before, await backlogMode(tx.paths.backlog)); }
    catch (error) {
      if (error instanceof SharedStateError && error.code === 'backlog-conflict' && options.expectedVersion === undefined && !recovering) continue;
      throw error;
    }
    operation.status = 'applied'; await saveBacklogLocal(tx);
    const after = await readSharedFile(tx.paths.backlog);
    return { id: operation.backlogId, document: { source: after.text, version: after.version, items: parseBacklog(after.text) }, diagnostics };
  }
  throw new SharedStateError('backlog-conflict');
}

/** Internal transaction API also used by suggestion acceptance/recovery; caller holds backlog.lock. */
export async function appendBacklogInTransaction(tx: BacklogTransaction, input: BacklogInput, options: SharedWriteOptions = {}, operationId: string = randomUUID()): Promise<BacklogWriteResult> {
  validateBacklogInput(input);
  input = { ...input, title: input.title.trim(), ...(input.details !== undefined ? { details: input.details.replace(/\r\n|\r/g, '\n') } : {}) };
  let operation = tx.state.operations.find(row => row.id === operationId);
  if (operation) {
    if (JSON.stringify(operation.input) !== JSON.stringify(input)) throw new SharedStateError('backlog-conflict');
    return applyAppend(tx, operation, options);
  }
  const before = await readSharedFile(tx.paths.backlog);
  // Validate merge markers/IDs before reserving any local state.
  const prepared = allocateMissing(before.text, tx.state);
  if (!boundedSequence(tx.state.backlogSeq + 1)) fail();
  const backlogId = nextId(++tx.state.backlogSeq);
  operation = { id: operationId, backlogId, input: { ...input }, beforeVersion: before.version, status: 'reserved' };
  tx.state.operations.push(operation);
  return applyAppend(tx, operation, options, false, prepared);
}
export async function addBacklogItem(projectPath: string, input: BacklogInput, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> {
  return withBacklogTransaction(projectPath, options, tx => appendBacklogInTransaction(tx, input, options));
}

/** Allocate IDs for handwritten rows under the same project lock, without adding a new item. */
export async function ensureBacklogIdsInTransaction(tx: BacklogTransaction, options: SharedWriteOptions = {}): Promise<SharedDiagnostic[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSharedFile(tx.paths.backlog);
    const source = allocateMissing(before.text, tx.state);
    if (source === before.text) return [];
    if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('backlog-conflict');
    await saveBacklogLocal(tx); const diagnostics = await prepareSharedIgnore(tx.paths, options);
    await options.beforeCommit?.(tx.paths.backlog, attempt);
    try { await writeSharedFile(tx.paths.backlog, source, before, await backlogMode(tx.paths.backlog)); return diagnostics; }
    catch (error) {
      if (!(error instanceof SharedStateError) || error.code !== 'backlog-conflict' || options.expectedVersion !== undefined) throw error;
    }
  }
  throw new SharedStateError('backlog-conflict');
}

async function changeBacklog(projectPath: string, locator: string | number, patch: BacklogPatch | null, options: SharedWriteOptions): Promise<BacklogWriteResult> {
  // A positional handwritten locator is meaningful only in the exact human-observed Markdown snapshot.
  if (typeof locator === 'string' ? !validId(locator) :
      !Number.isSafeInteger(locator) || locator < 0 || locator >= 10_000 ||
      typeof options.expectedVersion !== 'string' || options.expectedVersion.length === 0) fail();
  if (patch) {
    if (patch.title !== undefined) validateBacklogInput({ title: patch.title });
    if (patch.details !== undefined && (patch.details.length > 65_536 || patch.details.includes('\0'))) fail();
    if (patch.checked !== undefined && typeof patch.checked !== 'boolean') fail();
    if (patch.taken !== undefined && patch.taken !== null && !/^w-\d+\/(?:r|s)-\d+$/.test(patch.taken)) fail();
    if (patch.done !== undefined && patch.done !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.done) ||
      !Number.isFinite(Date.parse(patch.done)) || new Date(patch.done).toISOString().slice(0, 10) !== patch.done)) fail();
  }
  return withBacklogTransaction(projectPath, options, async tx => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readSharedFile(tx.paths.backlog);
      if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) throw new SharedStateError('backlog-conflict');
      const original = parseItems(before.text);
      const index = typeof locator === 'number' ? locator : original.findIndex(row => row.id === locator);
      if (!original[index]) fail();
      let source = allocateMissing(before.text, tx.state);
      const item = parseItems(source)[index];
      if (!item?.id) fail();
      const id = item.id;
      if (patch === null) source = source.slice(0, item.start) + source.slice(item.end);
      else if (Object.keys(patch).length > 0) {
        const updated = { ...item, ...patch };
        let tokens = [...item.tokens];
        for (const key of ['taken', 'done'] as const) if (patch[key] !== undefined) {
          tokens = tokens.filter(token => !token.startsWith(`${key}: `));
          if (patch[key] !== null) tokens.push(`${key}: ${patch[key]}`);
        }
        const line = (item.start === 0 && item.body.startsWith('\uFEFF') ? '\uFEFF' : '') +
          renderLine({ ...item, title: updated.title, checked: updated.checked }, tokens, item.eol || (patch.details ? eolOf(source) : ''));
        const block = patch.details === undefined ? line + source.slice(item.lineEnd, item.end) :
          line + (patch.details ? patch.details.split(/\r\n|\n|\r/).map(detail => `  ${detail}${item.eol || eolOf(source)}`).join('') : '');
        source = source.slice(0, item.start) + block + source.slice(item.end);
      }
      await saveBacklogLocal(tx);
      const diagnostics = await prepareSharedIgnore(tx.paths, options);
      await options.beforeCommit?.(tx.paths.backlog, attempt);
      try { await writeSharedFile(tx.paths.backlog, source, before, await backlogMode(tx.paths.backlog)); }
      catch (error) {
        if (error instanceof SharedStateError && error.code === 'backlog-conflict' && options.expectedVersion === undefined) continue;
        throw error;
      }
      const after = await readSharedFile(tx.paths.backlog);
      return { id, document: { source: after.text, version: after.version, items: parseBacklog(after.text) }, diagnostics };
    }
    throw new SharedStateError('backlog-conflict');
  });
}
export const updateBacklogItem = (projectPath: string, id: string | number, patch: BacklogPatch, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> => changeBacklog(projectPath, id, patch, options);
export const removeBacklogItem = (projectPath: string, id: string | number, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> => changeBacklog(projectPath, id, null, options);
export const takeBacklogItem = (projectPath: string, id: string | number, taken: string, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> => changeBacklog(projectPath, id, { taken }, options);
export const completeBacklogItem = (projectPath: string, id: string, done: string, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> => changeBacklog(projectPath, id, { checked: true, done }, options);
