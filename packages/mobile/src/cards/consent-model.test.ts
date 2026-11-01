import { describe, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import type { DecideConsentOutcome, RemoteClient } from '@parley/remote-client';
import { createApprove, type LocalAuth } from '../auth/approve';
import { pendingConsents, runConsent, switchText, trustRequestedBy, trustTitle } from './consent-model';

const auth = (ok: boolean) => ({ authenticateAsync: vi.fn<LocalAuth['authenticateAsync']>(async () => (ok ? { success: true } : { success: false, error: 'user_cancel' })) });
const trust: ConsentCard = { id: 'c-1', kind: 'folder-trust', projectPath: '/p', folder: '/Users/me/parley', at: '2026-11-01T10:00:00.000Z', state: 'pending', requestedBy: { source: 'agent', label: 'Task1-types' } };
const swit: ConsentCard = { id: 'c-2', kind: 'agent-switch', projectPath: '/p', at: '2026-11-01T11:00:00.000Z', state: 'pending', ref: { projectPath: '/p', workId: 'w', sessionId: 's' }, provider: 'codex', providerLabel: 'Codex', model: null, reason: 'Usage limit', requestedBy: { sessionId: 's', label: 'Greta' } };
const client = (o: DecideConsentOutcome = { outcome: 'applied' }) => ({ decideConsent: vi.fn(async () => o) });
const as = (c: ReturnType<typeof client>) => c as unknown as RemoteClient;

describe('consent cards', () => {
  it('Allow asks Face ID (even with the toggle off); cancel sends nothing', async () => {
    const a = auth(true);
    const c = client();
    const ui = await runConsent(as(c), createApprove({ auth: a, isRequired: () => false }), trust, 'allow');
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(ui).toEqual({ kind: 'allowed', text: 'Allowed — the agent starts now' });
    expect(c.decideConsent).toHaveBeenCalledWith('c-1', 'allow');

    const c2 = client();
    expect(await runConsent(as(c2), createApprove({ auth: auth(false), isRequired: () => true }), trust, 'allow')).toEqual({ kind: 'cancelled', reason: 'cancelled' });
    expect(c2.decideConsent).not.toHaveBeenCalled();
  });

  it('Deny does not ask', async () => {
    const a = auth(false);
    const c = client();
    expect(await runConsent(as(c), createApprove({ auth: a, isRequired: () => true }), swit, 'deny')).toEqual({ kind: 'denied', text: 'Denied' });
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    expect(c.decideConsent).toHaveBeenCalledWith('c-2', 'deny');
  });

  it('outcomes: stale, lost (gone / still pending), rejected', async () => {
    const ok = createApprove({ auth: auth(true), isRequired: () => true });
    expect(await runConsent(as(client({ outcome: 'stale' })), ok, trust, 'deny')).toEqual({ kind: 'already-answered' });
    expect(await runConsent(as(client({ outcome: 'lost', stillPending: false })), ok, trust, 'deny')).toEqual({ kind: 'no-longer-pending' });
    expect(await runConsent(as(client({ outcome: 'lost', stillPending: true })), ok, trust, 'deny')).toEqual({ kind: 'unconfirmed' });
    expect(await runConsent(as(client({ outcome: 'rejected', code: 'unknown_method', message: 'off' })), ok, trust, 'deny')).toEqual({ kind: 'error', text: 'off' });
    expect(await runConsent(as(client()), ok, swit, 'allow')).toEqual({ kind: 'allowed', text: 'Allowed — continuing on Codex' });
  });

  it('words and ordering', () => {
    expect(trustTitle(trust as never)).toBe('Trust parley for agents?');
    expect(trustRequestedBy(trust as never)).toBe('Requested by Task1-types · create_session');
    expect(switchText('Greta', 'S', 'Codex', 'Usage limit')).toBe('Greta asks to continue S on Codex: Usage limit. Allow stops S now and continues it there.');
    expect(pendingConsents([trust, swit, { ...trust, id: 'c-3', state: 'allowed' }]).map((c) => c.id)).toEqual(['c-2', 'c-1']);
  });
});
