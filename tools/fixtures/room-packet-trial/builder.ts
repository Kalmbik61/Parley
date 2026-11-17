/**
 * Builders of synthetic fixtures for `tools/room-packet-trial.test.ts`: Claude Code transcripts (record shapes as in the real
 * ones, invented texts), hook journals and a Parley home made with core's own store. Nothing here is taken from a real
 * transcript or a real home.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addSession } from '../../../packages/core/src/work/map.js';
import { addRoom, deleteRoom } from '../../../packages/core/src/work/rooms.js';
import { removeSession } from '../../../packages/core/src/work/map.js';
import { appendTrialLedger, trialLedgerFile } from '../../../packages/core/src/work/trial-ledger.js';
import { closeWorkDb } from '../../../packages/core/src/work/db.js';
import { createWork, updateMap, workPaths } from '../../../packages/core/src/work/store.js';
import type { AgentBinding, SessionTrial, TrialTrace, WorkSession } from '../../../packages/core/src/work/types.js';

export const CALL_ERROR_TEXT = 'InputValidationError: field "path" is required and must be a string';

export const PACKET_PREFIX = 'Room state packet ';

export interface CallOptions {
  /** `ok` (default), `error` (is_error with a listed phrase), `other-error` (is_error, unlisted text), `plain` (no is_error but a listed phrase), `none` (no result). */
  result?: 'ok' | 'error' | 'other-error' | 'plain' | 'none';
  usage?: boolean;
  sidechain?: boolean;
  /** Message id; default a fresh one per call. */
  messageId?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Writes a transcript line by line, with a clock that moves one second per record. */
