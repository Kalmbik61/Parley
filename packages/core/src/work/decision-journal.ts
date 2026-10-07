import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectContextOptions } from './project-context.js';
import type { SharedWriteOptions } from './store.js';
import type { Proposal, Room, WorkMap } from './types.js';

export type DecisionJournalCode = 'journal-invalid' | 'journal-conflict' | 'journal-unavailable';
export class DecisionJournalError extends Error {
  constructor(readonly code: DecisionJournalCode) { super(code); this.name = 'DecisionJournalError'; }
}
/** Exact accepted event, captured within the map transition. Filesystem retries use only this payload. */
export interface DecisionJournalIntent {
  file: string;
  workId: string;
  roomId: string;
  proposalId: string;
  rev: number;
  messageId: string;
  acceptedAt: string;
  kind: 'decision' | 'completion';
  snapshot: string | null;
  snapshotSha256: string | null;
  content: string;
  status: 'pending' | 'written';
}
export type DecisionJournalMap = WorkMap & { decisionExports?: DecisionJournalIntent[] };
const text = (value: string): boolean => !value.includes('\0') && Buffer.from(value).toString() === value;
const iso = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
export function validDecisionJournalIntent(value: unknown): value is DecisionJournalIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as DecisionJournalIntent;
  return typeof row.workId === 'string' && /^w-\d+$/.test(row.workId) && row.workId.length <= 128 &&
    typeof row.roomId === 'string' && /^r-\d+$/.test(row.roomId) && row.roomId.length <= 128 &&
    typeof row.proposalId === 'string' && /^p-\d+$/.test(row.proposalId) && row.proposalId.length <= 128 &&
    Number.isSafeInteger(row.rev) && row.rev >= 0 && typeof row.messageId === 'string' && /^m-\d+$/.test(row.messageId) && row.messageId.length <= 128 &&
    typeof row.acceptedAt === 'string' && iso(row.acceptedAt) &&
    row.file === `${row.acceptedAt.slice(0, 10)}-${row.workId}-${row.roomId}-${row.proposalId}-rev-${String(row.rev).padStart(2, '0')}.md` &&
    ['decision', 'completion'].includes(row.kind) && ['pending', 'written'].includes(row.status) &&
    (row.snapshot === null || (typeof row.snapshot === 'string' && new RegExp(`^${row.workId}-${row.roomId}-pl-\\d+-rev-\\d+-(accepted|completed)\\.md$`).test(row.snapshot))) &&
    (row.snapshot === null ? row.snapshotSha256 === null : typeof row.snapshotSha256 === 'string' && /^[0-9a-f]{64}$/.test(row.snapshotSha256)) &&
    typeof row.content === 'string' && Buffer.byteLength(row.content) <= 1024 * 1024 && text(row.content);
}
/** JSON can retain legacy lone UTF-16/control units; Markdown uses visible literal escapes with a truthful marker. */
export function representLegacyMarkdown(value: string): string {
  let escaped = false;
  const units: string[] = [];
  for (const unit of value) {
    const code = unit.codePointAt(0)!;
    const unsafe = (code < 0x20 && ![9, 10, 13].includes(code)) || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
    if (unsafe) { escaped = true; units.push(`\\u${code.toString(16).padStart(4, '0')}`); }
    else units.push(unit);
  }
  const content = units.join('');
  return escaped ? `> Legacy unpaired UTF-16/control units are shown as literal \\uXXXX escapes. This is a generated representation.\n\n${content}` : content;
}
const metadata = (value: string): string => JSON.stringify(value);
function member(map: WorkMap, id: string): string {
  const session = map.sessions.find(row => row.id === id);
  return session ? `${id}: ${metadata(session.label)}${session.role ? ` — ${session.role.source}:${metadata(session.role.name)}` : ''}` : `${id} (deleted)`;
}
/** Called only with the resolved proposal and its just-created decision letter, never a current mutable proposal. */
export function captureDecisionJournal(
  map: DecisionJournalMap,
  room: Room,
  proposal: Proposal,
  action: 'accept' | 'return',
  messageId: string,
  note?: string,
): DecisionJournalIntent | null {
  if (action === 'return') return null;
  const letter = map.messages.find(row => row.id === messageId);
  if (!letter || letter.kind !== 'decision' || letter.roomId !== room.id || letter.from !== proposal.from || letter.text !== proposal.text)
    throw new DecisionJournalError('journal-invalid');
  const previous = map.decisionExports?.find(row => row.roomId === room.id && row.proposalId === proposal.id && row.rev === proposal.rev);
  if (previous) {
    if (previous.messageId !== messageId || !validDecisionJournalIntent(previous)) throw new DecisionJournalError('journal-conflict');
    return previous;
  }
  const planId = proposal.plan?.id ?? proposal.planId;
  const rev = proposal.plan?.rev ?? proposal.planRev;
  const event = proposal.kind === 'completion' ? 'completed' : 'accepted';
  const captured = planId === undefined ? undefined : map.planExports?.find(row => row.planId === planId && row.rev === rev && row.event === event);
  const snapshot = captured?.file ?? null;
  const plan = planId === undefined ? undefined : map.plans?.find(row => row.id === planId && row.rev === rev && row.roomId === room.id);
  if (planId !== undefined && (!snapshot || !plan)) throw new DecisionJournalError('journal-invalid');
  const lines = [
    `# ${proposal.text.split(/\r?\n/, 1)[0] || `Decision ${proposal.id} in ${room.title}`}`, '',
    `Accepted: ${letter.at}`, `Work: ${map.work.id} — ${metadata(map.work.title)}`,
    `Room: ${room.id} — ${metadata(room.title)}`, `Decision: ${proposal.id}; revision: ${proposal.rev}`,
    `Kind: ${proposal.kind ?? 'decision'}`, `Lead: ${member(map, proposal.from)}`, '', '## Participants',
    ...room.members.map(id => `- ${member(map, id)}`), '', '## Decision', proposal.text,
  ];
  if (note !== undefined && note !== '') lines.push('', '## Human remark', note);
  if (plan) {
    lines.push('', `Mode: ${plan.mode}`, `Plan: ${plan.id}; revision: ${plan.rev}`, '', '## Plan items',
      ...plan.items.map(row => `- ${row.id}. ${row.title} — ${member(map, row.owner)}`),
      '', `[Immutable ${event} plan snapshot](../plans/${snapshot})`);
    if (plan.backlog.length) lines.push('', `Backlog: ${plan.backlog.join(', ')}`);
  }
  const intent: DecisionJournalIntent = {
    file: `${letter.at.slice(0, 10)}-${map.work.id}-${room.id}-${proposal.id}-rev-${String(proposal.rev).padStart(2, '0')}.md`,
    workId: map.work.id, roomId: room.id, proposalId: proposal.id, rev: proposal.rev, messageId,
    acceptedAt: letter.at, kind: proposal.kind ?? 'decision', snapshot,
    snapshotSha256: captured ? createHash('sha256').update(captured.content).digest('hex') : null,
    content: representLegacyMarkdown(`${lines.join('\n')}\n`), status: 'pending',
  };
  if (!validDecisionJournalIntent(intent)) throw new DecisionJournalError('journal-invalid');
  map.decisionExports ??= [];
  if (map.decisionExports.length >= 30_000) throw new DecisionJournalError('journal-invalid');
  map.decisionExports.push(intent);
  return intent;
}

