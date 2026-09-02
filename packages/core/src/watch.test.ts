import { mkdtemp, mkdir, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionFileForPath } from './discover.js';
import { claudeSource, codexSource, watchSessions, type SessionChange } from './watch.js';

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

  /**
   * Ждём событие, периодически повторяя действие.
   *
   * Рекурсивный fs.watch на macOS прогревается не мгновенно: запись, сделанная
   * сразу после подписки, может не породить события вовсе — увеличение таймаута
   * тут не спасает, спасает повтор.
   */
  async function expectChange(
    changes: SessionChange[],
    poke: () => Promise<void>,
    predicate: (c: SessionChange) => boolean,
    timeoutMs = 15_000,
  ): Promise<SessionChange> {
    const started = Date.now();
    for (;;) {
      await poke();

      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        const found = changes.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (Date.now() - started > timeoutMs) throw new Error('события не дождались');
    }
  }

  it('дописанная сессия перечитывается и приезжает в событии', async () => {
    const project = path.join(dir, '-proj');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 's1.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', sessionId: 's1' })}\n`);

    const changes: SessionChange[] = [];
    const watcher = watchSessions((c) => changes.push(c), [claudeSource(dir)], {
      debounceMs: 30,
    });
    try {
      const change = await expectChange(
        changes,
        () =>
          appendFile(
            file,
            `${JSON.stringify({ type: 'custom-title', customTitle: 'дописано', sessionId: 's1' })}\n`,
          ),
        (c) => c.kind === 'updated' && c.file === file,
      );
      expect(change.kind === 'updated' && change.session.title).toBe('дописано');
    } finally {
      watcher.close();
    }
  }, 20_000);

  it('новый файл субагента обновляет родительскую сессию', async () => {
    const project = path.join(dir, '-proj');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 's1.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', sessionId: 's1' })}\n`);

    const changes: SessionChange[] = [];
    const watcher = watchSessions((c) => changes.push(c), [claudeSource(dir)], {
      debounceMs: 30,
    });
    try {
      const subagents = path.join(project, 's1', 'subagents');
      await mkdir(subagents, { recursive: true });

      const change = await expectChange(
        changes,
        () =>
          writeFile(
            path.join(subagents, 'agent-a1.jsonl'),
            `${JSON.stringify({ type: 'user', isSidechain: true })}\n`,
          ),
        (c) => c.kind === 'updated' && c.session.subsessionCount === 1,
      );
      expect(change.file).toBe(file);
    } finally {
      watcher.close();
    }
  }, 20_000);

  it('несуществующий корень не роняет вызов, а отдаётся в onError', () => {
    const errors: unknown[] = [];
    const watcher = watchSessions(() => {}, [claudeSource(path.join(dir, 'нет-такого'))], {
      onError: (error) => errors.push(error),
    });
    watcher.close();
    expect(errors).toHaveLength(1);
  });

  it('несколько источников работают одновременно', async () => {
    const claudeRoot = path.join(dir, 'claude');
    const codexRoot = path.join(dir, 'codex');
    await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
    await mkdir(path.join(codexRoot, '2026', '03', '12'), { recursive: true });

    const changes: SessionChange[] = [];
    const watcher = watchSessions(
      (c) => changes.push(c),
      [claudeSource(claudeRoot), codexSource(codexRoot)],
      { debounceMs: 30 },
    );

    try {
      const change = await expectChange(
        changes,
        () =>
          writeFile(
            path.join(codexRoot, '2026', '03', '12', 'rollout-2026-03-12T10-00-00-uuid.jsonl'),
            `${JSON.stringify({
              timestamp: '2026-03-12T10:00:00.000Z',
              type: 'session_meta',
              payload: { id: 'codex-1', cwd: '/tmp/x', cli_version: '0.77.0' },
            })}\n`,
          ),
        (c) => c.kind === 'updated' && c.session.provider === 'codex',
      );
      expect(change.kind === 'updated' && change.session.id).toBe('codex-1');
    } finally {
      watcher.close();
    }
  }, 20_000);
});