export class TranscriptBuilder {
  readonly lines: string[] = [];
  private tick = 0;
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly start: string,
    private readonly prefix = sessionId,
  ) {}

  time(): string {
    return new Date(Date.parse(this.start) + this.tick * 1000).toISOString();
  }

  private uuid(): string {
    this.seq += 1;
    return `${this.prefix}-u${String(this.seq).padStart(5, '0')}`;
  }

  push(record: Record<string, unknown>, atSecond?: number): this {
    if (atSecond !== undefined) this.tick = atSecond;
    else this.tick += 1;
    this.lines.push(
      JSON.stringify({ uuid: this.uuid(), timestamp: this.time(), sessionId: this.sessionId, isSidechain: false, ...record }),
    );
    return this;
  }

  /** Jumps the clock to `second` seconds after the start. */
  at(second: number): this {
    this.tick = second;
    return this;
  }

  prompt(text = 'fixture prompt'): this {
    return this.push({ type: 'user', message: { role: 'user', content: text } });
  }

  boundary(): this {
    return this.push({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 },
    });
  }

  /** Hook insert after a boundary; the packet text is exactly `bytes` bytes long. */
  packet(bytes = 900): this {
    const text = PACKET_PREFIX + 'x'.repeat(Math.max(0, bytes - PACKET_PREFIX.length));
    return this.push({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: [text, 'other hook text'] },
    });
  }

  /** A hook insert of another hook, without a packet. */
  otherHook(): this {
    return this.push({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: ['invented session note'] },
    });
  }

  hookCancelled(): this {
    return this.push({ type: 'attachment', attachment: { type: 'hook_cancelled', hookName: 'SessionStart:compact', hookEvent: 'SessionStart' } });
  }

  /** A model message with text only (a model call without tool calls). */
  model(options: { usage?: boolean; messageId?: string; sidechain?: boolean } = {}): this {
    return this.push({
      type: 'assistant',
      isSidechain: options.sidechain === true,
      message: {
        id: options.messageId ?? `msg_${this.prefix}_${this.seq + 1}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'invented answer' }],
        ...(options.usage === false ? {} : { usage: { input_tokens: 10, output_tokens: 5 } }),
      },
    });
  }

  /** One tool call and, unless `result: 'none'`, its result. Returns the builder; the call id is `toolu_<n>`. */
  call(options: CallOptions = {}): this {
    const id = `toolu_${this.prefix}_${this.seq + 1}`;
    this.push({
      type: 'assistant',
      isSidechain: options.sidechain === true,
      message: {
        id: options.messageId ?? `msg_${this.prefix}_${this.seq + 1}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: options.name ?? 'Read', input: options.input ?? { path: 'invented.txt' } }],
        ...(options.usage === false ? {} : { usage: { input_tokens: 10, output_tokens: 5 } }),
      },
    });
    const result = options.result ?? 'ok';
    if (result === 'none') return this;
    const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id };
    if (result === 'ok') block['content'] = 'invented file text';
    if (result === 'error') {
      block['is_error'] = true;
      block['content'] = [{ type: 'text', text: CALL_ERROR_TEXT }];
    }
    if (result === 'other-error') {
      block['is_error'] = true;
      block['content'] = 'invented failure of another kind';
    }
    if (result === 'plain') block['content'] = CALL_ERROR_TEXT;
    return this.push({ type: 'user', isSidechain: options.sidechain === true, message: { role: 'user', content: [block] } });
  }

  calls(count: number, options: CallOptions = {}): this {
    for (let i = 0; i < count; i += 1) this.call(options);
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }

  /** The same text with its last record cut in half (a transcript torn mid-record). */
  tornText(): string {
    const full = this.lines.join('\n');
    return full.slice(0, full.length - 25);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------

export interface RoomSpec {
  /** Index of the session in `sessions` plus its stay. */
  members: Array<{ session: number; from: string; to?: string | null }>;
  /** false: a room made before the membership journal (membership is rebuilt, approximate). */
  journal?: boolean;
  createdAt?: string;
}

export interface SessionSpec {
  /** 'packet' | 'control' | 'damaged' | null (no trial record). */
  arm: 'packet' | 'control' | 'damaged' | null;
  trialName?: string;
  assignedAt?: string;
  /** Current Claude id; null — never launched. */
  claudeId?: string | null;
  provider?: string;
  previous?: Array<{ provider: string; id: string | null; startedAt?: string | null }>;
  /** Pad `previousAgents` to this many entries with other-provider segments. */
  previousPad?: number;
  closedAt?: string | null;
  result?: boolean;
}

export interface HomeSpec {
  /** Root of the fixture tree: `home/`, `project/`, `claude/` are made inside. */
  root: string;
  sessions: SessionSpec[];
  rooms: RoomSpec[];
  /** Assignment list: `auto` (default) writes an intent and a confirm line per assigned session; `none` writes no file; `directory` puts a directory where the file should be. */
  ledger?: 'auto' | 'none' | 'directory';
  /** Sessions (by index) with no intent line in the list. */
  ledgerSkip?: number[];
  /** Sessions whose intent line names the other arm. */
  ledgerOtherArm?: number[];
  /** Sessions whose intent line carries another time of assignment, or another experiment name. */
  ledgerOtherTime?: number[];
  ledgerOtherName?: number[];
  /** Sessions whose tag the list calls cancelled. */
  ledgerCancelled?: number[];
  /** Sessions with an intent but no confirm line. */
  ledgerUnconfirmed?: number[];
  /** Intents of sessions that never reached a map: lost sessions; `confirm` adds a confirm line naming a work and a session. */
  lostIntents?: Array<{ arm: 'packet' | 'control'; at?: string; name?: string; confirm?: { workId: string; sessionId: string } }>;
  /** The tag of a session (by index) found again: in a second work, or in the trace of a deleted session, optionally with another arm or time. */
  duplicates?: Array<{ session: number; as: 'other-work' | 'trace'; arm?: 'packet' | 'control'; at?: string }>;
  /** Raw text appended to the list file (garbage, a torn line). */
  ledgerRaw?: string;
  /** Rooms (by index in `rooms`) and sessions (by index) deleted after creation through core's own functions. */
  deleteRooms?: number[];
  deleteSessions?: number[];
  /** Delete sessions first, rooms after (default: rooms first). */
  sessionsFirst?: boolean;
  /** Put a damaged record into the trial trace. */
  traceDamage?: boolean;
}

/** Time of every deletion in the fixtures: after the fixture transcripts, so closed rows of deleted rooms stay ordered. */
export const DELETED_AT = '2026-11-22T00:00:00.000Z';

/** Deterministic assignment tag of the session at `index` (32 hex digits). */
export const tagOf = (index: number): string => (index + 1).toString(16).padStart(32, '0');
const lostTagOf = (index: number): string => `f${(index + 1).toString(16).padStart(31, '0')}`;

export interface BuiltHome {
  home: string;
  project: string;
  claudeRoot: string;
  workId: string;
  /** Session ids by index in `sessions`. */
  ids: string[];
  eventsDir: string;
}

const binding = (spec: { provider: string; id: string | null; startedAt?: string | null }): AgentBinding => ({
  provider: spec.provider,
  model: null,
  effort: null,
  providerSessionId: spec.id,
  startedAt: spec.startedAt === undefined ? '2026-11-20T10:00:00.000Z' : spec.startedAt,
  endedAt: '2026-11-20T11:00:00.000Z',
  reason: 'manual',
  requestedBy: 'human',
  carried: 'handover',
});

/** Makes a home with one work through core's store. The process must set `PARLEY_HOME` to `result.home` while this runs. */
export async function buildHome(spec: HomeSpec): Promise<BuiltHome> {
  const home = path.join(spec.root, 'home');
  const project = path.join(spec.root, 'project');
  const claudeRoot = path.join(spec.root, 'claude');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });
  const saved = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  try {
    const work = await createWork(project, { title: 'fixture work' });
    const ids: string[] = [];
    const roomIds: string[] = [];
    await updateMap(project, work.work.id, (map) => {
      for (const [index, entry] of spec.sessions.entries()) {
        const session: WorkSession = addSession(map, { provider: 'claude', label: `s${index}`, task: '', parent: null }, '2026-11-20T09:00:00.000Z');
        ids.push(session.id);
        session.provider = (entry.provider ?? 'claude') as WorkSession['provider'];
        session.providerSessionId = entry.claudeId ?? null;
        if (entry.closedAt !== undefined) session.closedAt = entry.closedAt;
        if (entry.result === true) {
          session.result = 'done' as WorkSession['result'];
          session.resultAt = '2026-11-20T12:00:00.000Z';
        }
        const previous = [...(entry.previous ?? []).map(binding)];
        for (let i = 0; i < (entry.previousPad ?? 0); i += 1) previous.push(binding({ provider: 'codex', id: `pad-${index}-${i}` }));
        if (previous.length > 0) session.previousAgents = previous;
        if (entry.arm === 'damaged') session.trial = { damaged: true };
        else if (entry.arm !== null) {
          const trial: SessionTrial = { name: entry.trialName ?? 'exp-a', arm: entry.arm, at: entry.assignedAt ?? '2026-11-20T09:00:00.000Z', tag: tagOf(index) };
          session.trial = trial;
        }
      }
      for (const roomSpec of spec.rooms) {
        const at = roomSpec.createdAt ?? '2026-11-20T09:00:00.000Z';
        const members = roomSpec.members.map((member) => ids[member.session]!);
        const room = addRoom(map, { title: 'fixture room', creator: 'human', members: [] }, at);
        roomIds.push(room.id);
        room.members = [...new Set(members)];
        room.lead = null;
        if (roomSpec.journal === false) delete room.memberLog;
        else room.memberLog = roomSpec.members.map((member) => ({ session: ids[member.session]!, from: member.from, to: member.to ?? null }));
      }
    });
    for (const [index, duplicate] of (spec.duplicates ?? []).entries()) {
      const source = spec.sessions[duplicate.session]!;
      const trial: SessionTrial = {
        name: source.trialName ?? 'exp-a',
        arm: duplicate.arm ?? (source.arm === 'control' ? 'control' : 'packet'),
        at: duplicate.at ?? source.assignedAt ?? '2026-11-20T09:00:00.000Z',
        tag: tagOf(duplicate.session),
      };
      if (duplicate.as === 'other-work') {
        const second = await createWork(project, { title: `second work ${index}` });
        await updateMap(project, second.work.id, (map) => {
          const copy = addSession(map, { provider: 'claude', label: 'dup', task: '', parent: null }, '2026-11-20T09:00:00.000Z');
          copy.trial = trial;
        });
      } else {
        await updateMap(project, work.work.id, (map) => {
          const trace: TrialTrace = map.work.trialTrace ?? { sessions: [], rooms: [], unknownParticipation: [] };
          trace.sessions.push({
            session: 's-90', trial, provider: 'claude', providerSessionId: null, startedAt: null, endedAt: null, closedAt: null, deletedAt: DELETED_AT,
          });
          map.work.trialTrace = trace;
        });
      }
    }
    if ((spec.deleteRooms?.length ?? 0) > 0 || (spec.deleteSessions?.length ?? 0) > 0 || spec.traceDamage === true) {
      await updateMap(project, work.work.id, (map, letters) => {
        const rooms = (): void => { for (const index of spec.deleteRooms ?? []) deleteRoom(map, letters, roomIds[index]!, DELETED_AT); };
        const sessions = (): void => { for (const index of spec.deleteSessions ?? []) removeSession(map, letters, ids[index]!, DELETED_AT); };
        if (spec.sessionsFirst === true) { sessions(); rooms(); } else { rooms(); sessions(); }
        if (spec.traceDamage === true) {
          const trace: TrialTrace = map.work.trialTrace ?? { sessions: [], rooms: [], unknownParticipation: [] };
          trace.sessions.push({ damaged: true });
          map.work.trialTrace = trace;
        }
      });
    }
    closeWorkDb();
    writeLedger(spec, home, project, work.work.id, ids);
    const eventsDir = workPaths(project, work.work.id).events;
    mkdirSync(eventsDir, { recursive: true });
    return { home, project, claudeRoot, workId: work.work.id, ids, eventsDir };
  } finally {
    closeWorkDb();
    if (saved === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = saved;
  }
}

