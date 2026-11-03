import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@parley/protocol/remote';
import { sessionKey, type RemoteState } from '@parley/remote-client';
import { capsuleOf, capsuleOfSession, needReason } from './status';

const session = (patch: Partial<RemoteSession> = {}): RemoteSession => ({
  id: 's', label: 'L', provider: 'claude', model: null, role: null, parent: null, createdBy: null,
  lifecycle: 'active', result: null, stuck: null, lastEvent: null, startedAt: null, resultAt: null, ...patch,
});
const base = { attention: 'idle' as const, need: null, subagents: 0, waitingFor: null, turnEndedAt: null, now: Date.parse('2026-10-31T12:00:00Z') };

describe('capsuleOf (D1 §9.2)', () => {
  it('maps each state', () => {
    expect(capsuleOf({ ...base, session: session(), attention: 'needs-you', need: { kind: 'approval', since: '', detail: null, resetsAt: null, window: null, account: null } }))
      .toMatchObject({ label: 'Needs you', detail: 'Waiting for your approval' });
    expect(capsuleOf({ ...base, session: session(), attention: 'working', subagents: 2 })).toMatchObject({ label: 'Working', detail: '2 subagents' });
    expect(capsuleOf({ ...base, session: session(), attention: 'working', waitingFor: 's-12' })).toMatchObject({ detail: 'Waiting for s-12' });
    expect(capsuleOf({ ...base, session: session(), attention: 'unseen', turnEndedAt: '2026-10-31T11:57:00Z' })).toMatchObject({ label: 'Finished a turn', tone: 'unseen', ring: true, detail: '3 min ago' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'pending' }) })).toMatchObject({ label: 'Starting', ring: true, detail: null });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'sleeping', lastEvent: { event: 'x', at: '2026-10-31T11:00:00Z' } }) })).toMatchObject({ label: 'Sleeping', detail: 'Last active 1 h ago' });
  });

  it('idle takes its age from the last hook event, then from the history', () => {
    const lastEvent = { event: 'closed', at: '2026-10-31T09:00:00Z' };
    expect(capsuleOf({ ...base, session: session({ lastEvent }), lastEventAt: '2026-10-31T11:55:00Z' })).toMatchObject({ label: 'Idle', detail: '5 min ago' });
    expect(capsuleOf({ ...base, session: session({ lastEvent }) })).toMatchObject({ label: 'Idle', detail: '3 h ago' });
    expect(capsuleOf({ ...base, session: session() })).toMatchObject({ label: 'Idle', detail: null });
  });

  it('closed and sleeping read as the window: a result says Done/Failed, no result says Closed/Sleeping', () => {
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'closed', result: 'failed' }) })).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'closed', result: 'done', resultAt: '2026-10-31T11:00:00Z' }) })).toMatchObject({ label: 'Done', tone: 'success', detail: '1 h ago' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'closed', lastEvent: { event: 'closed', at: '2026-10-31T11:50:00Z' } }) })).toMatchObject({ label: 'Closed', tone: 'off', icon: 'minus.circle', detail: '10 min ago' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'sleeping', result: 'done' }) })).toMatchObject({ label: 'Done', tone: 'success' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'sleeping', result: 'failed' }) })).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(capsuleOf({ ...base, session: session({ lifecycle: 'sleeping' }) })).toMatchObject({ label: 'Sleeping', tone: 'off' });
  });
});

// The team head, the tree rows, the room menu and the session screen all call `capsuleOfSession`: the words are decided here.
describe('capsuleOfSession (team head, rows, session header)', () => {
  const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const withActivity = (activity: string | null, extra: Record<string, unknown> = {}): RemoteState =>
    ({ activity: activity === null ? {} : { [sessionKey(ref)]: { activity: { activity, subagents: 0, waitingFor: null, turnEndedAt: null, lastEventAt: null, need: null, ...extra } } } }) as unknown as RemoteState;
  const word = (state: RemoteState, s: RemoteSession): string => capsuleOfSession(state, ref, s, NOW).label;

  it('a sleeping, a closed and a not-started lead are not "Idle", even with a stale activity', () => {
    expect(word(withActivity('unseen'), session({ lifecycle: 'sleeping' }))).toBe('Sleeping');
    expect(word(withActivity('working'), session({ lifecycle: 'pending' }))).toBe('Starting');
    expect(word(withActivity('working'), session({ lifecycle: 'closed', result: 'done' }))).toBe('Done');
    expect(word(withActivity(null), session({ lifecycle: 'closed' }))).toBe('Closed');
  });

  it('a sleeping lead that handed in a result reads Done (the window, s-38), not Sleeping', () => {
    expect(word(withActivity('unseen'), session({ lifecycle: 'sleeping', result: 'done' }))).toBe('Done');
  });

  it('a live lead follows the activity: working, finished a turn, needs you, idle', () => {
    expect(word(withActivity('working'), session())).toBe('Working');
    expect(word(withActivity('unseen', { turnEndedAt: '2026-10-31T11:57:00Z' }), session())).toBe('Finished a turn');
    expect(capsuleOfSession(withActivity('unseen', { turnEndedAt: '2026-10-31T11:57:00Z' }), ref, session(), NOW).detail).toBe('3 min ago');
    expect(word(withActivity('blocked', { need: { kind: 'approval', since: '', detail: null, resetsAt: null, window: null, account: null } }), session())).toBe('Needs you');
    expect(word(withActivity('idle'), session())).toBe('Idle');
    expect(capsuleOfSession(withActivity('idle', { lastEventAt: '2026-10-31T11:55:00Z' }), ref, session(), NOW).detail).toBe('5 min ago');
  });
});

describe('needReason', () => {
  it('words limit and sign-in', () => {
    expect(needReason(null)).toBe('Waiting for you');
    expect(needReason({ kind: 'sign-in', since: '', detail: null, resetsAt: null, window: null, account: 'auth' })).toBe('Signed out of the provider');
    expect(needReason({ kind: 'limit', since: '', detail: null, resetsAt: null, window: 'session', account: null })).toBe('Usage limit reached');
  });
});
