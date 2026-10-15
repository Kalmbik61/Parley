import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFile, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
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
    await createContextService({ pty: { list: handles }, activity: { setContext } }).tick();
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledWith(claude, FILL);
  });

  it('файла нет — setContext(ref, null)', async () => {
    const setContext = vi.fn();
    await createContextService({ pty: { list: handles }, activity: { setContext } }).tick();
    expect(setContext).toHaveBeenCalledWith(claude, null);
  });

  it('start опрашивает раз в CONTEXT_POLL_MS, stop прекращает', async () => {
    vi.useFakeTimers();
    const setContext = vi.fn();
    const read = vi.fn(async () => FILL);
    const service = createContextService({ pty: { list: handles }, activity: { setContext }, read });
    service.start();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    service.stop();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
