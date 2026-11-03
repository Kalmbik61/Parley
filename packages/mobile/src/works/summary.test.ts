import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@parley/protocol/remote';
import type { WorkView } from '@parley/remote-client';
import { elapsed, worksSummary } from './summary';

describe('elapsed', () => {
  const t0 = '2026-10-31T12:00:00Z';
  it('formats mm:ss and h:mm:ss, ends at endedAt, and tolerates bad dates', () => {
    expect(elapsed(t0, null, Date.parse('2026-10-31T12:12:07Z'))).toBe('12:07');
    expect(elapsed(t0, '2026-10-31T13:02:03Z', 0)).toBe('1:02:03');
    expect(elapsed(t0, null, Date.parse('2026-10-31T11:00:00Z'))).toBe('00:00');
    expect(elapsed('nope', null, 0)).toBe('');
  });
});

describe('worksSummary', () => {
  const sess = (id: string, lifecycle: RemoteSession['lifecycle'] = 'active'): RemoteSession => ({
    id, label: id, provider: 'claude', model: null, role: null, parent: null, createdBy: null,
    lifecycle, result: null, stuck: null, lastEvent: null, startedAt: null, resultAt: null,
  });
  const view = (sessions: RemoteSession[], rooms = 1): Pick<WorkView, 'work'> =>
    ({ work: { sessions, rooms: Array.from({ length: rooms }, (_, i) => ({ id: `r${i}`, archived: false })), swarms: [] } }) as unknown as Pick<WorkView, 'work'>;

  it('counts working sessions of the whole work, room members included', () => {
    const v = view([sess('lead'), sess('m1'), sess('m2')]);
    expect(worksSummary(v, (s) => (s.id === 'lead' ? 'idle' : 'working'))).toBe('3 sessions · 1 room · 2 working');
  });
  it('says idle when nobody works', () => {
    expect(worksSummary(view([sess('a')], 0), () => 'unseen')).toBe('1 session · idle');
  });
});
