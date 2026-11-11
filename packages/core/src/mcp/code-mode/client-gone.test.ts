// A replacement launch whose client went (plan T8h, C1): the ledger's side, without processes. The real processes are in code-mode-client-gone.test.ts.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { exitWhenClientGone } from './client-gone.js';
import { RUN_LIMITS } from './limits.js';
import { type LedgerEntry, RunLedger, SessionScheduler } from './scheduler.js';
import { buildCatalog } from './catalog.js';
import { compileCallValidators, computeApiRevision } from './contracts.js';
import { TOOLS } from '../tools.js';

const catalog = buildCatalog(TOOLS);
const REV = computeApiRevision({ catalog, launch: 'l', policySnapshot: 'unavailable' });
const VAL = compileCallValidators(catalog, REV);
const lease = (s: SessionScheduler): RunLedger => {
  const l = s.acquire((runId) => new RunLedger(runId, VAL, REV, ['get_map'], RUN_LIMITS));
  if (!l.ok) throw new Error('lease');
  return l.lease.ledger;
};
const started = (l: RunLedger, rid: number): LedgerEntry => {
  const a = l.admit(rid, 'get_map', '{}');
  if (a.kind !== 'dispatch') throw new Error(`not dispatched: ${a.kind}`);
  return a.entry;
};
const pending = async (p: Promise<void>): Promise<boolean> => { let done = false; void p.then(() => { done = true; }); await new Promise((r) => setTimeout(r, 5)); return !done; };

describe('SessionScheduler.whenClientGone', () => {
  it('no run: resolves at once', async () => { await new SessionScheduler().whenClientGone(); });
  it('stops admission first, and asks nothing to cancel', async () => {
    const s = new SessionScheduler();
    const l = lease(s);
    const a = started(l, 1);
    const gone = s.whenClientGone();
    expect(l.ended).toBe(true);
    expect(l.admit(2, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'draining', cancelRequested: false });
    expect(await pending(gone)).toBe(true);
    l.settle(a, { kind: 'ok', text: '{}', observedBytes: 2 });
    await gone;
  });
  it('waits for the last of two: it follows the change signal, not a reading', async () => {
    const s = new SessionScheduler();
    const l = lease(s);
    const [a, b] = [started(l, 1), started(l, 2)];
    const gone = s.whenClientGone();
    l.settle(a, { kind: 'ok', text: '{}', observedBytes: 2 });
    expect(await pending(gone)).toBe(true);
    l.settle(b, { kind: 'unknown' });
    await gone;
  });
  it('an unknown call does not wait: it is terminal in the ledger, and the lease stays held', async () => {
    const s = new SessionScheduler();
    const l = lease(s);
    l.settle(started(l, 1), { kind: 'unknown' });
    await s.whenClientGone();
    expect(s.holder).not.toBeNull();
  });
  it('a helper still running is not waited for: only calls are', async () => {
    const s = new SessionScheduler();
    const l = lease(s);
    expect(l.snapshot().lifecycleClosed).toBe(false);
    await s.whenClientGone();
  });
  it('a count that never reaches 0 never resolves: there is no timer', async () => {
    const s = new SessionScheduler();
    started(lease(s), 1);
    expect(await pending(s.whenClientGone())).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('exitWhenClientGone', () => {
  const pipes = () => ({ stdin: new EventEmitter(), stdout: new EventEmitter() });
  const never = { whenClientGone: () => new Promise<void>(() => undefined) };
  it('nothing happens until the client goes', () => {
    const { stdin, stdout } = pipes();
    const whenClientGone = vi.fn(async () => undefined);
    exitWhenClientGone(stdin as never, stdout as never, { whenClientGone }, () => undefined);
    expect(whenClientGone).not.toHaveBeenCalled();
  });
  it.each(['end', 'close'])('on %s: asks the scheduler once, even when both come, and exits only when it answers', async (first) => {
    const { stdin, stdout } = pipes();
    let answer!: () => void;
    const whenClientGone = vi.fn(() => new Promise<void>((r) => { answer = r; }));
    const exit = vi.fn();
    exitWhenClientGone(stdin as never, stdout as never, { whenClientGone }, exit);
    stdin.emit(first);
    stdin.emit(first === 'end' ? 'close' : 'end');
    expect(whenClientGone).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(exit).not.toHaveBeenCalled();
    answer();
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); });
  });
  it.each(['end', 'close'])('%s alone is enough: a stream that errors closes with no end', async (only) => {
    const { stdin, stdout } = pipes();
    const exit = vi.fn();
    exitWhenClientGone(stdin as never, stdout as never, { whenClientGone: async () => undefined }, exit);
    stdin.emit(only);
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); });
  });
  it('a write to the closed pipe does not end the process: the error has a listener', () => {
    const { stdin, stdout } = pipes();
    exitWhenClientGone(stdin as never, stdout as never, never, () => undefined);
    expect(() => stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });
});
