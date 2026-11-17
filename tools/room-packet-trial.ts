#!/usr/bin/env -S pnpm exec tsx
/**
 * Count script of the room-packet experiment (plan docs/plans/2026-11-17-room-packet-trial-plan.md, section 1 and task E-2).
 *
 * Reads, never writes: the Parley home (through a snapshot copy of `parley.db` + `parley.db-wal` in a temp directory), the
 * hook journals `<project>/.parley/works/<work>/events/<session>.jsonl`, and Claude Code transcripts. No model is involved.
 * Only counts and session ids reach the output; no text of any conversation does.
 *
 * Run: `pnpm exec tsx tools/room-packet-trial.ts --status --trial 2026-11 [--cutoff <ISO>]`
 *      `pnpm exec tsx tools/room-packet-trial.ts --final  --trial 2026-11 --cutoff <ISO>`
 * Help: `--help`. `--status` prints no comparison of the arms and no error shares (the plan keeps the outcome unseen until
 * the final calculation).
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { claudeProjectRoots, findClaudeSessionFile } from '../packages/core/src/discover.js';
import { parleyHome } from '../packages/core/src/home.js';
import { WORK_DB_FILE, closeWorkDb } from '../packages/core/src/work/db.js';
import { PREVIOUS_AGENTS_MAX } from '../packages/core/src/work/agent-switch.js';
import { mapLetterTx } from '../packages/core/src/work/letter-store.js';
import { roomMembership } from '../packages/core/src/work/room-membership.js';
import { forgetParleyHome, readStoredMap, readWorksIndex, workPaths } from '../packages/core/src/work/store.js';
import { isDamagedTrial, type WindowWorkMap, type WorkSession } from '../packages/core/src/work/types.js';
import { PACKET_BRIDGE_EVENT, ROOM_PACKET_EVENT } from '../packages/core/src/work/events.js';

/** `node:sqlite` through `require`, as core does: Vite 5 under vitest cannot resolve a bare `node:`-only module name. */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// ---------------------------------------------------------------------------------------------------------------------
// Fixed parameters of the experiment (plan section 1). They do not change during an experiment.
// ---------------------------------------------------------------------------------------------------------------------

export const WINDOW_CALLS = 30;
export const MIN_SESSIONS_PER_ARM = 10;
export const DEFAULT_SEED = 20261117;
export const DEFAULT_RESAMPLES = 10_000;
/** Plan 1.5: bytes per token in the spend estimate. */
export const BYTES_PER_TOKEN = 3;
/** Plan 1.4 (six weeks) + a week in reserve, in days: the warning threshold for `cleanupPeriodDays`. */
export const RETENTION_WARN_DAYS = 49;
export const RETENTION_DEFAULT_DAYS = 30;
export const PACKET_MARK = 'Room state packet ';

/** Plan E-2, step 4: exactly this list, case-insensitive. Only `is_error` results are looked at. */
export const CALL_ERROR_PHRASES: readonly string[] = [
  'No such tool available',
  'InputValidationError',
  'could not be parsed as JSON',
  'is required and must be',
  'input schema was not in your prompt',
];
const CALL_ERROR_LOWER = CALL_ERROR_PHRASES.map((phrase) => phrase.toLowerCase());

/** Plan E-2 item 21: journal events that prove the session took a turn. Fixed in code and in the hand-over. */
export const TURN_TRACE_EVENTS: readonly string[] = ['UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse'];

export type Arm = 'packet' | 'control';
export const ARMS: readonly Arm[] = ['packet', 'control'];

// ---------------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------------

const ms = (iso: string): number => Date.parse(iso);

