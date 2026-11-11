import { appendFile, copyFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionIndexer } from '../session-indexer.js';
import { qwenBindingCandidate, qwenBindingHolds } from './binding.js';
import { defaultQwenRoot, discoverQwenSessions, isQwenTranscriptPath, qwenLogId } from './discover.js';
import { buildQwenIndex, extendQwenSessionIndex, indexQwenSession } from './index-session.js';

const FIXTURES = path.resolve(import.meta.dirname, '../feed/qwen/__fixtures__');
const MAIN_ID = '66666666-6666-4666-8666-666666666666';
const RESUME_ID = '44444444-4444-4444-8444-444444444444';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-qwen-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function place(fixture: string, id: string, project = '-work-project'): Promise<string> {
  const dir = path.join(root, project, 'chats');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await copyFile(path.join(FIXTURES, fixture), file);
  return file;
}

describe('qwen history root', () => {
  it('follows QWEN_HOME', () => {
    expect(defaultQwenRoot({ QWEN_HOME: '/x/q', HOME: '/h' })).toBe('/x/q/projects');
    expect(defaultQwenRoot({ HOME: '/h' })).toBe('/h/.qwen/projects');
  });

  it('knows transcript paths by shape and id by name', () => {
    expect(isQwenTranscriptPath(path.join(root, 'p', 'chats', `${MAIN_ID}.jsonl`), root)).toBe(true);
    expect(isQwenTranscriptPath(path.join(root, 'p', 'chats', 'notes.jsonl'), root)).toBe(false);
    expect(isQwenTranscriptPath(path.join(root, 'p', 'other', `${MAIN_ID}.jsonl`), root)).toBe(false);
    expect(isQwenTranscriptPath(path.join(root, '..', 'p', 'chats', `${MAIN_ID}.jsonl`), root)).toBe(false);
    expect(qwenLogId(`${MAIN_ID}.jsonl`)).toBe(MAIN_ID);
    expect(qwenLogId('x.jsonl')).toBeNull();
  });
});

describe('discovery and index from the fixtures', () => {
  it('lists the sessions without decoding the directory name', async () => {
    const file = await place('session-main.jsonl', MAIN_ID, 'any-lossy-name');
    expect(await discoverQwenSessions(root)).toEqual([{ file, id: MAIN_ID }]);
    expect(await discoverQwenSessions(path.join(root, 'missing'))).toEqual([]);
  });

  it('indexes session-main: cwd and id from the records, title from the first real prompt, tools by inner name', async () => {
    const file = await place('session-main.jsonl', MAIN_ID);
    const index = await indexQwenSession(file);
    expect(index).toMatchObject({
      provider: 'qwen', id: MAIN_ID, cwd: '/work/project', project: 'project', title: 'mcpflow',
      titleSource: 'first-text', primaryModel: 'mock-model', tokens: null, version: '0.27.2',
    });
    expect(index.tools).toMatchObject({ tool_search: 1, mcp__parley__echo: 2, run_shell_command: 1 });
    expect(index.recordTypes).toMatchObject({ user: 2, assistant: 6, tool_result: 4, system: 16 });
    expect(index.lastUserRecordAt).toBe('2026-11-11T13:14:39.901Z');
  });

  it('builds the all-sessions list entry for a fixture session', async () => {
    await place('session-main.jsonl', MAIN_ID);
    await place('session-resume.jsonl', RESUME_ID);
    const all = await buildQwenIndex(root);
    expect(all.map((s) => s.provider)).toEqual(['qwen', 'qwen']);
    expect(all.map((s) => s.id).sort()).toEqual([MAIN_ID, RESUME_ID].sort());
  });
});

