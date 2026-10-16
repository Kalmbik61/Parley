import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFile, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { RolloutRecord } from '@parley/core';
import type { PtyHandle } from '../pty/pty-manager.js';
import { CONTEXT_POLL_MS, createContextService } from './context-service.js';

const FILL = { usedPercent: 41.5, windowTokens: 200_000, usedTokens: 83_000, at: '2026-10-15T10:00:00.000Z' };

describe('createContextService (спека 4.3)', () => {
  let project = '';
  let claude: SessionRef;
  let codex: SessionRef;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'parley-context-service-'));
    claude = { projectPath: project, workId: 'w-01', sessionId: 's-01' };
    codex = { projectPath: project, workId: 'w-01', sessionId: 's-02' };
    await mkdir(workPaths(project, 'w-01').context, { recursive: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(project, { recursive: true, force: true });
  });

  const handles = (): PtyHandle[] =>
    [
      { ref: claude, provider: 'claude' },
      { ref: codex, provider: 'codex' },
    ] as unknown as PtyHandle[];

  it('файл запущенной сессии не-Codex — в setContext; Codex не читается', async () => {
    await writeFile(contextFile(workPaths(project, 'w-01').dir, 's-01'), JSON.stringify(FILL));
    const setContext = vi.fn();
    await createContextService({ pty: { list: handles }, activity: { setContext, logFile: () => null } }).tick();
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledWith(claude, FILL);
  });

  it('файла нет — setContext(ref, null)', async () => {
    const setContext = vi.fn();
    await createContextService({ pty: { list: handles }, activity: { setContext, logFile: () => null } }).tick();
    expect(setContext).toHaveBeenCalledWith(claude, null);
  });

  const tokenCount = (at: string, last: number, window: number): RolloutRecord => ({
    ordinal: null,
    at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: last }, total_token_usage: { total_tokens: last }, model_context_window: window },
    },
  });

  it('Codex — процент из последнего token_count хвоста; без новых token_count повторного setContext нет', async () => {
    const setContext = vi.fn();
    const reads: RolloutRecord[][] = [
      [tokenCount('2026-10-16T10:00:00.000Z', 50_000, 272_000), tokenCount('2026-10-16T10:01:00.000Z', 142_000, 272_000)],
      [{ ordinal: null, at: '2026-10-16T10:02:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } }],
    ];
    const made: Array<{ file: string; seed: number | undefined }> = [];
    const service = createContextService({
      pty: { list: handles },
      activity: { setContext, logFile: () => '/tmp/r.jsonl' },
      read: async () => null,
      codexTail: (file, seedMaxBytes) => {
        made.push({ file, seed: seedMaxBytes });
        return { read: async () => reads.shift() ?? [] };
      },
    });
    await service.tick();
    const codexCalls = setContext.mock.calls.filter(([target]) => target === codex);
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]?.[1]).toMatchObject({ usedTokens: expect.any(Number), at: '2026-10-16T10:01:00.000Z' });
    expect(made).toEqual([{ file: '/tmp/r.jsonl', seed: 1024 * 1024 }]);
    await service.tick();
    expect(setContext.mock.calls.filter(([target]) => target === codex)).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it('start опрашивает раз в CONTEXT_POLL_MS, stop прекращает', async () => {
    vi.useFakeTimers();
    const setContext = vi.fn();
    const read = vi.fn(async () => FILL);
    const service = createContextService({ pty: { list: handles }, activity: { setContext, logFile: () => null }, read });
    service.start();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    service.stop();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
