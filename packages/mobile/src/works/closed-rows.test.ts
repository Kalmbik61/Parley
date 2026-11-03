// A43: team counts follow the shown rows — by default and with "N more closed" expanded.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectWorksSnapshot } from '@parley/protocol/remote';
import { createRemoteStore, selectWork } from '@parley/remote-client';
import type { RemoteWork } from '@parley/protocol/remote';
import { archivedLabel, closedLabel, createClosedStore } from './closed-state';
import { buildTeams, closedAdded, countRows, subtreeOf } from './teams';

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

  it('team counts on the shared parity map (window rows) by default and expanded', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../remote-client/test/fixtures/card-parity.json'), 'utf8'));
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({ t: 'snapshot', snapshot: projectWorksSnapshot({ revision: 1, entries: [{ projectPath: '/p', map: fixture.map }] } as never) } as never);
    for (const showClosed of [false, true]) {
      const v = selectWork(store.getState(), { projectPath: '/p', workId: 'w-1' }, { showClosed })!;
      const got = buildTeams(v.rows, { session: () => false, room: () => false }).map((t) => `${t.id}:${t.counts.agents}a${t.counts.rooms}r${t.counts.swarms}w`);
      expect(got).toEqual(fixture.expected.teamCounts[String(showClosed)]);
    }
  });

  it('the Team sheet counts like the team header and counts closed only under its session', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../remote-client/test/fixtures/card-parity.json'), 'utf8'));
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({ t: 'snapshot', snapshot: projectWorksSnapshot({ revision: 1, entries: [{ projectPath: '/p', map: fixture.map }] } as never) } as never);
    const ref = { projectPath: '/p', workId: 'w-1' };
    const shown = selectWork(store.getState(), ref)!;
    const all = selectWork(store.getState(), ref, { showClosed: true })!;
    const sheet = (rows: typeof all.rows) => subtreeOf(rows, 'lead').map((x) => x.row);
    // Same as the header of the lead's team ("7a1r3w" by default).
    expect(countRows(sheet(shown.rows), 'lead')).toEqual({ agents: 7, rooms: 1, swarms: 3 });
    // Closed sessions under lead that expanding adds: old, m-closed, cc and its swarm member, the cancelled/seen swarms' queens.
    // The closed anchor of the open room is visible without expanding, so it is not counted.
    expect(closedAdded(sheet(all.rows), sheet(shown.rows))).toBe(6);
    // Other sessions have none under them: no link.
    expect(closedAdded(subtreeOf(all.rows, 'worker').map((x) => x.row), subtreeOf(shown.rows, 'worker').map((x) => x.row))).toBe(0);
  });
});
