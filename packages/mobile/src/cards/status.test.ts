import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@parley/protocol/remote';
import { capsuleOf, needReason } from './status';

const session = (patch: Partial<RemoteSession> = {}): RemoteSession => ({
  id: 's', label: 'L', provider: 'claude', model: null, role: null, parent: null, createdBy: null,
  lifecycle: 'active', result: null, stuck: null, lastEvent: null, startedAt: null, resultAt: null, ...patch,
});
const base = { attention: 'idle' as const, need: null, subagents: 0, waitingFor: null, turnEndedAt: null, now: Date.parse('2026-10-31T12:00:00Z') };

describe('capsuleOf (D1 §9.2)', () => {
  it('maps each state', () => {
    expect(capsuleOf({ ...base, session: session(), attention: 'needs-you', need: { kind: 'approval', since: '', detail: null, resetsAt: null, window: null, account: null } }))
      .toMatchObject({ label: 'Needs you', tone: 'needsYou', detail: 'Waiting for your approval' });
    expect(capsuleOf({ ...base, session: session(), attention: 'working', subagents: 2 })).toMatchObject({ label: 'Working', detail: '2 subagents' });
    expect(capsuleOf({ ...base, session: session(), attention: 'working', waitingFor: 's-12' })).toMatchObject({ detail: 'Waiting for s-12' });
    expect(capsuleOf({ ...base, session: session(), turnEndedAt: '2026-10-31T11:57:00Z' })).toMatchObject({ label: 'Idle', detail: 'Finished a turn · 3 min ago' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'sleeping', lastEvent: { event: 'x', at: '2026-10-31T11:00:00Z' } }) })).toMatchObject({ label: 'Sleeping', detail: 'Last active 1 h ago' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'closed', result: 'failed' }) })).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'closed', result: 'done' }) })).toMatchObject({ label: 'Done', tone: 'success' });
  });
  it('needReason words limit and sign-in', () => {
    expect(needReason(null)).toBe('Waiting for you');
    expect(needReason({ kind: 'sign-in', since: '', detail: null, resetsAt: null, window: null, account: 'auth' })).toBe('Signed out of the provider');
    expect(needReason({ kind: 'limit', since: '', detail: null, resetsAt: null, window: 'session', account: null })).toBe('Usage limit reached');
  });
});