/** Parsing keeps absent collections absent; private storage does not create an additional capacity limit. */
export function validateDecisionJournalStorage(map: DecisionJournalMap): void {
  if (map.decisionExports === undefined) return;
  if (!Array.isArray(map.decisionExports) || map.decisionExports.length > 30_000) throw new DecisionJournalError('journal-invalid');
  const keys = new Set<string>();
  for (const intent of map.decisionExports) {
    const key = `${intent.roomId}/${intent.proposalId}/${intent.rev}`;
    if (!validDecisionJournalIntent(intent) || intent.workId !== map.work.id || keys.has(key)) throw new DecisionJournalError('journal-invalid');
    keys.add(key);
  }
}
export interface DecisionJournalFlushResult {
  written: string[];
  failed: { file: string; code: DecisionJournalCode }[];
  diagnostics: import('./store.js').SharedDiagnostic[];
}
/** Never called inside updateMap. A failed publish/ack leaves the accepted payload pending. */
export async function flushDecisionJournal(projectPath: string, workId: string, options: SharedWriteOptions & { excludedFiles?: ReadonlySet<string> } = {}): Promise<DecisionJournalFlushResult> {
  const store = await import('./store.js');
  const { publishImmutableMarkdown, ImmutableMarkdownError } = await import('./shared-markdown.js');
  const map: DecisionJournalMap = await store.readMap(projectPath, workId);
  const result: DecisionJournalFlushResult = { written: [], failed: [], diagnostics: [] };
  for (const intent of map.decisionExports?.filter(row => row.status === 'pending' && !options.excludedFiles?.has(row.file)) ?? []) {
    try {
      if (!validDecisionJournalIntent(intent) || intent.workId !== workId) throw new DecisionJournalError('journal-invalid');
      const paths = await store.sharedProjectPaths(projectPath, options);
      await store.withSharedProjectLock(paths, async () => {
        result.diagnostics.push(...await store.prepareSharedIgnore(paths, options));
        if (intent.snapshot) {
          const previous = await store.readSharedFile(path.join(paths.plans, intent.snapshot));
          if (previous.version === store.MISSING_SHARED_VERSION) throw new DecisionJournalError('journal-unavailable');
          if (createHash('sha256').update(previous.text).digest('hex') !== intent.snapshotSha256) throw new DecisionJournalError('journal-conflict');
        }
        await publishImmutableMarkdown(paths.dir, paths.decisions, intent, options);
      }, options);
      await store.updateMap(projectPath, workId, current => {
        const captured = (current as DecisionJournalMap).decisionExports?.find(row => row.file === intent.file && row.content === intent.content && row.messageId === intent.messageId);
        if (captured) captured.status = 'written';
      }, { ...options, touch: false });
      result.written.push(intent.file);
    } catch (error) {
      result.failed.push({ file: intent.file, code: error instanceof DecisionJournalError ? error.code : error instanceof ImmutableMarkdownError && error.code === 'conflict' ? 'journal-conflict' : 'journal-unavailable' });
    }
  }
  result.diagnostics = [...new Map(result.diagnostics.map(row => [row.code, row])).values()];
  return result;
}

