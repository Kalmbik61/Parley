import type { SessionIndex } from '@harnas/core';
import { mkdtemp, mkdir, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Root } from './root.js';
import { applyChange } from './use-sessions.js';

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 's1',
    project: '-proj',
    projectPath: '/work',
    cwd: '/work',
    gitBranch: 'main',
    version: '2.1.247',
    file: '/root/s1.jsonl',
    title: 'первая',
    titleSource: 'custom',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:10:00.000Z',
    durationMs: 600_000,
    records: 5,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: null,
    ...over,
  };
}

describe('applyChange', () => {
  it('обновлённая сессия заменяет себя, а не дублируется', () => {
    const before = [session()];
    const after = applyChange(before, {
      kind: 'updated',
      file: '/root/s1.jsonl',
      session: session({ title: 'переименована' }),
    });

    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe('переименована');
  });

  it('новая сессия встаёт по свежести', () => {
    const before = [session({ file: '/root/s1.jsonl', endedAt: '2026-09-01T10:00:00.000Z' })];
    const after = applyChange(before, {
      kind: 'updated',
      file: '/root/s2.jsonl',
      session: session({
        id: 's2',
        file: '/root/s2.jsonl',
        title: 'свежая',
        endedAt: '2026-09-02T10:00:00.000Z',
      }),
    });

    expect(after.map((s) => s.title)).toEqual(['свежая', 'первая']);
  });

  it('удалённая сессия уходит из списка', () => {
    const after = applyChange([session()], { kind: 'removed', file: '/root/s1.jsonl' });
    expect(after).toEqual([]);
  });

  it('удаление чужого файла ничего не ломает', () => {
    const before = [session()];
    expect(applyChange(before, { kind: 'removed', file: '/root/другое.jsonl' })).toEqual(before);
  });
});

describe('живое обновление', () => {
  let root: string;
  // Второй корень тоже временный: иначе тест увидел бы реальные сессии Codex.
  let codexRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-live-'));
    codexRoot = await mkdtemp(path.join(tmpdir(), 'harnas-live-codex-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(codexRoot, { recursive: true, force: true });
  });

  const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeoutMs) throw new Error('изменение не доехало до UI');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('дописанный файл перерисовывает список без опроса', async () => {
    const project = path.join(root, '-proj');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 's1.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'старое имя', sessionId: 's1' })}\n`,
    );

    const { lastFrame, unmount } = render(<Root root={root} codexRoot={codexRoot} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('старое имя'));

      await appendFile(
        file,
        `${JSON.stringify({ type: 'custom-title', customTitle: 'новое имя', sessionId: 's1' })}\n`,
      );
      await waitFor(() => (lastFrame() ?? '').includes('новое имя'));

      expect(lastFrame()).toContain('SESSIONS (1)');
    } finally {
      unmount();
    }
  }, 20_000);

  it('пустой корень показывает внятное пустое состояние', async () => {
    const { lastFrame, unmount } = render(<Root root={root} codexRoot={codexRoot} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('SESSIONS (0)'));
      expect(lastFrame()).toContain('Сессий не найдено');
    } finally {
      unmount();
    }
  }, 20_000);
});