/** Puts a transcript under `claude/<project slug>/<id>.jsonl`. */
export function writeTranscript(built: BuiltHome, id: string, text: string): string {
  const dir = path.join(built.claudeRoot, '-fixture-project');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, text);
  return file;
}

/** Appends hook-journal lines for a session. */
export function writeJournal(built: BuiltHome, sessionId: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(path.join(built.eventsDir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

/** The assignment list of the fixture home, written through core's own append function. */
function writeLedger(spec: HomeSpec, home: string, project: string, workId: string, ids: string[]): void {
  if (spec.ledger === 'none') return;
  const names = new Set(spec.sessions.flatMap((entry) => (entry.arm === null || entry.arm === 'damaged' ? [] : [entry.trialName ?? 'exp-a'])));
  if (spec.ledger === 'directory') {
    for (const name of names) mkdirSync(trialLedgerFile(name, home), { recursive: true });
    return;
  }
  const at = '2026-11-20T09:00:00.000Z';
  spec.sessions.forEach((entry, index) => {
    if (entry.arm === null || entry.arm === 'damaged' || spec.ledgerSkip?.includes(index) === true) return;
    const name = entry.trialName ?? 'exp-a';
    const arm = spec.ledgerOtherArm?.includes(index) === true ? (entry.arm === 'packet' ? 'control' : 'packet') : entry.arm;
    const intentName = spec.ledgerOtherName?.includes(index) === true ? 'exp-other' : name;
    const intentAt = spec.ledgerOtherTime?.includes(index) === true ? '2026-11-19T09:00:00.000Z' : (entry.assignedAt ?? at);
    appendTrialLedger(name, { kind: 'intent', tag: tagOf(index), name: intentName, arm, at: intentAt }, home);
    if (spec.ledgerCancelled?.includes(index) === true) appendTrialLedger(name, { kind: 'cancel', tag: tagOf(index), at }, home);
    else if (spec.ledgerUnconfirmed?.includes(index) !== true) {
      appendTrialLedger(name, { kind: 'confirm', tag: tagOf(index), projectPath: project, workId, incarnation: 1, sessionId: ids[index]!, at }, home);
    }
  });
  (spec.lostIntents ?? []).forEach((lost, index) => {
    appendTrialLedger('exp-a', { kind: 'intent', tag: lostTagOf(index), name: lost.name ?? 'exp-a', arm: lost.arm, at: lost.at ?? at }, home);
    if (lost.confirm !== undefined) {
      appendTrialLedger('exp-a', { kind: 'confirm', tag: lostTagOf(index), projectPath: project, workId: lost.confirm.workId, incarnation: 1, sessionId: lost.confirm.sessionId, at }, home);
    }
  });
  if (spec.ledgerRaw !== undefined) appendFileSync(trialLedgerFile('exp-a', home), spec.ledgerRaw);
}