/** Окно читает журнал только узким чтением: сколько файлов и байт берётся за один запрос. */
export const DECISION_LIST_MAX_FILES = 300;
export const DECISION_LIST_MAX_BYTES = 16 * 1024 * 1024;
const DECISION_FILE = /^(\d{4}-\d{2}-\d{2})-(w-\d+)-(r-\d+)-(p-\d+)-rev-(\d+)\.md$/;
const TITLE_LENGTH = 200;
/** Файл журнала как он лежит на диске. `headerAgrees` — шапка совпала с именем; это не доказательство принятия. */
export interface DecisionJournalFile {
  file: string; workId: string; roomId: string; proposalId: string; rev: number;
  /** Дата из имени файла (`YYYY-MM-DD`). */
  date: string;
  title: string;
  kind: 'decision' | 'completion' | null;
  acceptedAt: string | null;
  headerAgrees: boolean;
  sha256: string;
}
export interface DecisionJournalListing {
  /** Новые сверху (по имени: дата первой). */
  files: DecisionJournalFile[];
  /** Симлинки, не-файлы и файлы, которые не удалось прочесть строго. */
  unreadable: number;
  /** `.md` с чужим именем: журналом не считаются и не читаются. */
  unrecognized: number;
  /** Не всё прочитано: предел числа файлов или байт. */
  truncated: boolean;
}
/**
 * Только чтение каталога решений общего контекста проекта: ничего не создаёт и не переносит. Читаются обычные файлы
 * без перехода по симлинкам (`readSharedFile`: NOFOLLOW, строгий UTF-8, до 1 МиБ); каталог должен быть канонической
 * папкой. Нет каталога — пустой журнал.
 */
