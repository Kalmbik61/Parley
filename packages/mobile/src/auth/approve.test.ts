import { describe, expect, it, vi } from 'vitest';
import type { RemoteClient } from '@parley/remote-client';
import { createApprove, type LocalAuth } from './approve';
import { gatedDecide, gatedResolve } from './gated-actions';

const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
const auth = (ok: boolean) => {
  const authenticateAsync = vi.fn<LocalAuth['authenticateAsync']>(async () => (ok ? { success: true } : { success: false, error: 'user_cancel' }));
  return { authenticateAsync };
};
const gate = (a: LocalAuth, required = true) => createApprove({ auth: a, isRequired: () => required });
const client = () => ({
  decide: vi.fn(async () => ({ outcome: 'applied' as const })),
  resolveProposal: vi.fn(async () => ({ outcome: 'applied' as const })),
});
const asClient = (c: ReturnType<typeof client>) => c as unknown as RemoteClient;

describe('Face ID gate on feed.decide', () => {
  it.each([
    ['Allow', { kind: 'permission', behavior: 'allow' }],
    ['Always', { kind: 'permission', behavior: 'allow', always: true }],
    ['plan manual', { kind: 'plan', choice: 'manual' }],
    ['plan auto-accept', { kind: 'plan', choice: 'auto-accept' }],
  ] as const)('%s asks, then sends', async (_n, decision) => {
    const a = auth(true);
    const c = client();
    const r = await gatedDecide(asClient(c), gate(a), ref, 'c1', decision);
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(a.authenticateAsync.mock.calls[0]![0].disableDeviceFallback).toBe(false);
    expect(c.decide).toHaveBeenCalledWith(ref, 'c1', decision);
    expect(r).toEqual({ cancelled: false, outcome: { outcome: 'applied' } });
  });

  it.each([
    ['Deny', { kind: 'permission', behavior: 'deny' }],
    ['answer', { kind: 'question', answers: { q: 'a' } }],
  ] as const)('%s never asks', async (_n, decision) => {
    const a = auth(false);
    const c = client();
    await gatedDecide(asClient(c), gate(a), ref, 'c1', decision);
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    expect(c.decide).toHaveBeenCalled();
  });

  it('cancel or failure sends nothing and the card stays', async () => {
    const c = client();
    const r = await gatedDecide(asClient(c), gate(auth(false)), ref, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(r).toEqual({ cancelled: true, reason: 'cancelled' });
    expect(c.decide).not.toHaveBeenCalled();
  });

  it('an authentication error counts as cancel', async () => {
    const c = client();
    const a: LocalAuth = { authenticateAsync: async () => { throw new Error('boom'); } };
    expect(await gatedDecide(asClient(c), gate(a), ref, 'c1', { kind: 'plan', choice: 'manual' })).toEqual({ cancelled: true, reason: 'cancelled' });
    expect(c.decide).not.toHaveBeenCalled();
  });

  it('device passcode fallback: not enrolled, success of the passcode sends the call', async () => {
    // iOS answers `authenticateAsync` with the passcode screen when nothing is enrolled; the fallback must be allowed.
    const a = auth(true);
    const c = client();
    await gatedDecide(asClient(c), gate(a), ref, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(a.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
    expect(c.decide).toHaveBeenCalledTimes(1);
  });

  it('setting off: Allow without a prompt', async () => {
    const a = auth(false);
    const c = client();
    await gatedDecide(asClient(c), gate(a, false), ref, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    expect(c.decide).toHaveBeenCalled();
  });

  it('asks again on every approval (no reuse window)', async () => {
    const a = auth(true);
    const g = gate(a);
    await g('allow');
    await g('allow');
    expect(a.authenticateAsync).toHaveBeenCalledTimes(2);
  });
});

describe('Face ID gate on rooms.resolveProposal', () => {
  const base = { projectPath: '/p', workId: 'w', roomId: 'r', proposalId: 'p1', rev: 2 };
  it('accept asks and goes with the shown rev', async () => {
    const a = auth(true);
    const c = client();
    await gatedResolve(asClient(c), gate(a), { ...base, action: 'accept' });
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(c.resolveProposal).toHaveBeenCalledWith(expect.objectContaining({ rev: 2, action: 'accept' }));
  });
  it('return for rework never asks', async () => {
    const a = auth(false);
    const c = client();
    await gatedResolve(asClient(c), gate(a), { ...base, action: 'return', note: 'x' });
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    expect(c.resolveProposal).toHaveBeenCalled();
  });
  it('cancelled accept sends nothing', async () => {
    const c = client();
    expect(await gatedResolve(asClient(c), gate(auth(false)), { ...base, action: 'accept' })).toEqual({ cancelled: true, reason: 'cancelled' });
    expect(c.resolveProposal).not.toHaveBeenCalled();
  });
});

describe('turning the setting off', () => {
  it('always asks Face ID, even when the setting is on or off', async () => {
    const a = auth(true);
    await gate(a, false)('disable');
    expect(a.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ promptMessage: 'Confirm to turn off Face ID for approvals', disableDeviceFallback: false }));
  });
  it('cancel keeps it', async () => {
    expect(await gate(auth(false))('disable')).toBe('cancelled');
  });
});

describe('no device passcode', () => {
  it('is told apart from a cancel and still sends nothing', async () => {
    const a: LocalAuth = { authenticateAsync: async () => ({ success: false, error: 'passcode_not_set' }) };
    const c = client();
    const r = await gatedDecide(asClient(c), gate(a), ref, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(r).toEqual({ cancelled: true, reason: 'no-passcode' });
    expect(c.decide).not.toHaveBeenCalled();
  });
});

describe('the "Require Face ID to allow" setting covers approvals only', () => {
  it.each(['launch', 'letter', 'disable'] as const)('%s asks even with the setting off', async (kind) => {
    const a = auth(true);
    expect(await gate(a, false)(kind)).toBe('ok');
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it.each(['allow', 'plan', 'accept'] as const)('%s does not ask with the setting off', async (kind) => {
    const a = auth(false);
    expect(await gate(a, false)(kind)).toBe('ok');
    expect(a.authenticateAsync).not.toHaveBeenCalled();
  });

  it('a launch with the setting off and a cancelled prompt sends nothing', async () => {
    expect(await gate(auth(false), false)('launch')).toBe('cancelled');
    expect(await gate(auth(false), false)('letter')).toBe('cancelled');
  });
});
