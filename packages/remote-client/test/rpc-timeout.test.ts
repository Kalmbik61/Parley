import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rpc, defaultTimeoutFor, RPC_MUTATING_TIMEOUT_MS, RPC_TIMEOUT_MS, BRIDGE_CALL_DEADLINE_MS } from '../src/index.js';

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as never,
  clearTimeout: (h: never) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
};

describe('RPC timeout policy (W1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mutating calls wait longer than the bridge host deadline; reads keep 15 s', () => {
    expect(RPC_MUTATING_TIMEOUT_MS).toBeGreaterThan(BRIDGE_CALL_DEADLINE_MS + 10_000);
    for (const m of ['feed.decide', 'rooms.resolveProposal', 'sessions.create', 'rooms.create', 'rooms.send']) {
      expect(defaultTimeoutFor(m), m).toBe(RPC_MUTATING_TIMEOUT_MS);
    }
    for (const m of ['works.list', 'feed.snapshot', 'context.messages']) expect(defaultTimeoutFor(m), m).toBe(RPC_TIMEOUT_MS);
  });

  it('a sessions.create answered after 20 s still resolves; a read gives up at 15 s', async () => {
    const sent: Array<{ id: string; method: string }> = [];
    const rpc = new Rpc((f) => void sent.push(f as never), timers);
    const create = rpc.call('sessions.create', {});
    const read = rpc.call('works.list', {});
    const readResult = read.then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await readResult).toBe('timeout');
    await vi.advanceTimersByTimeAsync(5_000);
    rpc.handle({ id: sent[0]!.id, result: { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-1' } } });
    await expect(create).resolves.toMatchObject({ ref: { sessionId: 's-1' } });
  });

  it('a mutating call times out only after 45 s', async () => {
    const rpc = new Rpc(() => undefined, timers);
    const call = rpc.call('feed.decide', {});
    const outcome = call.then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(44_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('timeout');
  });
});
