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

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-opencode-events-'));
  records = [];
  hooks = [];
  tuiAlive = true;
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
    const url = await startServer({ STUB_OPENCODE_SSE_REPLAY: '1' });
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
});
