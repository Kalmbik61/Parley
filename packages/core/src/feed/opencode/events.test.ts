import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyOpencodeBridgeState, mapOpencodeEvent, type OpencodeBridgeState, type OpencodeJournalRecord, type OpencodeUsageFact } from './events.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const lines = (name: string): unknown[] => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
const SID = 'ses_demo00000001';

function run(events: unknown[]): { records: OpencodeJournalRecord[]; usage: OpencodeUsageFact[]; state: OpencodeBridgeState } {
  let state = emptyOpencodeBridgeState();
  const records: OpencodeJournalRecord[] = [];
  const usage: OpencodeUsageFact[] = [];
  for (const event of events) {
    const mapped = mapOpencodeEvent(event, SID, state);
    state = mapped.state;
    records.push(...mapped.records);
    if (mapped.usage !== null) usage.push(mapped.usage);
  }
  return { records, usage, state };
}

describe('opencode events: turn fixture', () => {
  const { records, usage, state } = run(lines('events-turn.jsonl'));

  it('maps the lifecycle to hook records', () => {
    expect(records.map((r) => r.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(records[0]).toMatchObject({ session_id: SID, source: 'startup', timestamp: '2026-11-12T10:08:39.052Z' });
    expect(records[1]).toMatchObject({ prompt: 'MCPCALL please' });
  });

  it('names the tool from input.started and gives a short detail', () => {
    expect(records[2]).toMatchObject({ tool_name: 'execute', tool_use_id: 'call_1', detail: 'parley.ping' });
    expect(records[3]).toMatchObject({ tool_name: 'execute', tool_use_id: 'call_1' });
    expect(state.toolNames).toEqual({});
  });

  it('gives usage as a fact, not a record', () => {
    expect(usage).toEqual([
      { sessionId: SID, at: '2026-11-12T10:09:24.100Z', inputTokens: 11, outputTokens: 7, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
    ]);
  });
});

describe('opencode events: more fixture', () => {
  const { records } = run(lines('events-more.jsonl'));

  it('maps permission, failure (also a throwing execute that reports success) and stops; ignores other sessions and non-user inbox items', () => {
    expect(records.map((r) => r.hook_event_name)).toEqual(['Notification', 'PostToolUseFailure', 'PostToolUseFailure', 'Stop', 'StopFailure']);
    expect(records[0]).toMatchObject({ notification_type: 'permission_prompt', message: 'shell' });
    expect(records[1]).toMatchObject({ tool_name: 'write', error: 'Invalid arguments for tool write' });
    expect(records[2]).toMatchObject({ tool_name: 'execute', tool_use_id: 'call_5', error: 'Error: boom from execute' });
    expect(records[3]).toMatchObject({ interrupted: true, reason: 'shutdown' });
    expect(records[4]).toMatchObject({ error: 'provider.invalid-request', error_details: 'mock model failure' });
  });
});

describe('opencode events: robustness', () => {
  it.each([null, 'x', {}, { type: 'session.created' }, { type: 'session.created', created: 'x', data: { sessionID: SID } }])('ignores %j', (raw) => {
    expect(mapOpencodeEvent(raw, SID, emptyOpencodeBridgeState()).records).toEqual([]);
  });
  it('is pure: the same event twice gives equal results and the input state is untouched', () => {
    const state = emptyOpencodeBridgeState();
    const ev = lines('events-turn.jsonl')[5];
    expect(mapOpencodeEvent(ev, SID, state)).toEqual(mapOpencodeEvent(ev, SID, state));
    expect(state.toolNames).toEqual({});
  });
});

describe('opencode events: recording of the mock lab', () => {
  const recorded = readFileSync(join(dir, 'lab-events.sse.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as unknown);
  const runFor = (id: string): ReturnType<typeof run> => {
    let state = emptyOpencodeBridgeState();
    const records: OpencodeJournalRecord[] = [];
    const usage: OpencodeUsageFact[] = [];
    for (const event of recorded) {
      const mapped = mapOpencodeEvent(event, id, state);
      state = mapped.state;
      records.push(...mapped.records);
      if (mapped.usage !== null) usage.push(mapped.usage);
    }
    return { records, usage, state };
  };

  it('maps the full turn: start, prompt, tools with names, permission, stop; usage as facts', () => {
    const { records, usage, state } = runFor('ses_labfull0001');
    const names = records.map((r) => r.hook_event_name);
    expect(names[0]).toBe('SessionStart');
    expect(names[1]).toBe('UserPromptSubmit');
    expect(names.at(-1)).toBe('Stop');
    expect(names).toContain('Notification');
    expect(records.filter((r) => r.hook_event_name === 'PreToolUse').map((r) => r.tool_name)).toEqual(['shell', 'execute']);
    expect(records.filter((r) => r.hook_event_name === 'PostToolUse').every((r) => r.tool_name !== undefined && r.tool_name !== 'tool')).toBe(true);
    expect(usage.length).toBeGreaterThan(0);
    expect(state.toolNames).toEqual({});
  });

  it('maps the failed path to StopFailure', () => {
    const failed = recorded.flatMap((e) => (e as { data?: { sessionID?: string } }).data?.sessionID ?? []).filter((id, i, all) => all.indexOf(id) === i && id.startsWith('ses_labfail'));
    const all = failed.flatMap((id) => runFor(id).records);
    expect(all.filter((r) => r.hook_event_name === 'StopFailure')).toEqual([
      expect.objectContaining({ error: 'provider.invalid-request', error_details: 'mock model failure' }),
    ]);
  });
});
