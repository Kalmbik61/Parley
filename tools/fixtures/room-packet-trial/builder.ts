/**
 * Builders of synthetic fixtures for `tools/room-packet-trial.test.ts`: Claude Code transcripts (record shapes as in the real
 * ones, invented texts), hook journals and a Parley home made with core's own store. Nothing here is taken from a real
 * transcript or a real home.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addSession } from '../../../packages/core/src/work/map.js';
import { addRoom } from '../../../packages/core/src/work/rooms.js';
import { closeWorkDb } from '../../../packages/core/src/work/db.js';
import { createWork, updateMap, workPaths } from '../../../packages/core/src/work/store.js';
import type { AgentBinding, SessionTrial, WorkSession } from '../../../packages/core/src/work/types.js';

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
}

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
          const trial: SessionTrial = { name: entry.trialName ?? 'exp-a', arm: entry.arm, at: entry.assignedAt ?? '2026-11-20T09:00:00.000Z' };
          session.trial = trial;
        }
      }
      for (const roomSpec of spec.rooms) {
        const at = roomSpec.createdAt ?? '2026-11-20T09:00:00.000Z';
        const members = roomSpec.members.map((member) => ids[member.session]!);
        const room = addRoom(map, { title: 'fixture room', creator: 'human', members: [] }, at);
        room.members = [...new Set(members)];
        room.lead = null;
        if (roomSpec.journal === false) delete room.memberLog;
        else room.memberLog = roomSpec.members.map((member) => ({ session: ids[member.session]!, from: member.from, to: member.to ?? null }));
      }
    });
    closeWorkDb();
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
