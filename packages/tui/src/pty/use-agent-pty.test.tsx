import type { SessionIndex } from '@harnas/core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const ENTER = '\r';

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 'сессия-1',
    project: '-proj',
    projectPath: '/work',
    cwd: '/work',
    gitBranch: 'main',
    version: '2.1.247',
    file: '/root/s1.jsonl',
    title: 'моя сессия',
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
    ...over,
  };
}

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Ink подписывается на stdin в эффекте после монтирования, а stdin в тестах —
 * обычный EventEmitter: запись до подписки теряется молча. Ждём подписку перед
 * первым нажатием.
 */
const mounted = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

describe('Enter открывает сессию в правой панели', () => {
  let root: string;
  let workdir: string;
  const originalBin = process.env['HARNAS_CLAUDE_BIN'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-open-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'harnas-work-'));
    // Настоящий claude в тестах не запускается никогда (specs/pty.md).
    process.env['HARNAS_CLAUDE_BIN'] = STUB;
  });

  afterEach(async () => {
    if (originalBin === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = originalBin;
    await rm(root, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  it('передаёт --resume с id сессии и её cwd', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session({ cwd: workdir })]} root={root} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);

      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('--resume');
      expect(frame).toContain('сессия-1');
      expect(frame).toContain(path.basename(workdir));
    } finally {
      unmount();
    }
  }, 25_000);

  it('заголовок панели показывает открытую сессию', async () => {
    const { stdin, lastFrame, unmount } = render(<App sessions={[session()]} root={root} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await waitFor(() => (lastFrame() ?? '').includes('TERMINAL — моя сессия'));
    } finally {
      unmount();
    }
  }, 25_000);

  it('без сессий Enter ничего не запускает', async () => {
    const { stdin, lastFrame, unmount } = render(<App sessions={[]} root={root} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lastFrame()).toContain('Enter на сессии');
    } finally {
      unmount();
    }
  }, 25_000);

  it('без бинаря панель объясняет проблему вместо падения', async () => {
    process.env['HARNAS_CLAUDE_BIN'] = path.join(root, 'нет-такого-бинаря');
    const { lastFrame, unmount } = render(<App sessions={[session()]} root={root} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('не найден в PATH'));
      expect(lastFrame()).toContain('немодифицированный');
    } finally {
      unmount();
    }
  }, 25_000);

  it('cwd не задан — процесс всё равно запускается', async () => {
    await mkdir(path.join(root, '-proj'), { recursive: true });
    await writeFile(path.join(root, '-proj', 'x.jsonl'), '');

    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session({ cwd: null })]} root={root} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
    } finally {
      unmount();
    }
  }, 25_000);
});