/** mulberry32: a seeded generator, so one seed reproduces the interval exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Median rounded up to an integer, used for the substitution check. */
export function medianCeil(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.ceil(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

const num = (value: number): number | string => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value > 0 ? 'Infinity' : 'NaN');

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot of the Parley home (plan E-2 item 12)
// ---------------------------------------------------------------------------------------------------------------------

interface FileStamp { size: number; mtimeMs: number }
const stampOf = (file: string): FileStamp | null => {
  try {
    const info = statSync(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
};
const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  a === null || b === null ? a === b : a.size === b.size && a.mtimeMs === b.mtimeMs;

export interface Snapshot { dir: string; attempts: number; cleanup: () => void }

/**
 * Copies `parley.db` and `parley.db-wal` into a fresh temp directory outside the home and checks the copy. The real files are
 * only read. If a source file changed while it was being copied, the copy is repeated. The directory is removed by `cleanup`.
 */
export function makeSnapshot(home: string, maxAttempts = 5): Snapshot {
  const dbFile = path.join(home, WORK_DB_FILE);
  if (!existsSync(dbFile)) throw new Error(`no ${WORK_DB_FILE} in ${home}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'room-packet-trial-snap-'));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const names = [WORK_DB_FILE, `${WORK_DB_FILE}-wal`];
      const before = names.map((name) => stampOf(path.join(home, name)));
      for (const name of names) rmSync(path.join(dir, name), { force: true });
      for (const name of names) if (existsSync(path.join(home, name))) cpSync(path.join(home, name), path.join(dir, name));
      const after = names.map((name) => stampOf(path.join(home, name)));
      if (!before.every((stamp, index) => sameStamp(stamp, after[index]!))) continue;
      const check = new DatabaseSync(path.join(dir, WORK_DB_FILE));
      try {
        const rows = check.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
        const ok = rows.length === 1 && Object.values(rows[0]!)[0] === 'ok';
        if (!ok) throw new Error('snapshot integrity_check failed');
      } finally {
        check.close();
      }
      return { dir, attempts: attempt, cleanup };
    }
    throw new Error(`the home files kept changing during the copy (${maxAttempts} attempts)`);
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Transcript reading and analysis
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface ReadFile { records: Json[]; truncated: boolean; cut: boolean }

/**
 * One transcript file, cut at the cutoff: reading stops at the first main-chain record with a time not earlier than the
 * cutoff; records without a time before that point are kept. An unparsable line before the cut marks the file truncated.
 */
export function readTranscriptText(text: string, cutoffMs: number | null): ReadFile {
  const records: Json[] = [];
  let truncated = false;
  let cut = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    if (!isObject(record)) {
      truncated = true;
      continue;
    }
    const at = str(record['timestamp']);
    if (cutoffMs !== null && record['isSidechain'] !== true && at !== undefined && ms(at) >= cutoffMs) {
      cut = true;
      break;
    }
    records.push(record);
  }
  return { records, truncated, cut };
}

const hasUsage = (record: Json): boolean => isObject(record['message']) && isObject((record['message'] as Json)['usage']);

/**
 * Several files of one session (a fork or a transfer copies the history into a new file) become one chain. Records are
 * identified by their `uuid`, which survived copies in the real files checked; of two copies the first is kept, unless only
 * the other carries usage data. Records without a `uuid` are never merged.
 */
export function mergeChain(files: readonly Json[][]): { records: Json[]; duplicates: number } {
  const merged: Json[] = [];
  const position = new Map<string, number>();
  let duplicates = 0;
  for (const records of files) {
    for (const record of records) {
      const uuid = str(record['uuid']);
      if (uuid === undefined) {
        merged.push(record);
        continue;
      }
      const seen = position.get(uuid);
      if (seen === undefined) {
        position.set(uuid, merged.length);
        merged.push(record);
        continue;
      }
      duplicates += 1;
      if (!hasUsage(merged[seen]!) && hasUsage(record)) merged[seen] = record;
    }
  }
  return { records: merged, duplicates };
}

export interface WindowFacts {
  /** Index of the compaction in the session's chain. */
  compaction: number;
  /** Tool calls in the window, capped at `WINDOW_CALLS`. */
  calls: number;
  /** Calls whose result is an `is_error` result matching the list. */
  errorCalls: number;
  /** Calls without a result before the end of the file (outcome unknown). */
  unknownCalls: number;
  outcome: 'error' | 'ok' | 'unknown' | 'empty';
  /** The window ended by the cap, by the next compaction, or by the end of the session. */
  finished: boolean;
}

export interface CompactionFacts {
  at: string;
  /** Claude Code record id of the boundary (for the identifiers in the output). */
  received: boolean;
  packetBytes: number;
  /** Model calls (unique message ids, main chain) from this boundary to the next one or the end. */
  modelCalls: number;
  modelCallsWithoutUsage: number;
  /** `hook_cancelled` attachments between the boundary and the first model record, any hook. */
  hookCancelledRecords: number;
}

export interface ChainFacts {
  compactions: CompactionFacts[];
  windows: WindowFacts[];
  getMapPacketRequests: number;
  errorResults: number;
  matchingErrorResults: number;
  records: number;
}

const toolResultText = (block: Json): string => {
  const content = block['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (isObject(part) ? (str(part['text']) ?? '') : '')).join('\n');
  return '';
};

export const isCallError = (text: string): boolean => {
  const lower = text.toLowerCase();
  return CALL_ERROR_LOWER.some((phrase) => lower.includes(phrase));
};

const isGetMap = (name: string): boolean => name === 'get_map' || name.endsWith('__get_map');

/** Windows, errors, packet receipt, spend inputs and `get_map {field: "packet"}` requests of one merged chain. */
export function analyzeChain(records: readonly Json[], closedBeforeCutoff: boolean): ChainFacts {
  interface Call { id: string; window: number }
  const compactions: CompactionFacts[] = [];
  const windowCalls: Call[][] = [];
  const results = new Map<string, { isError: boolean; text: string }>();
  const seenCalls = new Set<string>();
  const seenMessages = new Set<string>();
  const messageWithUsage = new Set<string>();
  let window = -1;
  let modelSeenInWindow = false;
  let getMapPacketRequests = 0;
  let errorResults = 0;
  let matchingErrorResults = 0;

  for (const record of records) {
    const main = record['isSidechain'] !== true;
    const type = str(record['type']);
    if (type === 'system' && str(record['subtype']) === 'compact_boundary' && main) {
      window += 1;
      modelSeenInWindow = false;
      compactions.push({
        at: str(record['timestamp']) ?? '',
        received: false,
        packetBytes: 0,
        modelCalls: 0,
        modelCallsWithoutUsage: 0,
        hookCancelledRecords: 0,
      });
      windowCalls.push([]);
      continue;
    }
    const message = isObject(record['message']) ? record['message'] : undefined;
    if (type === 'attachment' && isObject(record['attachment']) && window >= 0 && !modelSeenInWindow) {
      const attachment = record['attachment'];
      const kind = str(attachment['type']);
      if (kind === 'hook_cancelled') compactions[window]!.hookCancelledRecords += 1;
      if (kind === 'hook_additional_context' && Array.isArray(attachment['content'])) {
        for (const item of attachment['content']) {
          if (typeof item === 'string' && item.startsWith(PACKET_MARK)) {
            compactions[window]!.received = true;
            compactions[window]!.packetBytes = Buffer.byteLength(item, 'utf8');
          }
        }
      }
    }
    if (type === 'assistant' && message !== undefined && main) {
      modelSeenInWindow = true;
      const id = str(message['id']);
      if (id !== undefined && window >= 0 && !seenMessages.has(id)) {
        seenMessages.add(id);
        compactions[window]!.modelCalls += 1;
      }
      if (id !== undefined && hasUsage(record)) messageWithUsage.add(id);
      if (Array.isArray(message['content'])) {
        for (const block of message['content']) {
          if (!isObject(block) || block['type'] !== 'tool_use') continue;
          const callId = str(block['id']);
          const name = str(block['name']) ?? '';
          if (callId === undefined || seenCalls.has(callId)) continue;
          seenCalls.add(callId);
          if (isGetMap(name) && isObject(block['input']) && block['input']['field'] === 'packet') getMapPacketRequests += 1;
          if (window >= 0) windowCalls[window]!.push({ id: callId, window });
        }
      }
    }
    if (type === 'user' && message !== undefined && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        if (!isObject(block) || block['type'] !== 'tool_result') continue;
        const callId = str(block['tool_use_id']);
        if (block['is_error'] === true) {
          errorResults += 1;
          if (isCallError(toolResultText(block))) matchingErrorResults += 1;
        }
        if (callId !== undefined && !results.has(callId)) {
          results.set(callId, { isError: block['is_error'] === true, text: block['is_error'] === true ? toolResultText(block) : '' });
        }
      }
    }
  }

  // Model calls without usage data: unique messages never seen with a `usage` block, per window.
  // (Counted in a second pass because a message's records can arrive in any order.)
  let w = -1;
  const countedNoUsage = new Set<string>();
  for (const record of records) {
    const main = record['isSidechain'] !== true;
    if (str(record['type']) === 'system' && str(record['subtype']) === 'compact_boundary' && main) {
      w += 1;
      continue;
    }
    const message = isObject(record['message']) ? record['message'] : undefined;
    if (str(record['type']) !== 'assistant' || message === undefined || !main || w < 0) continue;
    const id = str(message['id']);
    if (id === undefined || messageWithUsage.has(id) || countedNoUsage.has(id)) continue;
    countedNoUsage.add(id);
    compactions[w]!.modelCallsWithoutUsage += 1;
  }

  const windows: WindowFacts[] = windowCalls.map((all, compaction) => {
    const calls = all.slice(0, WINDOW_CALLS);
    let errorCalls = 0;
    let unknownCalls = 0;
    for (const call of calls) {
      const result = results.get(call.id);
      if (result === undefined) unknownCalls += 1;
      else if (result.isError && isCallError(result.text)) errorCalls += 1;
    }
    const outcome: WindowFacts['outcome'] =
      calls.length === 0 ? 'empty' : errorCalls > 0 ? 'error' : unknownCalls > 0 ? 'unknown' : 'ok';
    const finished = calls.length >= WINDOW_CALLS || compaction < compactions.length - 1 || closedBeforeCutoff;
    return { compaction, calls: calls.length, errorCalls, unknownCalls, outcome, finished };
  });
  return { compactions, windows, getMapPacketRequests, errorResults, matchingErrorResults, records: records.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hook journal
// ---------------------------------------------------------------------------------------------------------------------

export interface JournalFacts {
  present: boolean;
  /** Whole file, no cutoff: the lines carry no time (plan E-2 item 17). */
  sessionStartCompactLines: number;
  bridgeOutcomes: Record<string, number>;
  hostReasons: Record<string, number>;
  /** At least one line proves a turn of the model happened. */
  turnTrace: boolean;
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function parseJournal(text: string | null): JournalFacts {
  const facts: JournalFacts = { present: text !== null, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false };
  if (text === null) return facts;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    const name = str(event['hook_event_name']);
    if (name === undefined) continue;
    if (TURN_TRACE_EVENTS.includes(name)) facts.turnTrace = true;
    if (name === 'SessionStart' && str(event['source']) === 'compact') {
      facts.sessionStartCompactLines += 1;
      facts.turnTrace = true;
    }
    if (name === PACKET_BRIDGE_EVENT) bump(facts.bridgeOutcomes, str(event['outcome']) ?? 'unknown');
    if (name === ROOM_PACKET_EVENT) bump(facts.hostReasons, str(event['reason']) ?? 'unknown');
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------------------------------------------------

export type RoomClass = 'in' | 'out' | 'approx';
export type UnknownReason = 'missing-transcript' | 'truncated-transcript' | 'incomplete-history' | 'approximate-membership';

export interface Period { from: number; to: number }

/** Where one session stood in rooms: exact periods (journal) and approximate ones (rebuilt for rooms without a journal). */
export interface Membership { exact: Period[]; approx: Period[] }

export function classifyCompaction(membership: Membership, atMs: number): RoomClass {
  if (membership.exact.some((period) => period.from <= atMs && atMs < period.to)) return 'in';
  if (membership.approx.some((period) => period.from <= atMs && atMs < period.to)) return 'approx';
  return 'out';
}

export interface SessionFacts {
  id: string;
  workId: string;
  arm: Arm;
  assignedAt: string;
  /** How the transcript side was settled. */
  transcript: 'found' | 'not-launched' | 'no-conversation' | 'missing-not-member' | 'missing';
  unknownReasons: UnknownReason[];
  compactions: Array<CompactionFacts & { room: RoomClass }>;
  windows: Array<WindowFacts & { room: RoomClass }>;
  getMapPacketRequests: number;
  errorResults: number;
  matchingErrorResults: number;
  duplicatesMerged: number;
  filesRead: number;
  journal: JournalFacts;
}

export interface SessionInput {
  session: WorkSession;
  workId: string;
  membership: Membership;
  hasMessages: boolean;
  journal: JournalFacts;
  transcriptFiles: Array<{ id: string; text: string | null }>;
  cutoffMs: number | null;
}

/** Claude ids in order and the history-completeness verdict (plan E-2 items 2 and 22). */
export function claudeIds(session: WorkSession): { ids: string[]; incomplete: boolean } {
  const ids: string[] = [];
  let incomplete = (session.previousAgents?.length ?? 0) >= PREVIOUS_AGENTS_MAX;
  for (const binding of session.previousAgents ?? []) {
    if (binding.provider !== 'claude') continue;
    if (binding.providerSessionId !== null) ids.push(binding.providerSessionId);
    else if (binding.startedAt !== null) incomplete = true;
  }
  if (session.provider === 'claude' && session.providerSessionId !== null) ids.push(session.providerSessionId);
  return { ids: [...new Set(ids)], incomplete };
}

export function analyzeSession(input: SessionInput): SessionFacts {
  const { session, membership, cutoffMs } = input;
  const trial = session.trial;
  if (trial === undefined || isDamagedTrial(trial)) throw new Error('analyzeSession needs an assigned session');
  const { ids, incomplete } = claudeIds(session);
  const unknown = new Set<UnknownReason>();
  if (incomplete) unknown.add('incomplete-history');

  const files: ReadFile[] = [];
  let missing = false;
  for (const file of input.transcriptFiles) {
    if (file.text === null) missing = true;
    else files.push(readTranscriptText(file.text, cutoffMs));
  }
  const trace = input.journal.turnTrace || session.result !== null || session.resultAt !== null || input.hasMessages;
  // Plan E-2 item 21 (as changed after m-8548): a missing file makes the number of windows unknown only for a session that was
  // ever a room member (a journal entry or a rebuilt entry). A session that was never in a room has no main-calculation window
  // by definition, whether its transcript exists or not; "no conversation" is only a diagnostic line.
  const everMember = membership.exact.length > 0 || membership.approx.length > 0;
  let transcript: SessionFacts['transcript'] = 'found';
  if (ids.length === 0) transcript = 'not-launched';
  else if (missing) {
    if (everMember) {
      transcript = 'missing';
      unknown.add('missing-transcript');
    } else transcript = trace ? 'missing-not-member' : 'no-conversation';
  }
  if (files.some((file) => file.truncated)) unknown.add('truncated-transcript');

  const merged = mergeChain(files.map((file) => file.records));
  const closedBeforeCutoff =
    session.closedAt !== null && (cutoffMs === null || ms(session.closedAt) < cutoffMs);
  const chain = analyzeChain(merged.records, closedBeforeCutoff);
  const compactions = chain.compactions.map((compaction) => ({
    ...compaction,
    room: classifyCompaction(membership, ms(compaction.at)),
  }));
  if (compactions.some((compaction) => compaction.room === 'approx')) unknown.add('approximate-membership');
  const windows = chain.windows.map((window) => ({ ...window, room: compactions[window.compaction]!.room }));
  return {
    id: session.id,
    workId: input.workId,
    arm: trial.arm,
    assignedAt: trial.at,
    transcript,
    unknownReasons: [...unknown],
    compactions,
    windows,
    getMapPacketRequests: chain.getMapPacketRequests,
    errorResults: chain.errorResults,
    matchingErrorResults: chain.matchingErrorResults,
    duplicatesMerged: merged.duplicates,
    filesRead: files.length,
    journal: input.journal,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The calculation (plan 1.3)
// ---------------------------------------------------------------------------------------------------------------------

/** One session in the calculation: windows and windows with an error. */
export interface Unit { n: number; e: number }
export type Weighting = 'pooled' | 'equal';
export type Verdict = 'supports' | 'below-target' | 'undetermined';

export function armRate(units: readonly Unit[], weighting: Weighting): number {
  if (units.length === 0) return Number.NaN;
  if (weighting === 'equal') return units.reduce((sum, unit) => sum + unit.e / unit.n, 0) / units.length;
  return units.reduce((sum, unit) => sum + unit.e, 0) / units.reduce((sum, unit) => sum + unit.n, 0);
}

/** R = packet share / control share; a zero control share gives 1 when the packet share is zero too, infinity otherwise. */
export function ratio(packetRate: number, controlRate: number): number {
  if (controlRate === 0) return packetRate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return packetRate / controlRate;
}

const nearestRank = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

export interface Interval { r: number; lo: number; hi: number }

/**
 * Bootstrap inside each arm separately: sessions are redrawn with replacement, `resamples` times, one seeded generator.
 * The 2.5th and 97.5th percentiles (nearest rank) of R are L and U. `trace` is a test hook: it sees every redraw.
 */
export function bootstrap(
  packet: readonly Unit[],
  control: readonly Unit[],
  weighting: Weighting,
  seed: number,
  resamples: number,
  trace?: (arm: Arm, indices: readonly number[]) => void,
): Interval {
  const rng = mulberry32(seed);
  const draw = (units: readonly Unit[], arm: Arm): Unit[] => {
    const indices: number[] = [];
    for (let i = 0; i < units.length; i += 1) indices.push(Math.floor(rng() * units.length));
    trace?.(arm, indices);
    return indices.map((index) => units[index]!);
  };
  const values: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const p = draw(packet, 'packet');
    const c = draw(control, 'control');
    values.push(ratio(armRate(p, weighting), armRate(c, weighting)));
  }
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    r: ratio(armRate(packet, weighting), armRate(control, weighting)),
    lo: nearestRank(values, 0.025),
    hi: nearestRank(values, 0.975),
  };
}

export interface Decision {
  verdict: Verdict;
  /** Why no calculation was made, when it was not. */
  reason: string | null;
  interval: Interval | null;
}

/** Plan 1.3: the three-way verdict, and "undetermined without a calculation" for thin or degenerate data. */
export function decide(
  packet: readonly Unit[],
  control: readonly Unit[],
  weighting: Weighting,
  seed: number,
  resamples: number,
): Decision {
  if (packet.length < MIN_SESSIONS_PER_ARM || control.length < MIN_SESSIONS_PER_ARM) {
    return { verdict: 'undetermined', reason: `fewer than ${MIN_SESSIONS_PER_ARM} sessions with a window in an arm`, interval: null };
  }
  const errors = (units: readonly Unit[]): number => units.reduce((sum, unit) => sum + unit.e, 0);
  if (errors(packet) === 0 || errors(control) === 0) {
    return { verdict: 'undetermined', reason: 'an arm has no window with a call error', interval: null };
  }
  const interval = bootstrap(packet, control, weighting, seed, resamples);
  const verdict: Verdict =
    interval.hi < 1 && interval.r <= 0.5 ? 'supports' : interval.lo > 0.5 ? 'below-target' : 'undetermined';
  return { verdict, reason: null, interval };
}

export type Bound = 'favourable' | 'unfavourable';

/**
 * Unknown outcomes get opposite assumptions per arm. Favourable to the packet: unknown in the packet arm is no error, in the
 * control arm an error. Unfavourable: the other way round.
 */
export const unknownIsError = (bound: Bound, arm: Arm): boolean => (bound === 'favourable' ? arm === 'control' : arm === 'packet');

export type WindowSelect = (session: SessionFacts, window: SessionFacts['windows'][number]) => boolean;

/** Units of one arm under one bound; sessions with no selected window do not appear. */
export function unitsOf(sessions: readonly SessionFacts[], select: WindowSelect, bound: Bound): Unit[] {
  const units: Unit[] = [];
  for (const session of sessions) {
    let n = 0;
    let e = 0;
    for (const window of session.windows) {
      if (window.outcome === 'empty' || !select(session, window)) continue;
      n += 1;
      if (window.outcome === 'error' || (window.outcome === 'unknown' && unknownIsError(bound, session.arm))) e += 1;
    }
    if (n > 0) units.push({ n, e });
  }
  return units;
}

export interface CheckResult { name: string; note: string; bounds: Record<Bound, Decision> }

export interface FinalResult {
  verdict: Verdict;
  reasons: string[];
  /** One decision per bound (identical when no outcome is unknown); null: no calculation was made. */
  bounds: Record<Bound, Decision> | null;
  sensitivity: CheckResult[];
  unknownOutcomeWindows: number;
}

const inRoom: WindowSelect = (_session, window) => window.room === 'in';

function decideBounds(
  select: (arm: Arm) => { sessions: readonly SessionFacts[]; select: WindowSelect },
  weighting: Weighting,
  seed: number,
  resamples: number,
): Record<Bound, Decision> {
  const one = (bound: Bound): Decision => {
    const side = (arm: Arm): Unit[] => {
      const config = select(arm);
      return unitsOf(config.sessions, config.select, bound);
    };
    return decide(side('packet'), side('control'), weighting, seed, resamples);
  };
  return { favourable: one('favourable'), unfavourable: one('unfavourable') };
}

const combine = (bounds: Record<Bound, Decision>): Verdict =>
  bounds.favourable.verdict === bounds.unfavourable.verdict ? bounds.favourable.verdict : 'undetermined';

export interface FinalInput {
  /** Sessions of the experiment cohort, both arms. */
  cohort: readonly SessionFacts[];
  damagedSessions: number;
  unreadableWorks: number;
  seed: number;
  resamples: number;
}

/** The final calculation of plan 1.3 and the pre-declared sensitivity checks. */
export function computeFinal(input: FinalInput): FinalResult {
  const reasons: string[] = [];
  if (input.damagedSessions > 0) reasons.push(`${input.damagedSessions} session(s) with a damaged assignment in the home`);
  if (input.unreadableWorks > 0) reasons.push(`${input.unreadableWorks} work(s) of the home could not be read`);
  const unknownSessions = input.cohort.filter((session) => session.unknownReasons.length > 0);
  if (unknownSessions.length > 0) {
    reasons.push(`${unknownSessions.length} session(s) with an unknown number of windows`);
  }
  const known = input.cohort.filter((session) => session.unknownReasons.length === 0);
  const unknownOutcomeWindows = known.reduce(
    (sum, session) => sum + session.windows.filter((window) => window.room === 'in' && window.outcome === 'unknown').length,
    0,
  );
  const blocked = reasons.length > 0;

  const byArm = (arm: Arm): SessionFacts[] => known.filter((session) => session.arm === arm);
  const run = (select: WindowSelect, weighting: Weighting, sessionsOf: (arm: Arm) => SessionFacts[] = byArm): Record<Bound, Decision> =>
    decideBounds((arm) => ({ sessions: sessionsOf(arm), select }), weighting, input.seed, input.resamples);

  const bounds = blocked ? null : run(inRoom, 'pooled');
  const verdict: Verdict = bounds === null ? 'undetermined' : combine(bounds);
  if (bounds !== null && bounds.favourable.verdict !== bounds.unfavourable.verdict) reasons.push('the two bounds disagree');

  const firstOnly = (arm: Arm): SessionFacts[] =>
    byArm(arm).map((session) => {
      const first = session.windows.find((window) => window.room === 'in' && window.outcome !== 'empty');
      return { ...session, windows: first === undefined ? [] : [first] };
    });
  const everyWindow: WindowSelect = () => true;
  const sensitivity: CheckResult[] = [
    { name: 'equal weight per session', note: 'each session counts once: mean of its own shares', bounds: run(inRoom, 'equal') },
    { name: 'first compaction of each session only', note: 'first in-room window of each session', bounds: run(inRoom, 'pooled', firstOnly) },
    { name: 'without unfinished windows', note: 'windows that were still open at the cutoff are dropped', bounds: run((session, window) => inRoom(session, window) && window.finished, 'pooled') },
    { name: 'all compactions including those outside a room', note: 'windows outside a room and with approximate membership are counted too', bounds: run(everyWindow, 'pooled') },
  ];
  return { verdict, reasons, bounds, sensitivity, unknownOutcomeWindows };
}

/**
 * The median-substitution check needs the sessions that are unknown. This variant of the final calculation takes them in:
 * known sessions as they are, unknown ones as `median` windows whose outcomes follow the bound.
 */
export function medianSubstitution(
  cohort: readonly SessionFacts[],
  seed: number,
  resamples: number,
): { medians: Record<Arm, number>; bounds: Record<Bound, Decision>; substituted: number } {
  const known = cohort.filter((session) => session.unknownReasons.length === 0);
  const unknown = cohort.filter((session) => session.unknownReasons.length > 0);
  const medians = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      medianCeil(
        known
          .filter((session) => session.arm === arm)
          .map((session) => session.windows.filter((window) => window.room === 'in' && window.outcome !== 'empty').length)
          .filter((count) => count > 0),
      ),
    ]),
  ) as Record<Arm, number>;
  const one = (bound: Bound): Decision => {
    const side = (arm: Arm): Unit[] => {
      const own = unitsOf(known.filter((session) => session.arm === arm), inRoom, bound);
      const extra = unknown
        .filter((session) => session.arm === arm && medians[arm] > 0)
        .map((): Unit => ({ n: medians[arm], e: unknownIsError(bound, arm) ? medians[arm] : 0 }));
      return [...own, ...extra];
    };
    return decide(side('packet'), side('control'), 'pooled', seed, resamples);
  };
  return { medians, bounds: { favourable: one('favourable'), unfavourable: one('unfavourable') }, substituted: unknown.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Aggregation and output
// ---------------------------------------------------------------------------------------------------------------------

export interface ArmSummary {
  sessions: number;
  sessionsWithWindow: number;
  notLaunched: number;
  noConversation: number;
  missingNotMember: number;
  transcriptMissing: number;
  incompleteHistory: number;
  truncatedTranscript: number;
  approximateMembership: number;
  compactions: number;
  compactionsInRoom: number;
  compactionsOutOfRoom: number;
  compactionsApproximate: number;
  emptyWindowsInRoom: number;
  packetsReceived: number;
  packetsReceivedOutOfRoom: number;
  getMapPacketRequests: number;
  /** Spend estimate (plan 1.5): packet bytes / 3 x model calls to the next compaction. */
  spendEstimateTokens: number;
  modelCallsInSpend: number;
  modelCallsWithoutUsageInSpend: number;
  /** Journal counts, whole file, no cutoff. */
  journal: {
    sessionsWithJournal: number;
    sessionStartCompactLines: number;
    transcriptCompactionsWholeFile: number;
    bridgeOutcomes: Record<string, number>;
    hostReasons: Record<string, number>;
  };
}

export interface OutcomeSummary {
  windowsInRoom: number;
  errorWindows: number;
  unknownOutcomeWindows: number;
  unfinishedWindows: number;
  callErrorResults: number;
  allErrorResults: number;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

export function summarizeArm(sessions: readonly SessionFacts[]): ArmSummary {
  const compactions = sessions.flatMap((session) => session.compactions);
  const inRoomCompactions = compactions.filter((compaction) => compaction.room === 'in');
  const received = inRoomCompactions.filter((compaction) => compaction.received);
  const bridgeOutcomes: Record<string, number> = {};
  const hostReasons: Record<string, number> = {};
  for (const session of sessions) {
    for (const [key, count] of Object.entries(session.journal.bridgeOutcomes)) bridgeOutcomes[key] = (bridgeOutcomes[key] ?? 0) + count;
    for (const [key, count] of Object.entries(session.journal.hostReasons)) hostReasons[key] = (hostReasons[key] ?? 0) + count;
  }
  return {
    sessions: sessions.length,
    sessionsWithWindow: sessions.filter((session) => session.unknownReasons.length === 0 && session.windows.some((window) => window.room === 'in' && window.outcome !== 'empty')).length,
    notLaunched: sessions.filter((session) => session.transcript === 'not-launched').length,
    noConversation: sessions.filter((session) => session.transcript === 'no-conversation').length,
    missingNotMember: sessions.filter((session) => session.transcript === 'missing-not-member').length,
    transcriptMissing: sessions.filter((session) => session.unknownReasons.includes('missing-transcript')).length,
    incompleteHistory: sessions.filter((session) => session.unknownReasons.includes('incomplete-history')).length,
    truncatedTranscript: sessions.filter((session) => session.unknownReasons.includes('truncated-transcript')).length,
    approximateMembership: sessions.filter((session) => session.unknownReasons.includes('approximate-membership')).length,
    compactions: compactions.length,
    compactionsInRoom: inRoomCompactions.length,
    compactionsOutOfRoom: compactions.filter((compaction) => compaction.room === 'out').length,
    compactionsApproximate: compactions.filter((compaction) => compaction.room === 'approx').length,
    emptyWindowsInRoom: sessions.flatMap((session) => session.windows).filter((window) => window.room === 'in' && window.outcome === 'empty').length,
    packetsReceived: received.length,
    packetsReceivedOutOfRoom: compactions.filter((compaction) => compaction.room !== 'in' && compaction.received).length,
    getMapPacketRequests: sum(sessions.map((session) => session.getMapPacketRequests)),
    spendEstimateTokens: Math.round(sum(compactions.filter((compaction) => compaction.received).map((compaction) => (compaction.packetBytes / BYTES_PER_TOKEN) * compaction.modelCalls))),
    modelCallsInSpend: sum(compactions.filter((compaction) => compaction.received).map((compaction) => compaction.modelCalls)),
    modelCallsWithoutUsageInSpend: sum(compactions.filter((compaction) => compaction.received).map((compaction) => compaction.modelCallsWithoutUsage)),
    journal: {
      sessionsWithJournal: sessions.filter((session) => session.journal.present).length,
      sessionStartCompactLines: sum(sessions.map((session) => session.journal.sessionStartCompactLines)),
      transcriptCompactionsWholeFile: compactions.length,
      bridgeOutcomes,
      hostReasons,
    },
  };
}

export function summarizeOutcome(sessions: readonly SessionFacts[]): OutcomeSummary {
  const windows = sessions.filter((session) => session.unknownReasons.length === 0).flatMap((session) => session.windows).filter((window) => window.room === 'in' && window.outcome !== 'empty');
  return {
    windowsInRoom: windows.length,
    errorWindows: windows.filter((window) => window.outcome === 'error').length,
    unknownOutcomeWindows: windows.filter((window) => window.outcome === 'unknown').length,
    unfinishedWindows: windows.filter((window) => !window.finished).length,
    callErrorResults: sum(sessions.map((session) => session.matchingErrorResults)),
    allErrorResults: sum(sessions.map((session) => session.errorResults)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code retention (plan E-2 item 23)
// ---------------------------------------------------------------------------------------------------------------------

export interface Retention { value: number; source: 'file' | 'default-unset' | 'default-no-file' | 'default-unreadable'; warning: boolean }

export function readRetention(settingsFile: string): Retention {
  let raw: string;
  try {
    raw = readFileSync(settingsFile, 'utf8');
  } catch {
    return { value: RETENTION_DEFAULT_DAYS, source: 'default-no-file', warning: RETENTION_DEFAULT_DAYS < RETENTION_WARN_DAYS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: RETENTION_DEFAULT_DAYS, source: 'default-unreadable', warning: true };
  }
  const value = isObject(parsed) ? parsed['cleanupPeriodDays'] : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return { value, source: 'file', warning: value < RETENTION_WARN_DAYS };
  return { value: RETENTION_DEFAULT_DAYS, source: 'default-unset', warning: RETENTION_DEFAULT_DAYS < RETENTION_WARN_DAYS };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the home
// ---------------------------------------------------------------------------------------------------------------------

export interface Options {
  mode: 'status' | 'final';
  trial: string;
  cutoff: string | null;
  home: string;
  claudeRoots: string[];
  claudeSettings: string;
  out: string | null;
  seed: number;
  resamples: number;
}

export interface Cohort {
  sessions: SessionFacts[];
  damagedSessions: string[];
  unreadableWorks: string[];
  otherTrialSessions: number;
  assignedAfterCutoff: string[];
  firstAssignment: string | null;
  lastAssignment: string | null;
  worksRead: number;
  snapshotAttempts: number;
}

const readIfExists = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};

function membershipOf(map: WindowWorkMap, sessionId: string): Membership {
  const membership: Membership = { exact: [], approx: [] };
  const period = (from: string, to: string | null): Period => ({ from: ms(from), to: to === null ? Number.POSITIVE_INFINITY : ms(to) });
  const letters = mapLetterTx(map).letters;
  for (const room of map.rooms) {
    if (room.memberLog !== undefined) {
      for (const record of room.memberLog) if (record.session === sessionId) membership.exact.push(period(record.from, record.to));
      continue;
    }
    try {
      const view = roomMembership(map, room.id, letters);
      for (const member of view.members) if (member.session === sessionId) for (const p of member.periods) membership.approx.push(period(p.from, p.to));
    } catch {
      if (room.members.includes(sessionId)) membership.approx.push(period(room.createdAt, null));
    }
  }
  return membership;
}

/** Reads the cohort of the named experiment from a snapshot of the home. Nothing is written to the home. */
export async function collectCohort(options: Options): Promise<Cohort> {
  const cutoffMs = options.cutoff === null ? null : ms(options.cutoff);
  const snapshot = makeSnapshot(options.home);
  const savedHome = process.env['PARLEY_HOME'];
  const cohort: Cohort = {
    sessions: [],
    damagedSessions: [],
    unreadableWorks: [],
    otherTrialSessions: 0,
    assignedAfterCutoff: [],
    firstAssignment: null,
    lastAssignment: null,
    worksRead: 0,
    snapshotAttempts: snapshot.attempts,
  };
  try {
    process.env['PARLEY_HOME'] = snapshot.dir;
    forgetParleyHome();
    closeWorkDb();
    const index = await readWorksIndex();
    for (const entry of index.works) {
      let map: WindowWorkMap;
      try {
        map = readStoredMap(entry.projectPath, entry.id);
      } catch {
        cohort.unreadableWorks.push(`${entry.projectPath}#${entry.id}`);
        continue;
      }
      cohort.worksRead += 1;
      for (const session of map.sessions) {
        const trial = session.trial;
        if (trial === undefined) continue;
        if (isDamagedTrial(trial)) {
          cohort.damagedSessions.push(`${entry.id}/${session.id}`);
          continue;
        }
        if (trial.name !== options.trial) {
          cohort.otherTrialSessions += 1;
          continue;
        }
        if (cohort.firstAssignment === null || trial.at < cohort.firstAssignment) cohort.firstAssignment = trial.at;
        if (cohort.lastAssignment === null || trial.at > cohort.lastAssignment) cohort.lastAssignment = trial.at;
        if (cutoffMs !== null && ms(trial.at) >= cutoffMs) {
          cohort.assignedAfterCutoff.push(`${entry.id}/${session.id}`);
          continue;
        }
        const { ids } = claudeIds(session);
        const transcriptFiles: SessionInput['transcriptFiles'] = [];
        for (const id of ids) {
          const file = await findClaudeSessionFile(id, options.claudeRoots);
          transcriptFiles.push({ id, text: file === null ? null : await readIfExists(file) });
        }
        const journalFile = path.join(workPaths(entry.projectPath, entry.id).events, `${session.id}.jsonl`);
        cohort.sessions.push(
          analyzeSession({
            session,
            workId: entry.id,
            membership: membershipOf(map, session.id),
            hasMessages: map.messages.some((message) => message.from === session.id),
            journal: parseJournal(await readIfExists(journalFile)),
            transcriptFiles,
            cutoffMs,
          }),
        );
      }
    }
  } finally {
    closeWorkDb();
    if (savedHome === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = savedHome;
    forgetParleyHome();
    snapshot.cleanup();
  }
  return cohort;
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------

const decisionJson = (decision: Decision): Record<string, unknown> => ({
  verdict: decision.verdict,
  reason: decision.reason,
  r: decision.interval === null ? null : num(decision.interval.r),
  lo: decision.interval === null ? null : num(decision.interval.lo),
  hi: decision.interval === null ? null : num(decision.interval.hi),
});

export interface Report {
  json: Record<string, unknown>;
  lines: string[];
}

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

function row(label: string, packet: string | number, control: string | number): string {
  return `  ${pad(label, 74)}${pad(String(packet), 18)}${control}`;
}

const share = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${part}/${whole} (${((100 * part) / whole).toFixed(1)}%)`);

export function buildReport(options: Options, cohort: Cohort, retention: Retention): Report {
  const byArm = (arm: Arm): SessionFacts[] => cohort.sessions.filter((session) => session.arm === arm);
  const summary = { packet: summarizeArm(byArm('packet')), control: summarizeArm(byArm('control')) };
  const lines: string[] = [];
  const meta = {
    mode: options.mode,
    trial: options.trial,
    cutoff: options.cutoff,
    firstAssignment: cohort.firstAssignment,
    lastAssignment: cohort.lastAssignment,
    seed: options.seed,
    resamples: options.resamples,
  };
  lines.push(`Room packet trial "${options.trial}" - ${options.mode}`);
  lines.push(`  cutoff: ${options.cutoff ?? 'none (all records)'}; first assignment: ${cohort.firstAssignment ?? '-'}; last assignment: ${cohort.lastAssignment ?? '-'}`);
  lines.push(`  works read: ${cohort.worksRead}; snapshot attempts: ${cohort.snapshotAttempts}`);
  lines.push(`  Claude Code cleanupPeriodDays: ${retention.value} (${retention.source})${retention.warning ? ` - WARNING: below ${RETENTION_WARN_DAYS} days, transcripts of the experiment may be deleted before the final count` : ''}`);
  lines.push(`  sessions with a damaged assignment (whole home, not in the cohort): ${cohort.damagedSessions.length}${cohort.damagedSessions.length > 0 ? ` [${cohort.damagedSessions.join(', ')}]` : ''}`);
  lines.push(`  works that could not be read: ${cohort.unreadableWorks.length}${cohort.unreadableWorks.length > 0 ? ` [${cohort.unreadableWorks.join(', ')}]` : ''}`);
  lines.push(`  sessions of other experiments (ignored): ${cohort.otherTrialSessions}; assigned at or after the cutoff (ignored): ${cohort.assignedAfterCutoff.length}`);
  lines.push('');
  lines.push(row('', 'packet', 'control'));
  const both = (label: string, pick: (summary: ArmSummary) => string | number): void => { lines.push(row(label, pick(summary.packet), pick(summary.control))); };
  both('sessions in the cohort', (s) => s.sessions);
  both('  not launched (no claude id)', (s) => s.notLaunched);
  both('  without a conversation (id, no file, no trace, never in a room)', (s) => s.noConversation);
  both('  file missing, never in a room (zero windows, known)', (s) => s.missingNotMember);
  both('  room member with no transcript file (unknown)', (s) => s.transcriptMissing);
  both('  history incomplete (unknown)', (s) => s.incompleteHistory);
  both('  transcript cut off mid-record (unknown)', (s) => s.truncatedTranscript);
  both('  membership approximate, room without a journal (unknown)', (s) => s.approximateMembership);
  both('sessions with at least one window in a room', (s) => s.sessionsWithWindow);
  both('compactions', (s) => s.compactions);
  both('  in a room (main calculation)', (s) => s.compactionsInRoom);
  both('  outside a room (separate line, not counted)', (s) => s.compactionsOutOfRoom);
  both('  approximate membership (separate line, unknown)', (s) => s.compactionsApproximate);
  both('windows without a tool call, in a room (not in the denominator)', (s) => s.emptyWindowsInRoom);
  both('packets received / in-room compactions', (s) => share(s.packetsReceived, s.compactionsInRoom));
  both('packets received outside a room (should be 0)', (s) => s.packetsReceivedOutOfRoom);
  both('get_map {field: "packet"} requests', (s) => s.getMapPacketRequests);
  both('spend estimate, tokens (bytes/3 x model calls)', (s) => s.spendEstimateTokens);
  both('  model calls in the estimate / without usage data', (s) => `${s.modelCallsInSpend}/${s.modelCallsWithoutUsageInSpend}`);
  lines.push('  journal, WHOLE FILE, no cutoff (lines carry no time):');
  both('  sessions with a journal', (s) => s.journal.sessionsWithJournal);
  both('  SessionStart compact lines / compactions in transcripts (whole file)', (s) => `${s.journal.sessionStartCompactLines}/${s.journal.transcriptCompactionsWholeFile}`);
  const kinds = (pick: (summary: ArmSummary) => Record<string, number>): string[] => [...new Set([...Object.keys(pick(summary.packet)), ...Object.keys(pick(summary.control))])].sort();
  for (const kind of kinds((s) => s.journal.bridgeOutcomes)) both(`  bridge outcome: ${kind}`, (s) => s.journal.bridgeOutcomes[kind] ?? 0);
  for (const kind of kinds((s) => s.journal.hostReasons)) both(`  host reason: ${kind}`, (s) => s.journal.hostReasons[kind] ?? 0);
  lines.push('  bridge cancellations by the hook limit: not determined (the CLI writes no record of a cancelled hook; "timeout" above is the bridge\'s own 1.5 s wait)');
  const hookCancelled = sum(cohort.sessions.flatMap((session) => session.compactions).map((compaction) => compaction.hookCancelledRecords));
  lines.push(`  hook_cancelled records in transcripts (any hook, before the first model record): ${hookCancelled}`);

  const json: Record<string, unknown> = {
    meta,
    retention,
    cohort: {
      sessions: cohort.sessions.length,
      damagedSessions: cohort.damagedSessions,
      unreadableWorks: cohort.unreadableWorks,
      otherTrialSessions: cohort.otherTrialSessions,
      assignedAfterCutoff: cohort.assignedAfterCutoff,
      worksRead: cohort.worksRead,
    },
    arms: summary,
    bridgeCancellationsByHookLimit: 'not determined',
    hookCancelledRecords: hookCancelled,
    sessionsByUnknown: cohort.sessions
      .filter((session) => session.unknownReasons.length > 0)
      .map((session) => ({ session: `${session.workId}/${session.id}`, arm: session.arm, reasons: session.unknownReasons })),
  };

  if (options.mode === 'final') {
    const outcome = { packet: summarizeOutcome(byArm('packet')), control: summarizeOutcome(byArm('control')) };
    const result = computeFinal({
      cohort: cohort.sessions,
      damagedSessions: cohort.damagedSessions.length,
      unreadableWorks: cohort.unreadableWorks.length,
      seed: options.seed,
      resamples: options.resamples,
    });
    lines.push('');
    lines.push('Outcome (plan 1.2-1.3), sessions with a known number of windows only:');
    const outcomeRow = (label: string, pick: (o: OutcomeSummary) => string | number): void => { lines.push(row(label, pick(outcome.packet), pick(outcome.control))); };
    outcomeRow('windows in a room (with a tool call)', (o) => o.windowsInRoom);
    outcomeRow('windows with a call error', (o) => o.errorWindows);
    outcomeRow('windows with an unknown outcome (call without a result)', (o) => o.unknownOutcomeWindows);
    outcomeRow('windows not finished at the cutoff', (o) => o.unfinishedWindows);
    outcomeRow('is_error results matching the list / all is_error results', (o) => `${o.callErrorResults}/${o.allErrorResults}`);
    lines.push('');
    const show = (decision: Decision): string =>
      decision.interval === null ? `no calculation: ${decision.reason}` : `R=${num(decision.interval.r)} [L=${num(decision.interval.lo)}, U=${num(decision.interval.hi)}]`;
    if (result.bounds === null) {
      lines.push(`VERDICT: undetermined (no calculation) - ${result.reasons.join('; ')}`);
    } else {
      for (const bound of ['favourable', 'unfavourable'] as Bound[]) {
        const decision = result.bounds[bound];
        lines.push(`  bound ${pad(bound, 12)} ${pad(decision.verdict, 13)} ${show(decision)}`);
      }
      lines.push(`VERDICT: ${result.verdict}${result.reasons.length > 0 ? ` - ${result.reasons.join('; ')}` : ''}`);
    }
    lines.push('Sensitivity checks (they do not change the verdict; sessions with an unknown number of windows are left out):');
    for (const check of result.sensitivity) {
      for (const bound of ['favourable', 'unfavourable'] as Bound[]) {
        const decision = check.bounds[bound];
        lines.push(`  ${pad(check.name.slice(0, 54), 55)} ${pad(bound, 12)} ${pad(decision.verdict, 13)} ${show(decision)}`);
      }
    }
    const substitution = medianSubstitution(cohort.sessions, options.seed, options.resamples);
    lines.push(`Median substitution (${substitution.substituted} session(s) with an unknown number of windows get the arm median, packet ${substitution.medians.packet}, control ${substitution.medians.control}):`);
    for (const bound of ['favourable', 'unfavourable'] as Bound[]) {
      const decision = substitution.bounds[bound];
      lines.push(`  ${pad('', 55)} ${pad(bound, 12)} ${pad(decision.verdict, 13)} ${show(decision)}`);
    }
    json['outcome'] = outcome;
    json['verdict'] = result.verdict;
    json['verdictReasons'] = result.reasons;
    json['bounds'] = result.bounds === null ? null : { favourable: decisionJson(result.bounds.favourable), unfavourable: decisionJson(result.bounds.unfavourable) };
    json['sensitivity'] = result.sensitivity.map((check) => ({
      name: check.name,
      note: check.note,
      favourable: decisionJson(check.bounds.favourable),
      unfavourable: decisionJson(check.bounds.unfavourable),
    }));
    json['medianSubstitution'] = {
      substitutedSessions: substitution.substituted,
      medians: substitution.medians,
      favourable: decisionJson(substitution.bounds.favourable),
      unfavourable: decisionJson(substitution.bounds.unfavourable),
    };
  }
  return { json, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------

const HELP = `Usage:
  pnpm exec tsx tools/room-packet-trial.ts --status --trial <name> [--cutoff <ISO time>] [options]
  pnpm exec tsx tools/room-packet-trial.ts --final  --trial <name> --cutoff <ISO time> [options]

  --trial <name>          name of the experiment (roomPacketTrial); only sessions with this name are counted
  --cutoff <ISO time>     freeze or stop moment; required for --final; records at or after it are not read
  --home <dir>            Parley home to snapshot (default: the real home of this machine)
  --claude-root <dir>     transcript root, repeatable (default: the roots Parley itself searches)
  --claude-settings <f>   Claude Code settings.json for cleanupPeriodDays (default: ~/.claude/settings.json)
  --out <file>            JSON result (default: ./room-packet-trial-<name>-<mode>.json)
  --seed <n>              bootstrap seed (default ${DEFAULT_SEED}); --resamples <n> (default ${DEFAULT_RESAMPLES})

Nothing is written to the Parley home or to the transcript roots. Only counts and session ids are printed.`;

export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options | { help: true } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      status: { type: 'boolean' },
      final: { type: 'boolean' },
      trial: { type: 'string' },
      cutoff: { type: 'string' },
      home: { type: 'string' },
      'claude-root': { type: 'string', multiple: true },
      'claude-settings': { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string' },
      resamples: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  if (values.help === true) return { help: true };
  if ((values.status === true) === (values.final === true)) throw new Error('give exactly one of --status and --final');
  const mode = values.final === true ? 'final' : 'status';
  const trial = values.trial;
  if (trial === undefined || !/^[a-z0-9-]{1,32}$/.test(trial)) throw new Error('--trial must be an experiment name: lowercase letters, digits and dashes, up to 32 characters');
  let cutoff: string | null = null;
  if (values.cutoff !== undefined) {
    if (Number.isNaN(Date.parse(values.cutoff))) throw new Error('--cutoff is not a time');
    cutoff = new Date(values.cutoff).toISOString();
  }
  if (mode === 'final' && cutoff === null) throw new Error('--final needs --cutoff');
  const userHome = homedir();
  const home = path.resolve(values.home ?? parleyHome(env, userHome));
  const roots = values['claude-root'];
  const claudeRoots = roots !== undefined && roots.length > 0 ? roots.map((root) => path.resolve(root)) : claudeProjectRoots(env, userHome);
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim();
  const claudeSettings = path.resolve(values['claude-settings'] ?? path.join(configDir !== undefined && configDir !== '' ? configDir : path.join(userHome, '.claude'), 'settings.json'));
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  const resamples = values.resamples === undefined ? DEFAULT_RESAMPLES : Number(values.resamples);
  if (!Number.isInteger(seed) || !Number.isInteger(resamples) || resamples < 1) throw new Error('--seed and --resamples must be integers');
  return { mode, trial, cutoff, home, claudeRoots, claudeSettings, out: values.out ?? null, seed, resamples };
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export interface Io { write: (text: string) => void }

/** Entry point; returns the exit code. */
export async function main(argv: readonly string[], io: Io = { write: (text) => process.stdout.write(text) }): Promise<number> {
  let options: Options | { help: true };
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.write(`room-packet-trial: ${(error as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if ('help' in options) {
    io.write(`${HELP}\n`);
    return 0;
  }
  const out = path.resolve(options.out ?? `room-packet-trial-${options.trial}-${options.mode}.json`);
  for (const protectedDir of [options.home, ...options.claudeRoots]) {
    if (inside(out, protectedDir)) {
      io.write(`room-packet-trial: --out ${out} is inside ${protectedDir}, which is read-only for this script\n`);
      return 2;
    }
  }
  try {
    const cohort = await collectCohort(options);
    const report = buildReport(options, cohort, readRetention(options.claudeSettings));
    io.write(`${report.lines.join('\n')}\n`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report.json, null, 2)}\n`);
    io.write(`\nJSON: ${out}\n`);
    return 0;
  } catch (error) {
    io.write(`room-packet-trial: ${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
