import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkSession } from '@parley/core';
import { createLogIndex, type LogIndex } from './log-index.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../core/src/feed/qwen/__fixtures__/session-main.jsonl');
const ID = '66666666-6666-4666-8666-666666666666';
const CWD = '/work/project';

let claudeRoot = '';
let codexRoot = '';
let qwenRoot = '';
let indexes: LogIndex[] = [];

beforeEach(async () => {
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  qwenRoot = await mkdtemp(path.join(tmpdir(), 'parley-qwen-'));
});
afterEach(async () => {
  for (const index of indexes) index.stop();
  indexes = [];
  await Promise.all([claudeRoot, codexRoot, qwenRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

const index = (): LogIndex => {
  const created = createLogIndex({ claudeRoot, codexRoot, qwenRoot }, { cache: null });
  indexes.push(created);
  return created;
};

const session = (over: Partial<WorkSession> = {}): WorkSession => ({
  id: 's-01', provider: 'qwen', label: 'q', task: '', parent: null, contextFrom: [], lifecycle: 'active', result: null,
  resultAt: null, closedAt: null, history: [], startedAt: '2026-11-11T13:00:00.000Z', endedAt: null, pid: null,
  startedAtProcess: null, launchedBy: null, providerSessionId: ID, metrics: null, summary: null, summarySource: null,
  artifacts: [], agent: null, ...over,
});

async function place(id = ID): Promise<string> {
  const dir = path.join(qwenRoot, '-work-project', 'chats');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await copyFile(FIXTURE, file);
  return file;
}

async function waitFor(check: () => boolean, redo?: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = 0;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    if (redo !== undefined && Date.now() - last >= 1000) {
      last = Date.now();
      await redo();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('log index: Qwen Code', () => {
  it('lists a fixture session found at start', async () => {
    await place();
    const idx = index();
    await idx.start();
    expect(idx.index(session())).toMatchObject({ provider: 'qwen', id: ID, cwd: CWD, title: 'mcpflow' });
    expect(idx.log(session())?.lastUserRecordAt).toBe('2026-11-11T13:14:39.901Z');
  });

  it('the same native id under Claude, Codex and Qwen does not clash', async () => {
    await place();
    const dir = path.join(claudeRoot, '-proj');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${ID}.jsonl`), `${JSON.stringify({ type: 'assistant', sessionId: ID, timestamp: '2026-11-11T12:00:00.000Z', message: { role: 'assistant' } })}\n`);
    const cdir = path.join(codexRoot, '2026', '11', '11');
    await mkdir(cdir, { recursive: true });
    await writeFile(path.join(cdir, `rollout-2026-11-11T12-00-01-${ID}.jsonl`), `${JSON.stringify({ type: 'session_meta', timestamp: '2026-11-11T12:00:01.000Z', payload: { id: ID, cwd: '/codex', source: 'cli' } })}\n`);
    const idx = index();
    await idx.start();
    expect(idx.index(session({ provider: 'qwen' }))?.provider).toBe('qwen');
    expect(idx.index(session({ provider: 'claude' }))?.provider).toBe('claude');
    expect(idx.index(session({ provider: 'codex' }))?.provider).toBe('codex');
  });

  it('a session created after start and then appended arrives through the watcher', async () => {
    const idx = index();
    await idx.start();
    expect(idx.index(session())).toBeUndefined();
    const file = path.join(qwenRoot, '-work-project', 'chats', `${ID}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    const create = (): Promise<void> => copyFile(FIXTURE, file);
    await create();
    await waitFor(() => idx.index(session()) !== undefined, create);
    const before = idx.index(session())?.records ?? 0;
    const line = `${JSON.stringify({ uuid: 'zz', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'user', provenance: 'real_user', cwd: CWD, message: { parts: [{ text: 'more' }] } })}\n`;
    await appendFile(file, line);
    await waitFor(() => (idx.index(session())?.records ?? 0) > before, () => Promise.resolve());
  }, 40_000);

  it('reindex reads a qwen transcript as qwen, never as a Codex rollout', async () => {
    const file = await place();
    const idx = index();
    await idx.start();
    await appendFile(file, `${JSON.stringify({ uuid: 'yy', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'assistant', cwd: CWD, model: 'm2', message: { parts: [{ text: 'x' }] } })}\n`);
    await idx.reindex(file);
    expect(idx.index(session())).toMatchObject({ provider: 'qwen', primaryModel: expect.any(String) });
    expect(idx.index(session())?.models).toHaveProperty('m2');
  });

  it('a binding survives a host restart: a fresh index trusts the bound file without any new hook', async () => {
    const file = await place();
    const bound = session({ qwenTranscript: { path: file, cwd: CWD } });
    const first = index();
    await first.start();
    expect(first.index(bound)?.file).toBe(file);
    first.stop();
    const second = index();
    await second.start();
    expect(second.index(bound)?.file).toBe(file);
  });

  it('a bound file whose records disagree (cwd or path) is not trusted', async () => {
    const file = await place();
    const idx = index();
    await idx.start();
    expect(idx.index(session({ qwenTranscript: { path: file, cwd: '/another' } }))).toBeUndefined();
    expect(idx.index(session({ qwenTranscript: { path: '/other.jsonl', cwd: CWD } }))).toBeUndefined();
  });

  it('usage readers are not offered for qwen', async () => {
    await place();
    const idx = index();
    await idx.start();
    const s = session();
    expect(idx.usage(s)).toBeUndefined();
    expect(await idx.usageIn(s, [])).toBeUndefined();
    expect(await idx.costIn(s, { from: 0, to: 1 } as never)).toBeUndefined();
    expect(await idx.idsIn(s, [])).toBeUndefined();
  });
});
