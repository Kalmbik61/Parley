import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  DecisionJournalError, RoomHistoryError, SharedStateError, classifyDecisionFile, parseMap, readDecisionJournalFiles,
  readRoomHistoryStatus, readSharedFile, shareRoomHistory, sharedProjectPaths, unshareRoomHistory, workPaths,
} from '@parley/core';
import type { WorkEntry, WorkMap } from '@parley/core';
import {
  DECISIONS_LIST_DEFAULT_LIMIT, decisionsListResult, journalMethodSchemas, roomHistoryStatus,
} from '@parley/protocol';
import type { DecisionRef, DecisionsListResult, JournalMethodName, JournalMethodParams, JournalMethodResults, RoomHistoryStatusView } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import { HostError } from '../errors.js';
import type { WorksService } from '../works/works-service.js';

export type JournalHandlers = { [M in JournalMethodName]: (params: JournalMethodParams<M>, request?: RequestInfo) => Promise<JournalMethodResults[M]> };

/** Сколько карт читается заново за один запрос списка и сколько чужих проектов сверяется по контексту. */
const MAX_FRESH_MAPS = 100;
const MAX_FOREIGN_PROJECTS = 64;
const MAX_PENDING = 500;

/** Сообщения фиксированные: путь, текст файла и сообщения ОС в ответ не попадают. */
function safeError(error: unknown, subject: 'history' | 'journal'): HostError {
  if (error instanceof HostError) return error;
  const code = error instanceof RoomHistoryError || error instanceof SharedStateError ? error.code
    : error instanceof DecisionJournalError ? 'journal-unavailable' : subject === 'journal' ? 'journal-unavailable' : 'history-unavailable';
  const category = ['history-conflict', 'history-stale', 'backlog-lock-timeout'].includes(code) ? 'conflict'
    : code === 'history-invalid' ? 'bad_request'
      : ['project-unavailable', 'git-context-unverified', 'main-project-unavailable', 'history-not-found'].includes(code) ? 'not_found' : 'internal';
  return new HostError(category, subject === 'journal' ? 'The decision journal could not be read.' : 'The history operation could not be completed.', { code });
}
function validate<M extends JournalMethodName>(method: M, params: JournalMethodParams<M>): JournalMethodParams<M> {
  const parsed = journalMethodSchemas[method].safeParse(params);
  if (!parsed.success) throw new HostError('bad_request', 'Invalid history request.');
  const projectPath = (parsed.data as { projectPath: string }).projectPath;
  if (!path.isAbsolute(projectPath)) throw new HostError('bad_request', 'An absolute project path is required.');
  return parsed.data as JournalMethodParams<M>;
}

