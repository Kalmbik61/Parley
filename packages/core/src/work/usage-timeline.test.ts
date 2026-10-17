import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexCodexSession } from '../codex/index-session.js';
import { indexSessionFile } from '../session-index.js';
import { createUsageLedger, type UsageWindow } from './usage-ledger.js';
import {
  claudeUsageFromTimelines,
  codexUsageFromTimeline,
  extendUsageTimeline,
  type TimelineReader,
} from './usage-timeline.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-usage-timeline-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const assistant = (extra: Record<string, unknown>, id: string | null, at: string, usage: Record<string, number>) => ({
  type: 'assistant',
  sessionId: 's1',
  timestamp: at,
  ...extra,
  message: { role: 'assistant', ...(id === null ? {} : { id }), content: [{ type: 'text', text: 'ok' }], usage },
});
const u = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const count = (at: string, input: number) => ({
  type: 'event_msg',
  timestamp: at,
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 3 } } },
});

/** Файл в памяти: подменяется целиком (`set`), `opens` помнит `start` каждого чтения. */
function memoryReader(): { reader: TimelineReader; set(text: string, ino?: number): void; opens: number[] } {
  let content = Buffer.alloc(0);
  let ino = 1;
  const opens: number[] = [];
  return {
    opens,
    set(text, nextIno = ino) {
      content = Buffer.from(text);
      ino = nextIno;
    },
    reader: {
      stat: async () => ({ size: content.length, ino }),
      open: (_file, start) => {
        opens.push(start);
        return Readable.from([content.subarray(start)]);
      },
    },
  };
}

const A = assistant({}, 'm1', '2026-10-01T10:00:01.000Z', u(10, 1));
const B = assistant({}, 'm2', '2026-10-01T10:00:02.000Z', u(20, 2));
const C = assistant({}, 'm3', '2026-10-01T10:00:03.000Z', u(30, 3));

