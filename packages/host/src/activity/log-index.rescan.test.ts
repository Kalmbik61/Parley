import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWatcher } from '@parley/core';
import { createLogIndex, type LogIndex } from './log-index.js';

const watchers: Array<{ close: ReturnType<typeof vi.fn>; rescan: ReturnType<typeof vi.fn> }> = [];

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    buildAllSessions: async () => [],
    watchSessions: (): SessionWatcher => {
      const watcher = { close: vi.fn(), rescan: vi.fn() };
      watchers.push(watcher);
      return watcher as unknown as SessionWatcher;
    },
  };
});

let index: LogIndex | undefined;

afterEach(() => {
  index?.stop();
  index = undefined;
  watchers.length = 0;
});

describe('LogIndex.rescan', () => {
  it('rescan до start() и после stop() ничего не передаёт, после start() — основному наблюдателю и наблюдателю из watchClaudeRoot', async () => {
    index = createLogIndex({ claudeRoot: '/нет/claude', codexRoot: '/нет/codex' });
    index.rescan(['/a.jsonl']);
    expect(watchers).toHaveLength(0);

    await index.start();
    expect(watchers).toHaveLength(1);
    index.rescan(['/a.jsonl']);
    expect(watchers[0]!.rescan).toHaveBeenCalledTimes(1);
    expect(watchers[0]!.rescan).toHaveBeenLastCalledWith(['/a.jsonl']);

    index.watchClaudeRoot('/нет/второй-корень');
    expect(watchers).toHaveLength(2);
    index.rescan(['/b.jsonl']);
    expect(watchers[0]!.rescan).toHaveBeenLastCalledWith(['/b.jsonl']);
    expect(watchers[1]!.rescan).toHaveBeenCalledTimes(1);
    expect(watchers[1]!.rescan).toHaveBeenLastCalledWith(['/b.jsonl']);

    index.stop();
    index.rescan(['/c.jsonl']);
    expect(watchers[0]!.rescan).toHaveBeenCalledTimes(2);
    expect(watchers[1]!.rescan).toHaveBeenCalledTimes(1);
  });
});
