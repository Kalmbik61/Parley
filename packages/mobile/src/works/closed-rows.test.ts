// A43: team counts follow the shown rows — by default and with "N more closed" expanded.
import { describe, expect, it } from 'vitest';
import { createRemoteStore, selectWork } from '@parley/remote-client';
import type { RemoteWork } from '@parley/protocol/remote';
import { archivedLabel, closedLabel, createClosedStore } from './closed-state';
import { buildTeams } from './teams';

const sess = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, provider: 'claude', model: null, role: null, parent: null, createdBy: null,
  lifecycle: 'active', result: null, stuck: null, lastEvent: null, startedAt: null, resultAt: null, ...over,
});
const w = {
  projectPath: '/p', id: 'w1', title: 'T', status: 'active', messages: { direct: null, inline: 0 },
  sessions: [sess('lead'), sess('a', { createdBy: 'lead' }), sess('c1', { createdBy: 'lead', lifecycle: 'closed' }), sess('c2', { createdBy: 'lead', lifecycle: 'closed' })],
  rooms: [], swarms: [],
} as unknown as RemoteWork;

const teams = (showClosed: boolean) => {
  const store = createRemoteStore();
  store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
  store.dispatch({ t: 'snapshot', snapshot: { revision: 1, works: [w] } } as never);
  const view = selectWork(store.getState(), { projectPath: '/p', workId: 'w1' }, { showClosed })!;
  return { view, teams: buildTeams(view.rows, { session: () => false, room: () => false }) };
};

describe('A43: closed rows on the phone', () => {
  it('team counts: shown rows only by default, all when expanded', () => {
    expect(teams(false).teams[0]!.counts.agents).toBe(2);
    expect(teams(true).teams[0]!.counts.agents).toBe(4);
    expect(teams(false).view.closedCount).toBe(2);
  });
  it('labels', () => {
    expect(closedLabel(2, false)).toBe('2 more closed');
    expect(closedLabel(2, true)).toBe('Hide closed');
    expect(archivedLabel(1, false)).toBe('1 archived room');
    expect(archivedLabel(3, true)).toBe('Hide archived rooms');
  });
  it('the expansion is remembered per work', () => {
    const s = createClosedStore();
    s.toggle('a', 'closed');
    expect(s.get('a')).toEqual({ closed: true, archived: false });
    expect(s.get('b')).toEqual({ closed: false, archived: false });
    s.toggle('a', 'closed');
    expect(s.get('a').closed).toBe(false);
  });
});
