import { describe, expect, it, vi } from 'vitest';
import type { WorkSession } from '@parley/core';
import { createQwenBinding } from './qwen-binding.js';

const ID = '66666666-6666-4666-8666-666666666666';
const ROOT = '/q/projects';
const FILE = `${ROOT}/p/chats/${ID}.jsonl`;
const ref = { projectPath: '/work/project', workId: 'w-1', sessionId: 's-01' };

const make = (session: Partial<WorkSession> | undefined) => {
  const store = vi.fn(async () => undefined);
  const warn = vi.fn();
  const binding = createQwenBinding({
    log: { info: vi.fn(), warn, error: vi.fn() },
    qwenRoot: ROOT,
    session: () => (session === undefined ? undefined : ({ provider: 'qwen', providerSessionId: ID, ...session } as WorkSession)),
    store,
  });
  return { binding, store, warn };
};
const start = (over: Record<string, unknown> = {}) => ({ hook_event_name: 'SessionStart', session_id: ID, transcript_path: FILE, cwd: '/work/project', ...over });

describe('qwen transcript binding from SessionStart', () => {
  it('stores the path and cwd', async () => {
    const { binding, store } = make({});
    await binding.onHook({ ref, body: start() });
    expect(store).toHaveBeenCalledWith(ref, { path: FILE, cwd: '/work/project' });
  });

  it('is idempotent and ignores other hooks', async () => {
    const same = make({ qwenTranscript: { path: FILE, cwd: '/work/project' } });
    await same.binding.onHook({ ref, body: start() });
    await same.binding.onHook({ ref, body: { hook_event_name: 'Stop' } });
    expect(same.store).not.toHaveBeenCalled();
  });

  it('refuses a path that does not fit the session, a foreign cwd and other providers', async () => {
    const a = make({});
    await a.binding.onHook({ ref, body: start({ transcript_path: `${ROOT}/p/chats/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl` }) });
    await a.binding.onHook({ ref, body: start({ cwd: '/not/the/folder' }) });
    expect(a.store).not.toHaveBeenCalled();
    const b = make({ provider: 'claude' });
    await b.binding.onHook({ ref, body: start() });
    expect(b.store).not.toHaveBeenCalled();
    const c = make({ providerSessionId: null });
    await c.binding.onHook({ ref, body: start() });
    expect(c.store).not.toHaveBeenCalled();
  });

  it('uses the worktree as the session folder', async () => {
    const { binding, store } = make({ worktree: { path: '/wt/x' } as never });
    await binding.onHook({ ref, body: start({ cwd: '/wt/x' }) });
    expect(store).toHaveBeenCalledOnce();
  });
});
