import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterV1 } from '../adapter-v1.js';
import { indexCodexSession } from '../codex/index-session.js';
import { indexSessionFile } from '../session-index.js';
import { createUsageLedger, type UsageObservation } from './usage-ledger.js';
import {
  claudeUsageObservation,
  codexUsageObservation,
  noteClaudeSidechain,
  replayClaudeUsage,
  type ClaudeSidechain,
} from './usage-observations.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-usage-obs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const assistant = (extra: Record<string, unknown>, id: string | null, at: string, usage: Record<string, number> | null) => ({
  type: 'assistant',
  sessionId: 's1',
  timestamp: at,
  ...extra,
  message: { role: 'assistant', ...(id === null ? {} : { id }), content: [{ type: 'text', text: 'ok' }], ...(usage === null ? {} : { usage }) },
});
const u = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

/** Читает файл Claude так же, как индексатор: наблюдения и sidechain. */
async function collect(file: string, records: Array<Record<string, unknown>>): Promise<{ observations: UsageObservation[]; sidechain: ClaudeSidechain }> {
  const observations: UsageObservation[] = [];
  const sidechain: ClaudeSidechain = { agents: new Set(), unidentified: false };
  records.forEach((raw, i) => {
    const record = adapterV1.toSessionRecord(raw);
    const observation = claudeUsageObservation(record, file, i + 1);
    if (observation !== null) {
      observations.push(observation);
      noteClaudeSidechain(sidechain, record);
    }
  });
  return { observations, sidechain };
}

describe('claudeUsageObservation', () => {
  const records = [
    { type: 'user', sessionId: 's1', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hi', usage: u(9, 9) } },
    assistant({}, 'm1', '2026-10-01T10:00:01.000Z', u(10, 1)),
    assistant({}, 'm1', '2026-10-01T10:00:02.000Z', u(10, 1)),
    assistant({}, null, '2026-10-01T10:00:03.000Z', u(20, 2)),
    assistant({}, 'm3', '2026-10-01T10:00:04.000Z', null),
  ];

  it('только assistant с usage; id — msg:<id> или line:<файл>:<строка>', () => {
    const out = records.map((raw, i) => claudeUsageObservation(adapterV1.toSessionRecord(raw), '/f.jsonl', i + 1));
    expect(out[0]).toBeNull();
    expect(out[4]).toBeNull();
    expect(out[1]).toEqual({
      kind: 'delta',
      id: 'msg:m1',
      counters: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalInput: 10 },
      at: '2026-10-01T10:00:01.000Z',
    });
    expect(out[2]).toMatchObject({ id: 'msg:m1' });
    expect(out[3]).toMatchObject({ id: 'line:/f.jsonl:4', counters: { input: 20, output: 2 } });
  });
});

describe('noteClaudeSidechain', () => {
  it('копит агентов и запись без id ответа только по учитываемым записям', () => {
    const state: ClaudeSidechain = { agents: new Set(), unidentified: false };
    noteClaudeSidechain(state, adapterV1.toSessionRecord(assistant({ isSidechain: true, agentId: 'a1' }, 'm1', '2026-10-01T10:00:00.000Z', u(1, 1))));
    expect(state).toEqual({ agents: new Set(['a1']), unidentified: false });
    // Без usage — не учитывается, состояние не меняется.
    noteClaudeSidechain(state, adapterV1.toSessionRecord(assistant({ isSidechain: true, agentId: 'a2' }, null, '2026-10-01T10:00:00.000Z', null)));
    expect(state.agents.has('a2')).toBe(false);
    noteClaudeSidechain(state, adapterV1.toSessionRecord(assistant({ isSidechain: true }, null, '2026-10-01T10:00:00.000Z', u(1, 1))));
    expect(state).toEqual({ agents: new Set(['a1', null]), unidentified: true });
    noteClaudeSidechain(state, adapterV1.toSessionRecord(assistant({}, 'm2', '2026-10-01T10:00:00.000Z', u(1, 1))));
    expect(state.agents.size).toBe(2);
  });
});