describe('incremental reading', () => {
  const line = (n: number): string =>
    `${JSON.stringify({ uuid: `u${n}`, sessionId: MAIN_ID, timestamp: `2026-11-11T13:00:0${n}.000Z`, type: 'user', provenance: 'real_user', cwd: '/w', message: { parts: [{ text: `p${n}` }] } })}\n`;

  it('append, a partial last line, and truncation', async () => {
    const dir = path.join(root, 'p', 'chats');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${MAIN_ID}.jsonl`);
    await writeFile(file, line(1));
    const first = await extendQwenSessionIndex(null, file);
    expect(first.index.records).toBe(1);

    const second = line(2);
    await appendFile(file, second.slice(0, 30));
    const partial = await extendQwenSessionIndex(first.state, file);
    expect(partial.index.records).toBe(1);
    expect(partial.index.malformedLines).toBe(1);

    await appendFile(file, second.slice(30));
    const done = await extendQwenSessionIndex(partial.state, file);
    expect(done.index.records).toBe(2);
    expect(done.index.malformedLines).toBe(0);
    expect(done.index.lastUserRecordAt).toBe('2026-11-11T13:00:02.000Z');

    await truncate(file, 0);
    await appendFile(file, line(3));
    const truncated = await extendQwenSessionIndex(done.state, file);
    expect(truncated.index.records).toBe(1);
    expect(truncated.index.title).toBe('p3');
  });

  it('the indexer keeps qwen and codex states apart', async () => {
    const file = await place('session-main.jsonl', MAIN_ID);
    const indexer = createSessionIndexer();
    expect((await indexer.qwen(file)).provider).toBe('qwen');
  });
});

describe('transcript binding', () => {
  const file = (): string => path.join(root, 'p', 'chats', `${MAIN_ID}.jsonl`);
  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    hook_event_name: 'SessionStart', session_id: MAIN_ID, transcript_path: file(), cwd: '/work/project', ...over,
  });

  it('accepts a path named after the session under the qwen root', () => {
    expect(qwenBindingCandidate(body(), MAIN_ID, root)).toEqual({ path: file(), cwd: '/work/project' });
  });

  it('refuses another id, a foreign path, a missing cwd and a relative path', () => {
    expect(qwenBindingCandidate(body({ session_id: 'other' }), MAIN_ID, root)).toBeNull();
    expect(qwenBindingCandidate(body({ transcript_path: path.join(root, 'p', 'chats', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl') }), MAIN_ID, root)).toBeNull();
    expect(qwenBindingCandidate(body({ transcript_path: '/etc/passwd' }), MAIN_ID, root)).toBeNull();
    expect(qwenBindingCandidate(body({ cwd: '' }), MAIN_ID, root)).toBeNull();
    expect(qwenBindingCandidate(body({ transcript_path: 'chats/x.jsonl' }), MAIN_ID, root)).toBeNull();
  });

  it('holds only when the file, sessionId and cwd of the records agree', () => {
    const binding = { path: file(), cwd: '/work/project' };
    const index = { id: MAIN_ID, cwd: '/work/project', file: file() };
    expect(qwenBindingHolds(index, { sessionId: MAIN_ID, binding })).toBe(true);
    expect(qwenBindingHolds({ ...index, cwd: '/elsewhere' }, { sessionId: MAIN_ID, binding })).toBe(false);
    expect(qwenBindingHolds({ ...index, id: 'x' }, { sessionId: MAIN_ID, binding })).toBe(false);
    expect(qwenBindingHolds({ ...index, file: '/other.jsonl' }, { sessionId: MAIN_ID, binding })).toBe(false);
  });
});

describe('qwen in the summary transcript', () => {
  it('readTranscript gives human and agent replies, without thinking, tools or system records', async () => {
    await place('session-main.jsonl', MAIN_ID);
    const { readTranscript } = await import('../work/summary.js');
    const text = await readTranscript('qwen', MAIN_ID, { qwenRoot: root });
    expect(text).toContain('human: mcpflow');
    expect(text).toContain('agent: Hello from mock');
    expect(text).not.toContain('thinking about it');
    expect(text).not.toContain('memory snapshot');
    expect(await readTranscript('qwen', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { qwenRoot: root })).toBeNull();
  });
});