export async function readDecisionJournalFiles(projectPath: string, options: ProjectContextOptions = {}): Promise<DecisionJournalListing> {
  const store = await import('./store.js');
  const paths = await store.sharedProjectPaths(projectPath, options);
  const dir = paths.decisions;
  const result: DecisionJournalListing = { files: [], unreadable: 0, unrecognized: 0, truncated: false };
  let entries;
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new DecisionJournalError('journal-unavailable');
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error instanceof DecisionJournalError ? error : new DecisionJournalError('journal-unavailable');
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!DECISION_FILE.test(entry.name)) { result.unrecognized++; continue; }
    if (!entry.isFile()) { result.unreadable++; continue; }
    names.push(entry.name);
  }
  names.sort().reverse();
  if (names.length > DECISION_LIST_MAX_FILES) result.truncated = true;
  let bytes = 0;
  for (const name of names.slice(0, DECISION_LIST_MAX_FILES)) {
    try {
      const snapshot = await store.readSharedFile(path.join(dir, name));
      if (snapshot.version === store.MISSING_SHARED_VERSION) continue;
      bytes += Buffer.byteLength(snapshot.text);
      if (bytes > DECISION_LIST_MAX_BYTES) { result.truncated = true; break; }
      result.files.push(describeDecisionFile(name, snapshot.text));
    } catch { result.unreadable++; }
  }
  return result;
}
function describeDecisionFile(name: string, text: string): DecisionJournalFile {
  const [, date, workId, roomId, proposalId, rev] = DECISION_FILE.exec(name)!;
  const first = (pattern: RegExp): RegExpExecArray | null => pattern.exec(text);
  const accepted = first(/^Accepted: (\S+)$/m)?.[1] ?? null;
  const decision = first(/^Decision: (p-\d+); revision: (\d+)$/m);
  const kind = first(/^Kind: (decision|completion)$/m)?.[1] as 'decision' | 'completion' | undefined;
  const acceptedAt = accepted !== null && iso(accepted) ? accepted : null;
  return {
    file: name, workId: workId!, roomId: roomId!, proposalId: proposalId!, rev: Number(rev), date: date!,
    title: (first(/^# (.*)$/m)?.[1] ?? '').slice(0, TITLE_LENGTH), kind: kind ?? null, acceptedAt,
    headerAgrees: acceptedAt !== null && acceptedAt.slice(0, 10) === date &&
      first(/^Work: (w-\d+) — /m)?.[1] === workId && first(/^Room: (r-\d+) — /m)?.[1] === roomId &&
      decision?.[1] === proposalId && Number(decision?.[2]) === Number(rev),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

export type DecisionFileState = 'accepted' | 'retained' | 'edited' | 'unverified';
/**
 * Чем файл журнала можно считать. Имя файла не доказывает принятия: `accepted` — байты совпали с захваченным в карте
 * принятым решением; `retained` — карты работы нет (удалена), шапка согласна с именем; `edited` — карта знает решение,
 * но файл правили; `unverified` — карты не прочли или она такого решения не захватывала.
 * `map`: `null` — работы больше нет, `undefined` — карта не читается.
 */
export function classifyDecisionFile(file: DecisionJournalFile, map: DecisionJournalMap | null | undefined): DecisionFileState {
  if (map === null) return file.headerAgrees ? 'retained' : 'unverified';
  if (map === undefined || map.work.id !== file.workId) return 'unverified';
  const intent = map.decisionExports?.find(row => row.file === file.file && validDecisionJournalIntent(row));
  if (!intent) return 'unverified';
  return createHash('sha256').update(intent.content).digest('hex') === file.sha256 ? 'accepted' : 'edited';
}
