import { mkdtemp, mkdir, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionFileForPath } from './discover.js';
import { watchSessions, type SessionChange } from './watch.js';

const root = '/root';
const p = (...parts: string[]) => path.join(root, ...parts);

describe('sessionFileForPath', () => {
  it('файл сессии отвечает сам за себя', () => {
    expect(sessionFileForPath(p('-proj', 's1.jsonl'), root)).toBe(p('-proj', 's1.jsonl'));
  });

  it('изменение файла субагента поднимается к родительской сессии', () => {
    expect(sessionFileForPath(p('-proj', 's1', 'subagents', 'agent-a1.jsonl'), root)).toBe(
      p('-proj', 's1.jsonl'),
    );
    expect(
      sessionFileForPath(
        p('-proj', 's1', 'subagents', 'workflows', 'wf_x', 'agent-a2.jsonl'),
        root,
      ),
    ).toBe(p('-proj', 's1.jsonl'));
  });

  it('journal.jsonl тоже принадлежит родительской сессии', () => {
    expect(
      sessionFileForPath(p('-proj', 's1', 'subagents', 'workflows', 'wf_x', 'journal.jsonl'), root),
    ).toBe(p('-proj', 's1.jsonl'));
  });

  it('посторонние файлы игнорируются', () => {
    expect(sessionFileForPath(p('-proj', 'MEMORY.md'), root)).toBeNull();
    expect(sessionFileForPath(p('-proj', 'sessions-index.json'), root)).toBeNull();
    expect(sessionFileForPath(p('-proj', 's1', 'workflows', 'wf_x.json'), root)).toBeNull();
    expect(sessionFileForPath(p('-proj'), root)).toBeNull();
    expect(sessionFileForPath('/другое/место/f.jsonl', root)).toBeNull();
  });
});

describe('watchSessions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harnas-watch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Ждём событие с таймаутом: fs.watch по природе асинхронен. */
  function nextChange(
    changes: SessionChange[],
    predicate: (c: SessionChange) => boolean,
    timeoutMs = 4000,
  ): Promise<SessionChange> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        const found = changes.find(predicate);
        if (found) {
          clearInterval(tick);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error('события не дождались'));
        }
      }, 25);
    });
  }

  it('дописанная сессия перечитывается и приезжает в событии', async () => {
    const project = path.join(dir, '-proj');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 's1.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', sessionId: 's1' })}\n`);

    const changes: SessionChange[] = [];
    const watcher = watchSessions((c) => changes.push(c), { root: dir, debounceMs: 30 });
    try {
      await appendFile(
        file,
        `${JSON.stringify({ type: 'custom-title', customTitle: 'дописано', sessionId: 's1' })}\n`,
      );
      const change = await nextChange(changes, (c) => c.kind === 'updated' && c.file === file);
      expect(change.kind === 'updated' && change.session.title).toBe('дописано');
    } finally {
      watcher.close();
    }
  });

  it('новый файл субагента обновляет родительскую сессию', async () => {
    const project = path.join(dir, '-proj');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 's1.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', sessionId: 's1' })}\n`);

    const changes: SessionChange[] = [];
    const watcher = watchSessions((c) => changes.push(c), { root: dir, debounceMs: 30 });
    try {
      const subagents = path.join(project, 's1', 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(
        path.join(subagents, 'agent-a1.jsonl'),
        `${JSON.stringify({ type: 'user', isSidechain: true })}\n`,
      );

      const change = await nextChange(
        changes,
        (c) => c.kind === 'updated' && c.session.subsessionCount === 1,
      );
      expect(change.file).toBe(file);
    } finally {
      watcher.close();
    }
  });

  it('несуществующий корень не роняет вызов, а отдаётся в onError', () => {
    const errors: unknown[] = [];
    const watcher = watchSessions(() => {}, {
      root: path.join(dir, 'нет-такого'),
      onError: (error) => errors.push(error),
    });
    watcher.close();
    expect(errors).toHaveLength(1);
  });
});
