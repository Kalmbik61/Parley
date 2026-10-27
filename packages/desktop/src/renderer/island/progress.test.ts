import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressResult } from '@parley/protocol';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { createProgressPoller, type ProgressSelection, type ProgressState } from './progress.js';

const REF = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const available = (revision = 1): ProgressResult => ({ revision, availability: 'available', current: null, recent: [], truncated: false });
const unavailable: ProgressResult = { revision: 0, availability: 'unavailable', current: null, recent: [], truncated: false };
const selection = (patch: Partial<ProgressSelection> = {}): ProgressSelection => ({ ref: REF, active: true, connectionGeneration: 1, lifecycle: 'process-A', methods: ['feed.progress'], ...patch });
function held() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((done) => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const call = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(available());
  let state: ProgressState = { kind: 'loading' };
  const poller = createProgressPoller({ call, onChange: (next) => { state = next; } });
  return { call, poller, state: () => state };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('selected progress polling', () => {
  it('polls one ref only, 500ms after settled, and stops without late delivery', async () => {
    const { call, poller, state } = setup();
    const pending = held(); call.mockReturnValueOnce(pending.promise);
    poller.update(selection());
    await vi.advanceTimersByTimeAsync(700);
    expect(call).toHaveBeenCalledOnce();
    pending.resolve(available(3)); await vi.advanceTimersByTimeAsync(0);
    expect(state()).toMatchObject({ kind: 'available', result: { revision: 3 } });
    await vi.advanceTimersByTimeAsync(499); expect(call).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith('feed.progress', { ref: REF });
    poller.update(selection({ active: false }));
    await vi.advanceTimersByTimeAsync(10_000); expect(call).toHaveBeenCalledTimes(2);
    poller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, []])('old host methods %j gives unavailable without a request loop', async (methods) => {
    const { call, poller, state } = setup(); poller.update(selection({ methods }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).not.toHaveBeenCalled(); expect(state()).toEqual({ kind: 'unavailable' }); poller.dispose();
  });

  it('keeps one underlying request across selection changes and discards old replies', async () => {
    const { call, poller, state } = setup(); const pending = held(); call.mockReturnValueOnce(pending.promise);
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0);
    const other = { ...REF, projectPath: '/other', sessionId: 's-02' };
    poller.update(selection({ ref: other }));
    expect(call).toHaveBeenCalledOnce();
    pending.resolve(available(99)); await vi.advanceTimersByTimeAsync(0);
    expect(state()).toEqual({ kind: 'loading' });
    await vi.advanceTimersByTimeAsync(500);
    expect(call).toHaveBeenLastCalledWith('feed.progress', { ref: other });
    expect(state()).toMatchObject({ kind: 'available', result: { revision: 1 } }); poller.dispose();
  });

  it('selection changes after settle still respect the global 500ms pause', async () => {
    const { call, poller } = setup();
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0);
    poller.update(selection({ ref: { ...REF, sessionId: 's-02' } }));
    expect(call).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(499); expect(call).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(2); poller.dispose();
  });

  it('unavailable never lowers available revision expectation; lifecycle and connection reset it', async () => {
    const { call, poller, state } = setup();
    call.mockResolvedValueOnce(available(10)).mockResolvedValueOnce(unavailable).mockResolvedValueOnce(available(9)).mockResolvedValueOnce(available(11));
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500); expect(state()).toEqual({ kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(500); expect(state()).toEqual({ kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(500); expect(state()).toMatchObject({ result: { revision: 11 } });
    poller.update(selection({ lifecycle: 'process-B' })); await vi.advanceTimersByTimeAsync(500);
    expect(state()).toMatchObject({ result: { revision: 1 } });
    poller.update(selection({ lifecycle: 'process-B', connectionGeneration: 2 })); await vi.advanceTimersByTimeAsync(500);
    expect(state()).toMatchObject({ result: { revision: 1 } }); poller.dispose();
  });

  it.each([false, true])('deadline retains stale result=%s and waits for underlying settle plus 500ms', async (withResult) => {
    const { call, poller, state } = setup(); const pending = held();
    if (withResult) { poller.update(selection()); await vi.advanceTimersByTimeAsync(0); call.mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(500); }
    else { call.mockReturnValueOnce(pending.promise); poller.update(selection()); await vi.advanceTimersByTimeAsync(0); }
    const count = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(state()).toMatchObject(withResult ? { kind: 'available', delayed: true } : { kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(5000); expect(call).toHaveBeenCalledTimes(count);
    pending.resolve(available(99)); await vi.advanceTimersByTimeAsync(499); expect(call).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(count + 1);
    expect(state()).toMatchObject({ result: { revision: 1 }, delayed: false }); poller.dispose();
  });

  it.each([false, true])('throttle keeps loading or stale data, result=%s', async (withResult) => {
    const { call, poller, state } = setup();
    const error = encodeIpcError({ code: 'conflict', message: 'SECRET', data: { reason: 'island-progress-rate-limit', retryAfterMs: 250 } });
    if (withResult) { poller.update(selection()); await vi.advanceTimersByTimeAsync(0); call.mockRejectedValueOnce(error); await vi.advanceTimersByTimeAsync(500); }
    else { call.mockRejectedValueOnce(error); poller.update(selection()); await vi.advanceTimersByTimeAsync(0); }
    expect(state()).toMatchObject(withResult ? { kind: 'available', delayed: true } : { kind: 'loading' });
    expect(JSON.stringify(state())).not.toContain('SECRET');
    const count = call.mock.calls.length; await vi.advanceTimersByTimeAsync(499); expect(call).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(count + 1); poller.dispose();
  });

  it('pause cancels late delivery and timers, resume is fresh; unknown method stops retries', async () => {
    const { call, poller, state } = setup(); const pending = held(); call.mockReturnValueOnce(pending.promise);
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0);
    poller.update(selection({ active: false })); pending.resolve(available(99));
    await vi.advanceTimersByTimeAsync(5000); expect(call).toHaveBeenCalledOnce();
    call.mockRejectedValueOnce(encodeIpcError({ code: 'unknown_method', message: 'SECRET' }));
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0);
    expect(state()).toEqual({ kind: 'unavailable' }); await vi.advanceTimersByTimeAsync(5000);
    expect(call).toHaveBeenCalledTimes(2); poller.dispose();
  });

  it('rejects malformed payloads and refs with generic unavailable', async () => {
    const { call, poller, state } = setup(); call.mockResolvedValueOnce({ ...available(), command: 'SECRET' });
    poller.update(selection()); await vi.advanceTimersByTimeAsync(0); expect(state()).toEqual({ kind: 'unavailable' });
    poller.update(selection({ ref: { ...REF, sessionId: '' } })); await vi.advanceTimersByTimeAsync(5000);
    expect(call).toHaveBeenCalledOnce(); expect(state()).toEqual({ kind: 'unavailable' }); poller.dispose();
  });
});
