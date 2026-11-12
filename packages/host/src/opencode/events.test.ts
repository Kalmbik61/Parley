import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityOf, eventRecordOf, type EventRecord, type OpencodeJournalRecord } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HookRequest } from '../hooks/hook-server.js';
import { createOpencodeBridge, parleyMcpStatus, type OpencodeBridge } from './events.js';

const STUB = fileURLToPath(new URL('../../test/stub-opencode.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../core/src/feed/opencode/__fixtures__/', import.meta.url));
const SES = 'ses_demo00000001';
const PASSWORD = 'bridge-test-password';
const ref: SessionRef = { projectPath: '/project', workId: 'w-0001', sessionId: 's-01' };
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let server: ChildProcess | undefined;
let bridge: OpencodeBridge | undefined;
let records: OpencodeJournalRecord[];
let hooks: Array<Record<string, unknown>>;
let tuiAlive: boolean;
let polls: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-opencode-events-'));
  records = [];
  hooks = [];
  tuiAlive = true;
  polls = 0;
});

afterEach(async () => {
  bridge?.stopAll();
  bridge = undefined;
  if (server?.pid !== undefined) {
    try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const eventsFile = (): string => path.join(dir, 'events.jsonl');
const mcpFile = (): string => path.join(dir, 'mcp.txt');

async function startServer(env: Record<string, string> = {}): Promise<string> {
  await writeFile(eventsFile(), '');
  server = spawn(process.execPath, [STUB, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    env: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: PASSWORD, STUB_OPENCODE_EVENTS_FILE: eventsFile(), ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve) => {
    let out = '';
    server!.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(out)?.[0];
      if (url !== undefined) resolve(url);
    });
  });
}

function attach(url: string, source: 'startup' | 'resume' = 'startup'): OpencodeBridge {
  bridge = createOpencodeBridge({
    log: silent,
    hook: (request: HookRequest) => hooks.push(request.body),
    journal: async (_ref, record) => { records.push(record); },
    onSessionEvent: () => { polls += 1; },
    backoffInitialMs: 50,
    backoffMaxMs: 200,
    mcpPollMs: 50,
  });
  bridge.attach(ref, { url, password: PASSWORD, sessionId: SES, tuiAlive: () => tuiAlive, source });
  return bridge;
}

async function lines(name: string): Promise<string[]> {
  return (await readFile(path.join(FIXTURES, name), 'utf8')).split('\n').filter((line) => line.trim() !== '');
}
const push = (events: string[]): Promise<void> => appendFile(eventsFile(), events.map((line) => `${line}\n`).join(''));

/** The activity after each journal record, consecutive repeats folded: what the session list shows over the turn. */
function sequence(events: EventRecord[], now: number): string[] {
  const out: string[] = [];
  for (let index = 1; index <= events.length; index += 1) {
    const state = activityOf({ events: events.slice(0, index), now }).activity;
    if (out.at(-1) !== state) out.push(state);
  }
  return out;
}

const opencodeRecords = (): EventRecord[] => records.map((record) => eventRecordOf(record, record.timestamp, 'opencode')!);

describe('OpenCode event bridge (O6)', () => {
  it('parleyMcpStatus reads the 2.2.7 shape of GET /api/mcp', () => {
    expect(parleyMcpStatus({ data: [{ name: 'broken', status: { status: 'failed' } }, { name: 'parley', status: { status: 'connected' } }] })).toBe('connected');
    expect(parleyMcpStatus({ data: [] })).toBeNull();
    expect(parleyMcpStatus({})).toBeNull();
  });

  it('1. a turn gives the same activity sequence as a Qwen turn; every record also goes through the hook chain', async () => {
    const url = await startServer();
    attach(url);
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    await push(await lines('events-turn.jsonl'));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('Stop'));
    expect(records.map((record) => record.hook_event_name)).toEqual(['SessionStart', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(records[3]).toMatchObject({ tool_name: 'execute', detail: 'parley.ping' });
    expect(hooks).toEqual(records);
    // Every event of the session (11 of the 12 fixture lines; `mcp.status.changed` has no session) polls the feed early.
    expect(polls).toBe(11);

    const now = Date.parse(records.at(-1)!.timestamp) + 1000;
    const qwen = [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'MCPCALL please' },
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__parley__ping' },
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__parley__ping' },
      { hook_event_name: 'Stop' },
    ].map((body, index) => eventRecordOf(body, new Date(now - 5000 + index * 100).toISOString(), 'qwen')!);
    const expected = sequence(qwen, now);
    expect(expected).toEqual(['idle', 'working', 'unseen']);
    expect(sequence(opencodeRecords(), now)).toEqual(expected);
  });

  it('2. a permission ask makes the session blocked; the next tool event clears it', async () => {
    const url = await startServer();
    attach(url);
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    const turn = await lines('events-turn.jsonl');
    const more = await lines('events-more.jsonl');
    // The prompt, then the ask.
    await push([turn[2]!, more[0]!]);
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('Notification'));
    const now = Date.parse(records.at(-1)!.timestamp) + 1000;
    expect(activityOf({ events: opencodeRecords(), now })).toMatchObject({ activity: 'blocked', need: { kind: 'approval' } });
    // Answered (declined): the tool fails and the agent goes on.
    await push([more[2]!, more[3]!]);
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('PostToolUseFailure'));
    expect(activityOf({ events: opencodeRecords(), now: now + 60_000 })).toMatchObject({ activity: 'working', need: null });
  });

  it('3. a dropped stream reconnects and a server that replays gives no duplicate records', async () => {
    // The turn is still running on the server, so the reconnect catch-up writes nothing.
    const active = path.join(dir, 'active.txt');
    await writeFile(active, `${SES}\n`);
    const url = await startServer({ STUB_OPENCODE_SSE_REPLAY: '1', STUB_OPENCODE_ACTIVE_FILE: active });
    attach(url);
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    const turn = await lines('events-turn.jsonl');
    await push(turn.slice(0, 7));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('PreToolUse'));
    expect(bridge!.connections(ref)).toBe(1);
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(bridge!.connections(ref)).toBe(2), { timeout: 5000 });
    await push(turn.slice(7));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('Stop'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(records.map((record) => record.hook_event_name)).toEqual(['SessionStart', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(hooks).toHaveLength(records.length);
  });

  it('3b. a refused connection is retried with backoff until the server answers; detach stops it', async () => {
    const calls: number[] = [];
    let open = false;
    const url = await startServer();
    bridge = createOpencodeBridge({
      log: silent,
      hook: () => {},
      journal: async (_ref, record) => { records.push(record); },
      backoffInitialMs: 20,
      backoffMaxMs: 80,
      mcpPollMs: 50,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/api/event')) {
          calls.push(Date.now());
          if (!open) throw new TypeError('fetch failed');
        }
        return fetch(input, init);
      },
    });
    bridge.attach(ref, { url, password: PASSWORD, sessionId: SES, tuiAlive: () => true, source: 'startup' });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    const gaps = calls.slice(1).map((at, index) => at - calls[index]!);
    expect(Math.max(...gaps)).toBeLessThan(400);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(60);
    open = true;
    await vi.waitFor(() => expect(bridge!.connections(ref)).toBe(1));
    bridge.detach(ref);
    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.length).toBe(after);
  });

  it('4. readiness waits for the parley MCP connection and a live TUI; earlier records follow the readiness SessionStart', async () => {
    const url = await startServer({ STUB_OPENCODE_MCP_FILE: mcpFile() });
    attach(url, 'resume');
    const turn = await lines('events-turn.jsonl');
    // session.created and a prompt while the MCP server is still connecting.
    await push([turn[0]!, turn[2]!]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bridge!.ready(ref)).toBe(false);
    expect(records).toEqual([]);
    // Connected, but the TUI is gone: still not ready.
    tuiAlive = false;
    await writeFile(mcpFile(), 'connected');
    await push([turn[1]!]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridge!.ready(ref)).toBe(false);
    tuiAlive = true;
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[0]).toMatchObject({ hook_event_name: 'SessionStart', source: 'resume', session_id: SES });
    expect(records[1]).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'MCPCALL please' });
  });

  it('4b. a failed parley MCP server keeps the session not ready', async () => {
    await writeFile(mcpFile(), 'failed');
    const url = await startServer({ STUB_OPENCODE_MCP_FILE: mcpFile() });
    attach(url);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bridge!.ready(ref)).toBe(false);
    expect(records).toEqual([]);
  });

  it('O6b. a dropped stream that lost the turn end: after the reconnect the session ends idle (catch-up Stop)', async () => {
    const active = path.join(dir, 'active.txt');
    await writeFile(active, `${SES}\n`);
    const url = await startServer({ STUB_OPENCODE_ACTIVE_FILE: active });
    attach(url);
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    const turn = await lines('events-turn.jsonl');
    await push(turn.slice(0, 7));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('PreToolUse'));
    // The turn ends while the stream is down: its events are lost, the server is idle again.
    await writeFile(active, '');
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('Stop'), { timeout: 5000 });
    expect(records.at(-1)).toMatchObject({ hook_event_name: 'Stop', source: 'reconnect-catch-up', session_id: SES });
    const now = Date.parse(records.at(-1)!.timestamp) + 1000;
    expect(activityOf({ events: opencodeRecords(), now, seen: true }).activity).toBe('idle');
    expect(hooks.at(-1)).toEqual(records.at(-1));
  });

  it('O6b. a reconnect while the turn still runs writes nothing; a pending permission request becomes the blocked Notification', async () => {
    const active = path.join(dir, 'active.txt');
    const permissions = path.join(dir, 'permissions.json');
    await writeFile(active, `${SES}\n`);
    const url = await startServer({ STUB_OPENCODE_ACTIVE_FILE: active, STUB_OPENCODE_PERMISSIONS_FILE: permissions });
    attach(url);
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    const turn = await lines('events-turn.jsonl');
    await push(turn.slice(0, 7));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('PreToolUse'));
    const count = records.length;
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(bridge!.connections(ref)).toBe(2), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(records).toHaveLength(count);
    await writeFile(permissions, JSON.stringify([{ id: 'per_demo1', sessionID: SES, action: 'shell', resources: ['echo hi'] }]));
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('Notification'), { timeout: 5000 });
    expect(records.at(-1)).toMatchObject({ notification_type: 'permission_prompt', tool_name: 'shell', source: 'reconnect-catch-up' });
    const now = Date.parse(records.at(-1)!.timestamp) + 1000;
    expect(activityOf({ events: opencodeRecords(), now })).toMatchObject({ activity: 'blocked', need: { kind: 'approval' } });
    // Still waiting at the next reconnect: no second Notification.
    const waiting = records.length;
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(bridge!.connections(ref)).toBe(4), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(records).toHaveLength(waiting);
  });

  it('O6b. a catch-up whose snapshot went stale writes nothing: inactive at the snapshot, then a new prompt before the GETs resolve', async () => {
    const url = await startServer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let snapshots = 0;
    bridge = createOpencodeBridge({
      log: silent,
      hook: (request: HookRequest) => hooks.push(request.body),
      journal: async (_ref, record) => { records.push(record); },
      backoffInitialMs: 50,
      backoffMaxMs: 200,
      mcpPollMs: 50,
      // The server answers "not running" (no active file), but only after the gate opens.
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/api/session/active')) {
          snapshots += 1;
          const answer = await fetch(input, init);
          await gate;
          return answer;
        }
        return fetch(input, init);
      },
    });
    bridge.attach(ref, { url, password: PASSWORD, sessionId: SES, tuiAlive: () => true, source: 'startup' });
    await vi.waitFor(() => expect(bridge!.ready(ref)).toBe(true));
    const turn = await lines('events-turn.jsonl');
    await push(turn.slice(0, 7));
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('PreToolUse'));
    await push(['{"stub":"drop"}']);
    await vi.waitFor(() => expect(snapshots).toBe(1), { timeout: 5000 });
    // A new turn's prompt arrives on the new connection while the catch-up still waits for its answer.
    const enqueued = JSON.parse(turn[2]!) as { id: string; created: number };
    await push([JSON.stringify({ ...enqueued, id: 'evt_demo_new01', created: enqueued.created + 60_000 })]);
    await vi.waitFor(() => expect(records.at(-1)?.hook_event_name).toBe('UserPromptSubmit'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(records.at(-1)?.hook_event_name).toBe('UserPromptSubmit');
    expect(records.some((record) => record.source === 'reconnect-catch-up')).toBe(false);
  });
});
