import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchSessions, qwenSource, type SessionChange } from '../watch.js';

const FIXTURE = path.resolve(import.meta.dirname, '../feed/qwen/__fixtures__/session-main.jsonl');
const ID = '66666666-6666-4666-8666-666666666666';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-qwen-watch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function until(test: () => boolean, redo?: () => Promise<void>, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await redo?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('qwenSource', () => {
  it('resolves only <root>/<project>/chats/<uuid>.jsonl', () => {
    const src = qwenSource(root);
    const ok = path.join(root, 'p', 'chats', `${ID}.jsonl`);
    expect(src.resolve(ok, root)).toBe(ok);
    expect(src.resolve(path.join(root, 'p', 'chats', 'oauth_creds.json'), root)).toBeNull();
    expect(src.resolve(path.join(root, 'p', `${ID}.jsonl`), root)).toBeNull();
  });

  it('a session created after the watcher started, then appended', async () => {
    const dir = path.join(root, 'p', 'chats');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ID}.jsonl`);
    const changes: SessionChange[] = [];
    const watcher = watchSessions((c) => changes.push(c), [qwenSource(root)], { debounceMs: 30 });
    try {
      const created = async (): Promise<void> => {
        await copyFile(FIXTURE, file);
      };
      await created();
      await until(() => changes.some((c) => c.kind === 'updated' && c.session.provider === 'qwen'), created);
      const first = changes.filter((c) => c.kind === 'updated').at(-1);
      const before = first?.kind === 'updated' ? first.session.records : 0;
      const line = `${JSON.stringify({ uuid: 'zz', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'user', provenance: 'real_user', cwd: '/work/project', message: { parts: [{ text: 'more' }] } })}\n`;
      const append = (): Promise<void> => appendFile(file, line);
      await append();
      await until(() => changes.some((c) => c.kind === 'updated' && c.session.records > before), undefined);
    } finally {
      watcher.close();
    }
  }, 30_000);

  it('a missed watch event is caught by rescan', async () => {
    const dir = path.join(root, 'p', 'chats');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ID}.jsonl`);
    await copyFile(FIXTURE, file);
    const changes: SessionChange[] = [];
    // The watcher's own root does not exist, so no fs event ever arrives: only the periodic rescan can find the file.
    const missing = path.join(root, 'nowhere');
    const source = { ...qwenSource(root), root };
    const deaf = watchSessions((c) => changes.push(c), [{ ...source, root: missing, resolve: (p) => (p === file ? file : null) }], { debounceMs: 10, onError: () => {} });
    try {
      deaf.rescan([file]);
      await until(() => changes.some((c) => c.kind === 'updated'));
      expect(changes[0]).toMatchObject({ kind: 'updated', file });
    } finally {
      deaf.close();
    }
  });
});