describe('codexUsageObservation', () => {
  const count = (at: string, input: number) => ({
    type: 'event_msg',
    timestamp: at,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 3 } } },
  });

  it('token_count → cumulative по нити rollout; остальное — null', () => {
    expect(codexUsageObservation(count('2026-10-01T10:00:00.000Z', 100))).toEqual({
      kind: 'cumulative',
      stream: 'rollout',
      counters: { input: 60, output: 3, cacheRead: 40, cacheWrite: null, totalInput: 100 },
      at: '2026-10-01T10:00:00.000Z',
    });
    expect(codexUsageObservation({ type: 'event_msg', payload: { type: 'user_message' } })).toBeNull();
    expect(codexUsageObservation({ type: 'event_msg', payload: { type: 'token_count', info: null } })).toBeNull();
    expect(codexUsageObservation({ type: 'response_item', payload: { type: 'token_count' } })).toBeNull();
    expect(codexUsageObservation({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {} } } })).toMatchObject({ at: null });
  });

  it('спад счётчика: ledger из наблюдений равен indexCodexSession', async () => {
    const records = [
      { type: 'session_meta', timestamp: '2026-10-01T09:00:00.000Z', payload: { id: 't1', cwd: '/c', source: 'cli' } },
      count('2026-10-01T10:00:00.000Z', 100),
      count('2026-10-01T10:05:00.000Z', 150),
      count('2026-10-01T10:10:00.000Z', 20),
    ];
    const file = path.join(root, 'rollout-2026-10-01T09-00-00-t1.jsonl');
    await writeFile(file, jsonl(records));
    const ledger = createUsageLedger();
    for (const raw of records) {
      const observation = codexUsageObservation(raw);
      if (observation !== null) ledger.observe(observation);
    }
    const expected = (await indexCodexSession(file)).usage;
    expect(ledger.summary()).toEqual(expected);
    expect(expected).toMatchObject({ completeness: expect.not.stringMatching(/^complete$/) });
  });
});

describe('replayClaudeUsage', () => {
  it('сумма родителя и подагента равна indexSessionFile', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(dir, { recursive: true });
    const parentRecords = [
      { type: 'user', sessionId: 's1', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      assistant({}, 'm1', '2026-10-01T10:00:01.000Z', u(10, 1)),
      assistant({}, 'm1', '2026-10-01T10:00:02.000Z', u(10, 1)),
      assistant({}, 'm2', '2026-10-01T10:00:03.000Z', u(30, 3)),
    ];
    const childRecords = [assistant({ agentId: 'a1' }, 'c1', '2026-10-01T10:00:04.000Z', u(5, 5))];
    const parentFile = path.join(dir, 's1.jsonl');
    const childFile = path.join(dir, 'agent-a1.jsonl');
    await writeFile(parentFile, jsonl(parentRecords));
    await writeFile(childFile, jsonl(childRecords));
    const subagents = [{ file: childFile, metaFile: `${childFile}.meta.json`, agentId: 'a1', workflowRunId: null }];

    const parent = await collect(parentFile, parentRecords);
    const child = await collect(childFile, childRecords);
    const ledger = createUsageLedger();
    replayClaudeUsage(ledger, parent, [{ agentId: 'a1', observations: child.observations }]);
    const expected = (await indexSessionFile(parentFile, root, { subagents })).usage;
    expect(ledger.summary()).toEqual(expected);
    expect(expected).toMatchObject({ input: 45, output: 9 });
  });

  it('запись подагента без messageId при sidechain у родителя — markAmbiguous, как в индексаторе', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(dir, { recursive: true });
    const parentRecords = [
      assistant({}, 'm1', '2026-10-01T10:00:01.000Z', u(10, 1)),
      assistant({ isSidechain: true, agentId: 'a1' }, 'x1', '2026-10-01T10:00:02.000Z', u(2, 2)),
    ];
    const childRecords = [
      assistant({ agentId: 'a1' }, null, '2026-10-01T10:00:03.000Z', u(4, 4)),
      assistant({ agentId: 'a1' }, 'c2', '2026-10-01T10:00:04.000Z', u(1, 1)),
    ];
    const parentFile = path.join(dir, 's1.jsonl');
    const childFile = path.join(dir, 'agent-a1.jsonl');
    await writeFile(parentFile, jsonl(parentRecords));
    await writeFile(childFile, jsonl(childRecords));
    const subagents = [{ file: childFile, metaFile: `${childFile}.meta.json`, agentId: 'a1', workflowRunId: null }];

    const parent = await collect(parentFile, parentRecords);
    const child = await collect(childFile, childRecords);
    const ledger = createUsageLedger();
    replayClaudeUsage(ledger, parent, [{ agentId: 'a1', observations: child.observations }]);
    const expected = (await indexSessionFile(parentFile, root, { subagents })).usage;
    expect(ledger.summary()).toEqual(expected);
    expect(expected.completeness).not.toBe('complete');
  });
});
