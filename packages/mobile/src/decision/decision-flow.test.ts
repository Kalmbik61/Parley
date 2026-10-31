import { describe, expect, it, vi } from 'vitest';
import type { RemoteClient, ResolveOutcome } from '@parley/remote-client';
import { canSendReturn, hapticFor, submitDecision, type Proposal } from './decision-flow';

const p = (rev: number, text = 'old'): Proposal => ({ id: 'p1', kind: null, from: 's-174', text, rev, at: 'x', planId: null, planRev: null });
const input = { projectPath: '/p', workId: 'w', roomId: 'r', shown: p(2) };
const yes = async () => 'ok' as const;
const mk = (o: ResolveOutcome) => ({ resolveProposal: vi.fn(async () => o) }) as unknown as RemoteClient & { resolveProposal: ReturnType<typeof vi.fn> };

describe('submitDecision', () => {
  it('goes with the shown rev', async () => {
    const c = mk({ outcome: 'applied' });
    expect(await submitDecision(c, yes, { ...input, action: 'accept' })).toEqual({ kind: 'view', view: { kind: 'accepted' } });
    expect(c.resolveProposal).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w', roomId: 'r', proposalId: 'p1', rev: 2, action: 'accept' });
  });
  it('return carries the note', async () => {
    const c = mk({ outcome: 'applied' });
    const r = await submitDecision(c, yes, { ...input, action: 'return', note: 'redo' });
    expect(r).toEqual({ kind: 'view', view: { kind: 'returned' } });
    expect(c.resolveProposal).toHaveBeenCalledWith(expect.objectContaining({ rev: 2, action: 'return', note: 'redo' }));
  });
  it('conflict shows the new text and does not repeat the call', async () => {
    const c = mk({ outcome: 'conflict', proposal: p(3, 'new text') });
    const r = await submitDecision(c, yes, { ...input, action: 'accept' });
    expect(r).toEqual({ kind: 'view', view: { kind: 'pending', shown: p(3, 'new text'), conflict: true } });
    expect(c.resolveProposal).toHaveBeenCalledTimes(1);
  });
  it('conflict with no proposal left → answered elsewhere', async () => {
    const r = await submitDecision(mk({ outcome: 'conflict', proposal: null }), yes, { ...input, action: 'return', note: 'x' });
    expect(r).toEqual({ kind: 'view', view: { kind: 'gone' } });
  });
  it('lost: gone when no longer pending, otherwise unconfirmed', async () => {
    expect(await submitDecision(mk({ outcome: 'lost', stillPending: false }), yes, { ...input, action: 'accept' })).toEqual({ kind: 'view', view: { kind: 'gone' } });
    expect(await submitDecision(mk({ outcome: 'lost', stillPending: null }), yes, { ...input, action: 'accept' })).toEqual({ kind: 'view', view: { kind: 'unconfirmed', shown: p(2) } });
  });
  it('Face ID cancel on accept sends nothing', async () => {
    const c = mk({ outcome: 'applied' });
    expect(await submitDecision(c, async () => 'cancelled', { ...input, action: 'accept' })).toEqual({ kind: 'cancelled', reason: 'cancelled' });
    expect(c.resolveProposal).not.toHaveBeenCalled();
  });
  it('return does not ask Face ID', async () => {
    const approve = vi.fn(async () => 'cancelled' as const);
    await submitDecision(mk({ outcome: 'applied' }), approve, { ...input, action: 'return', note: 'x' });
    expect(approve).not.toHaveBeenCalled();
  });
  it('the note is 1..4000 characters', () => {
    expect(canSendReturn('')).toBe(false);
    expect(canSendReturn('  ')).toBe(false);
    expect(canSendReturn('a'.repeat(4000))).toBe(true);
    expect(canSendReturn('a'.repeat(4001))).toBe(false);
  });
});

describe('hapticFor (D1 §16)', () => {
  it('Accept success, Return/conflict/lost warning, cancelled none', () => {
    expect(hapticFor({ kind: 'view', view: { kind: 'accepted' } })).toBe('success');
    expect(hapticFor({ kind: 'view', view: { kind: 'returned' } })).toBe('warning');
    expect(hapticFor({ kind: 'view', view: { kind: 'pending', shown: p(3), conflict: true } })).toBe('warning');
    expect(hapticFor({ kind: 'view', view: { kind: 'unconfirmed', shown: p(2) } })).toBe('warning');
    expect(hapticFor({ kind: 'cancelled', reason: 'cancelled' })).toBeNull();
  });
});
