import { describe, expect, it, vi } from 'vitest';
import type { RemoteClient, SendMessageOutcome } from '@parley/remote-client';
import { createApprove, type LocalAuth } from '../auth/approve';
import { composerMode, messageProblem, sendToAgent, sizeCounter, uiOfSend, type ComposerFacts } from './send';

const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
const auth = (ok: boolean) => ({ authenticateAsync: vi.fn<LocalAuth['authenticateAsync']>(async () => (ok ? { success: true } : { success: false, error: 'user_cancel' })) });
const sendOk = (over: Partial<Extract<SendMessageOutcome, { outcome: 'sent' }>> = {}): SendMessageOutcome => ({ outcome: 'sent', clientMsgId: 'k-12345678', inserted: true, submitted: true, reason: null, ...over });
const client = (o: SendMessageOutcome = sendOk()) => ({ sendMessage: vi.fn(async () => o) });
const as = (c: ReturnType<typeof client>) => c as unknown as RemoteClient;

describe('Face ID on every send', () => {
  it('asks even when "Require Face ID to allow" is off, then sends', async () => {
    const a = auth(true);
    const c = client();
    const r = await sendToAgent(as(c), createApprove({ auth: a, isRequired: () => false }), ref, 'go');
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(a.authenticateAsync.mock.calls[0]![0].promptMessage).toBe('Confirm to message the agent');
    expect(r).toMatchObject({ cancelled: false, outcome: { outcome: 'sent' } });
    expect(c.sendMessage).toHaveBeenCalledWith({ ref, text: 'go' });
  });

  it('cancelled → nothing is sent', async () => {
    const c = client();
    const r = await sendToAgent(as(c), createApprove({ auth: auth(false), isRequired: () => true }), ref, 'go');
    expect(r).toEqual({ cancelled: true, reason: 'cancelled' });
    expect(c.sendMessage).not.toHaveBeenCalled();
  });

  it('a retry after lost carries the same clientMsgId', async () => {
    const c = client();
    await sendToAgent(as(c), createApprove({ auth: auth(true), isRequired: () => true }), ref, 'go', 'key-abcdefgh');
    expect(c.sendMessage).toHaveBeenCalledWith({ ref, text: 'go', clientMsgId: 'key-abcdefgh' });
  });
});

describe('outcomes', () => {
  it('sent / queued / typed / unconfirmed', () => {
    expect(uiOfSend(sendOk(), false)).toEqual({ kind: 'sent' });
    expect(uiOfSend(sendOk(), true)).toEqual({ kind: 'queued' });
    expect(uiOfSend(sendOk({ submitted: false, reason: 'draft' }), false).kind).toBe('typed-not-sent');
    expect(uiOfSend({ outcome: 'lost', clientMsgId: 'k' }, false)).toEqual({ kind: 'unconfirmed' });
  });
  it('busy → retry; blocked → text back; no-paste-mode → edit; unknown_method hides the composer', () => {
    expect(uiOfSend(sendOk({ inserted: false, submitted: false, reason: 'busy' }), false)).toMatchObject({ kind: 'failed', retry: true });
    expect(uiOfSend(sendOk({ inserted: false, submitted: false, reason: 'blocked' }), false)).toMatchObject({ kind: 'failed', textBack: true, retry: false });
    expect(uiOfSend(sendOk({ inserted: false, submitted: false, reason: 'no-paste-mode' }), false)).toMatchObject({ kind: 'failed', edit: true });
    expect(uiOfSend({ outcome: 'rejected', code: 'unknown_method', message: '', clientMsgId: 'k' }, false)).toMatchObject({ hideComposer: true, textBack: true });
    expect(uiOfSend({ outcome: 'rejected', code: 'bad_request', message: 'boom', clientMsgId: 'k' }, false)).toMatchObject({ message: 'Not sent — boom', retry: true });
  });
});

describe('text rules', () => {
  it('empty and over 16 KB are refused; the counter shows from 15 KB', () => {
    expect(messageProblem('  ')).not.toBeNull();
    expect(messageProblem('a'.repeat(16 * 1024))).toBeNull();
    expect(messageProblem('a'.repeat(16 * 1024 + 1))).toBe('Too long for one message — 16 KB max');
    expect(sizeCounter('a')).toBeNull();
    expect(sizeCounter('a'.repeat(15 * 1024 + 205))).toBe('15.2 / 16 KB');
  });
});

describe('composerMode', () => {
  const base: ComposerFacts = { hasMethod: true, closed: false, sleeping: false, hasCard: false, blockedNoCard: false, working: false, online: true, limitNote: null, feedReady: true };
  it('table of D1 §9.5', () => {
    expect(composerMode(base)).toEqual({ kind: 'input', sendEnabled: true, note: null });
    expect(composerMode({ ...base, working: true })).toMatchObject({ sendEnabled: true, note: expect.stringContaining('working') });
    expect(composerMode({ ...base, online: false })).toMatchObject({ sendEnabled: false, note: 'Reconnecting — actions are paused' });
    expect(composerMode({ ...base, hasMethod: false }).kind).toBe('hidden');
    expect(composerMode({ ...base, closed: true })).toEqual({ kind: 'hidden', text: 'This session is closed' });
    expect(composerMode({ ...base, sleeping: true }).kind).toBe('hidden');
    expect(composerMode({ ...base, hasCard: true })).toEqual({ kind: 'hidden', text: '' });
    expect(composerMode({ ...base, blockedNoCard: true })).toMatchObject({ sendEnabled: false, note: 'Answer at your Mac first' });
    expect(composerMode({ ...base, feedReady: false })).toMatchObject({ sendEnabled: false });
  });
});