describe('extendUsageTimeline', () => {
  it('второй вызов читает только дописанные байты', async () => {
    const mem = memoryReader();
    mem.set(jsonl([A]));
    const first = await extendUsageTimeline(null, '/f.jsonl', 'claude', mem.reader);
    mem.set(jsonl([A, B]));
    const second = await extendUsageTimeline(first, '/f.jsonl', 'claude', mem.reader);
    expect(mem.opens).toEqual([0, Buffer.byteLength(jsonl([A]))]);
    expect(second.observations.map((o) => (o.kind === 'delta' ? o.id : ''))).toEqual(['msg:m1', 'msg:m2']);
    expect(second.offset).toBe(Buffer.byteLength(jsonl([A, B])));
  });

  it('оборванная последняя строка не разбирается и ждёт следующего вызова', async () => {
    const mem = memoryReader();
    const whole = JSON.stringify(B);
    mem.set(jsonl([A]) + whole.slice(0, 20));
    const first = await extendUsageTimeline(null, '/f.jsonl', 'claude', mem.reader);
    expect(first.observations).toHaveLength(1);
    expect(first.offset).toBe(Buffer.byteLength(jsonl([A])));
    mem.set(jsonl([A, B]));
    const second = await extendUsageTimeline(first, '/f.jsonl', 'claude', mem.reader);
    expect(mem.opens[1]).toBe(first.offset);
    expect(second.observations).toHaveLength(2);
    expect(second.lineNo).toBe(2);
  });

  it('целая последняя строка без перевода строки считается сразу', async () => {
    const mem = memoryReader();
    const text = jsonl([A]) + JSON.stringify(B);
    mem.set(text);
    const first = await extendUsageTimeline(null, '/f.jsonl', 'claude', mem.reader);
    expect(first.observations).toHaveLength(2);
    expect(first.offset).toBe(Buffer.byteLength(text));
    // Дописанный позже перевод строки не заводит пустую строку: номера строк как у полного перечита.
    mem.set(`${text}\n${JSON.stringify(C)}\n`);
    const second = await extendUsageTimeline(first, '/f.jsonl', 'claude', mem.reader);
    expect(second.observations).toHaveLength(3);
    expect(second.lineNo).toBe(3);
  });

  it('усечение файла и другой ino строят шкалу заново', async () => {
    const mem = memoryReader();
    mem.set(jsonl([A, B]));
    const first = await extendUsageTimeline(null, '/f.jsonl', 'claude', mem.reader);
    mem.set(jsonl([C]));
    const truncated = await extendUsageTimeline(first, '/f.jsonl', 'claude', mem.reader);
    expect(truncated.observations).toHaveLength(1);
    expect(mem.opens[1]).toBe(0);
    mem.set(jsonl([A, B, C]), 2);
    const replaced = await extendUsageTimeline(truncated, '/f.jsonl', 'claude', mem.reader);
    expect(replaced.observations).toHaveLength(3);
    expect(mem.opens[2]).toBe(0);
  });

  it('extend не мутирует прежнюю шкалу', async () => {
    const mem = memoryReader();
    mem.set(jsonl([A]));
    const first = await extendUsageTimeline(null, '/f.jsonl', 'claude', mem.reader);
    mem.set(jsonl([A, B]));
    const second = await extendUsageTimeline(first, '/f.jsonl', 'claude', mem.reader);
    expect(first.observations).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(second.observations).not.toBe(first.observations);
    expect(second.sidechain).not.toBe(first.sidechain);
  });

  it('файла нет — пустая шкала; срез пустой шкалы равен summary() пустого ledger с окнами', async () => {
    const windows: UsageWindow[] = [{ from: '2026-10-01T00:00:00.000Z', to: null }];
    const missing = await extendUsageTimeline(null, path.join(root, 'nope.jsonl'), 'claude');
    expect(missing).toMatchObject({ offset: 0, size: 0, ino: 0, observations: [] });
    expect(claudeUsageFromTimelines(missing, [], windows)).toEqual(createUsageLedger({ windows }).summary());
    const codex = await extendUsageTimeline(null, path.join(root, 'nope.jsonl'), 'codex');
    expect(codexUsageFromTimeline(codex, windows)).toEqual(createUsageLedger({ windows }).summary());
  });

  it('срез по окнам равен полному перечиту', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(dir, { recursive: true });
    const parentFile = path.join(dir, 's1.jsonl');
    const childFile = path.join(dir, 'agent-a1.jsonl');
    await writeFile(parentFile, jsonl([
      { type: 'user', sessionId: 's1', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      A,
      A,
      assistant({ isSidechain: true, agentId: 'a1' }, 'x1', '2026-10-01T10:00:02.000Z', u(2, 2)),
      B,
    ]));
    await writeFile(childFile, jsonl([
      assistant({ agentId: 'a1' }, null, '2026-10-01T10:00:03.000Z', u(4, 4)),
      assistant({ agentId: 'a1' }, 'c2', '2026-10-01T10:00:04.000Z', u(1, 1)),
    ]));
    const subagents = [{ file: childFile, metaFile: `${childFile}.meta.json`, agentId: 'a1', workflowRunId: null }];
    const codexFile = path.join(root, 'rollout-2026-10-01T09-00-00-t1.jsonl');
    await writeFile(codexFile, jsonl([
      { type: 'session_meta', timestamp: '2026-10-01T09:00:00.000Z', payload: { id: 't1', cwd: '/c', source: 'subagent', parent_thread_id: 'p1' } },
      count('2026-10-01T10:00:00.000Z', 100),
      count('2026-10-01T10:05:00.000Z', 150),
      count('2026-10-01T10:10:00.000Z', 20),
    ]));

    const parent = await extendUsageTimeline(null, parentFile, 'claude');
    const child = { ...(await extendUsageTimeline(null, childFile, 'claude')), agentId: 'a1' };
    const codex = await extendUsageTimeline(null, codexFile, 'codex');
    const sets: UsageWindow[][] = [
      [{ from: '2026-10-01T10:00:01.500Z', to: '2026-10-01T10:00:03.500Z' }],
      [{ from: '2026-10-01T10:00:01.500Z', to: null }],
      [{ from: '2026-10-01T09:00:00.000Z', to: '2026-10-01T10:06:00.000Z' }, { from: '2026-10-01T10:09:00.000Z', to: null }],
    ];
    for (const windows of sets) {
      expect(claudeUsageFromTimelines(parent, [child], windows)).toEqual(
        (await indexSessionFile(parentFile, root, { subagents, usageWindows: windows })).usage,
      );
      expect(codexUsageFromTimeline(codex, windows)).toEqual((await indexCodexSession(codexFile, undefined, { usageWindows: windows })).usage);
    }
  });
});