/** Свежая карта с диска: проект, работа и комната проверяются по ней, а не по снимку окна. */
async function freshMap(projectPath: string, workId: string): Promise<WorkMap> {
  const file = workPaths(await realpath(projectPath), workId).map;
  if (await realpath(file) !== file) throw new SharedStateError('shared-state-unsafe');
  const map = parseMap((await readSharedFile(file)).text, file);
  if (map.work.id !== workId) throw new SharedStateError('shared-state-unsafe');
  return map;
}
const firstLine = (text: string): string => (/^# (.*)$/m.exec(text)?.[1] ?? '').slice(0, 200);
const folded = (value: string): string => value.toLowerCase();
const stamp = (row: DecisionRef, fallback: string): number => { const value = Date.parse(row.acceptedAt ?? fallback); return Number.isFinite(value) ? value : 0; };

async function listDecisions(works: WorksService, params: JournalMethodParams<'decisions.list'>): Promise<DecisionsListResult> {
  const shared = (await sharedProjectPaths(params.projectPath)).context.projectPath;
  const listing = await readDecisionJournalFiles(params.projectPath);
  // Карты работ, чьи решения лежат в этом общем каталоге: проекты вида «рабочая копия» делят его с главным.
  const relevant: WorkEntry[] = [];
  let uncertain = 0;
  const verdict = new Map<string, boolean>([[params.projectPath, true]]);
  for (const entry of works.snapshot().entries) {
    let same = verdict.get(entry.projectPath);
    if (same === undefined) {
      if (verdict.size > MAX_FOREIGN_PROJECTS) { uncertain++; same = false; }
      else same = await sharedProjectPaths(entry.projectPath).then(paths => paths.context.projectPath === shared, () => { uncertain++; return false; });
      verdict.set(entry.projectPath, same);
    }
    if (same) relevant.push(entry);
  }
  const workIds = new Set(listing.files.map(row => row.workId));
  let fresh = 0; let mapErrors = uncertain;
  const maps = new Map<string, WorkMap>();
  const failed = new Set<string>();
  for (const entry of relevant) {
    const id = entry.map.work.id;
    if (!workIds.has(id) || maps.has(`${entry.projectPath}\0${id}`)) continue;
    if (fresh++ >= MAX_FRESH_MAPS) { failed.add(id); mapErrors++; continue; }
    try { maps.set(`${entry.projectPath}\0${id}`, await freshMap(entry.projectPath, id)); }
    catch { failed.add(id); mapErrors++; }
  }
  const mapsOf = (id: string): WorkMap[] => relevant.filter(entry => entry.map.work.id === id)
    .map(entry => maps.get(`${entry.projectPath}\0${id}`)).filter((map): map is WorkMap => map !== undefined);
  const rows: DecisionRef[] = [];
  for (const file of listing.files) {
    const candidates = mapsOf(file.workId);
    // Работы нет в снимке хоста — удалена, но только если сверка проектов была полной.
    let map: WorkMap | null | undefined;
    if (candidates.length > 0) map = candidates.find(row => row.decisionExports?.some(intent => intent.file === file.file)) ?? candidates[0];
    else map = failed.has(file.workId) || uncertain > 0 || relevant.some(entry => entry.map.work.id === file.workId) ? undefined : null;
    const state = classifyDecisionFile(file, map);
    rows.push({ file: file.file, workId: file.workId, roomId: file.roomId, proposalId: file.proposalId, rev: file.rev,
      acceptedAt: file.acceptedAt, title: file.title, kind: file.kind, state, openable: state === 'accepted' || state === 'retained' });
  }
  // Принятые, но ещё не записанные на диск: решение есть, файла нет.
  let pending = 0;
  const seen = new Set(rows.map(row => row.file));
  for (const entry of relevant) {
    const map = maps.get(`${entry.projectPath}\0${entry.map.work.id}`) ?? entry.map;
    for (const intent of map.decisionExports ?? []) {
      if (intent.status !== 'pending' || seen.has(intent.file)) continue;
      seen.add(intent.file);
      if (pending++ >= MAX_PENDING) { mapErrors++; break; }
      rows.push({ file: intent.file, workId: intent.workId, roomId: intent.roomId, proposalId: intent.proposalId, rev: intent.rev,
        acceptedAt: intent.acceptedAt, title: firstLine(intent.content), kind: intent.kind, state: 'pending', openable: false });
    }
  }
  const words = [...new Set(folded(params.query ?? '').split(/\s+/).filter(Boolean))];
  const matched = rows.filter(row => {
    const haystack = folded(`${row.title} ${row.file} ${row.workId} ${row.roomId} ${row.proposalId} ${row.state}`);
    return words.every(word => haystack.includes(word));
  }).sort((a, b) => stamp(b, b.file.slice(0, 10)) - stamp(a, a.file.slice(0, 10)) || (a.file < b.file ? 1 : -1));
  const counts: DecisionsListResult['errors'] = [
    { code: 'file-unreadable' as const, count: listing.unreadable }, { code: 'file-unrecognized' as const, count: listing.unrecognized },
    { code: 'map-unreadable' as const, count: mapErrors }, { code: 'scan-limit' as const, count: listing.truncated ? 1 : 0 },
  ].filter(row => row.count > 0);
  const result = { decisions: matched.slice(0, params.limit ?? DECISIONS_LIST_DEFAULT_LIMIT), total: matched.length,
    partial: listing.truncated || listing.unreadable > 0 || mapErrors > 0, errors: counts };
  const projected = decisionsListResult.safeParse(result);
  if (!projected.success) throw new DecisionJournalError('journal-invalid');
  return projected.data;
}

/** Работа и комната существуют в свежей карте: окну на слово не верим. */
async function knownRoom(params: { projectPath: string; workId: string; roomId: string }): Promise<void> {
  const map = await freshMap(params.projectPath, params.workId);
  if (!map.rooms.some(room => room.id === params.roomId)) throw new HostError('not_found', 'The room was not found.', { code: 'history-not-found' });
}
const conflict = (): HostError => new HostError('conflict', 'The shared history changed. Refresh and try again.', { code: 'history-conflict' });
const view = async (params: { projectPath: string; workId: string; roomId: string }, diagnostics: { code: 'parley-gitignore-custom' | 'parley-dir-ignored' }[] = []): Promise<RoomHistoryStatusView> => {
  const projected = roomHistoryStatus.safeParse({ ...await readRoomHistoryStatus(params.projectPath, params.workId, params.roomId), diagnostics });
  if (!projected.success) throw new RoomHistoryError('history-invalid');
  return projected.data;
};

export function createJournalHandlers(works: WorksService): JournalHandlers {
  /** Версия и принадлежность перечитываются при запуске операции: устаревшая правка не перетирает чужую. */
  const mutate = async (input: JournalMethodParams<'rooms.history.share'> | JournalMethodParams<'rooms.history.unshare'>, action: 'share' | 'unshare'): Promise<RoomHistoryStatusView> => {
    await knownRoom(input);
    const before = await readRoomHistoryStatus(input.projectPath, input.workId, input.roomId);
    if (before.version !== input.expectedVersion || before.state === 'conflict') throw conflict();
    const run = action === 'share' ? shareRoomHistory : unshareRoomHistory;
    const result = await run(input.projectPath, input.workId, input.roomId, { expectedVersion: input.expectedVersion });
    return view(input, result.diagnostics.map(row => ({ code: row.code })));
  };
  return {
    'decisions.list': async params => {
      try { return await listDecisions(works, validate('decisions.list', params)); }
      catch (error) { throw safeError(error, 'journal'); }
    },
    'rooms.history.get': async params => {
      try { const input = validate('rooms.history.get', params); await knownRoom(input); return await view(input); }
      catch (error) { throw safeError(error, 'history'); }
    },
    'rooms.history.share': async params => {
      try { return await mutate(validate('rooms.history.share', params), 'share'); }
      catch (error) { throw safeError(error, 'history'); }
    },
    'rooms.history.unshare': async params => {
      try { return await mutate(validate('rooms.history.unshare', params), 'unshare'); }
      catch (error) { throw safeError(error, 'history'); }
    },
  };
}
