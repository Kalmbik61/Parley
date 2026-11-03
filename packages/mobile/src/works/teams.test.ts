import { describe, expect, it } from 'vitest';
import type { RemoteRoom, RemoteSession } from '@parley/protocol/remote';
import type { WorkRow } from '@parley/remote-client';
import { buildTeams, headLook, subtreeOf, teamLine } from './teams';

const sess = (id: string): RemoteSession => ({
  id, label: id, provider: 'claude', model: null, role: null, parent: null, createdBy: null,
  lifecycle: 'active', result: null, stuck: null, lastEvent: null, startedAt: null, resultAt: null,
});
const row = (id: string, depth: number, parent: string | null): WorkRow => ({ kind: 'session', session: sess(id), depth, parent, attention: 'idle', live: null });
const room = (id: string, depth: number, parent: string | null, members: string[]): WorkRow => ({
  kind: 'room', room: { id, title: id, members, lead: null, ownerId: parent, mode: 'free', archived: false, proposal: null, messages: null } as RemoteRoom,
  depth, parent, members: members.map(sess), sessions: members.map(sess), archived: false,
});
const needs = { session: (s: RemoteSession) => s.id === 'w', room: () => false };

describe('buildTeams', () => {
  it('cuts rows into teams by parent and counts agents, rooms, waiting', () => {
    const rows = [row('a', 0, null), room('r1', 1, 'a', ['m1', 'm2']), row('b', 1, 'a'), row('c', 0, null), row('w', 0, null)];
    const teams = buildTeams(rows, needs);
    expect(teams.map((t) => t.id)).toEqual(['a', 'c', 'w']);
    expect(teams[0]!.counts).toEqual({ agents: 4, rooms: 1, swarms: 0 });
    expect(teams[0]!.single).toBe(false);
    expect(teams[1]!.single).toBe(true);
    expect(teams[2]!.needsYou).toBe(1);
    expect(teamLine(teams[0]!.counts)).toBe('Team · 4 agents · 1 room');
  });
  it('shows three levels and links the rest to the last shown session', () => {
    const rows = [row('a', 0, null), row('b', 1, 'a'), row('c', 2, 'b'), row('d', 3, 'c'), row('e', 4, 'd')];
    const [t] = buildTeams(rows, needs);
    expect(t!.children.map((x) => x.row.kind === 'session' && x.row.session.id)).toEqual(['b', 'c']);
    expect(t!.more).toEqual({ count: 2, underSessionId: 'c', underLabel: 'c' });
    expect(t!.counts.agents).toBe(5);
  });
  it('subtreeOf returns descendants with relative depth', () => {
    const rows = [row('a', 0, null), row('b', 1, 'a'), row('c', 2, 'b'), row('x', 0, null)];
    expect(subtreeOf(rows, 'a').map((x) => [x.row.kind === 'session' && x.row.session.id, x.depth])).toEqual([['b', 1], ['c', 2]]);
    expect(subtreeOf(rows, 'zz')).toEqual([]);
  });
});

describe('a room nobody owns (A35a)', () => {
  // The human's case: "тест" with `creator: human`, `ownerId: null`, lead s-02, members s-01 and s-02, both top-level.
  const rows = [row('s-01', 0, null), row('s-02', 0, null), room('r-1', 0, null, ['s-01', 's-02'])];
  it('is a team head of its own, and the head is looked at as a room that opens the room screen', () => {
    const teams = buildTeams(rows, needs);
    expect(teams.map((t) => t.id)).toEqual(['s-01', 's-02', 'r-1']);
    const head = teams[2]!.head;
    expect(head.kind).toBe('room');
    expect(headLook(head)).toEqual({ kind: 'room', roomId: 'r-1' });
    expect(teams[2]!.single).toBe(false);
    expect(teams[2]!.counts).toEqual({ agents: 2, rooms: 1, swarms: 0 });
    // The two members stay session rows of their own.
    expect(teams.slice(0, 2).map((t) => headLook(t.head).kind)).toEqual(['session', 'session']);
  });
  it('a swarm nobody owns is looked at as a swarm', () => {
    const swarm = { kind: 'swarm', swarm: { id: 'sw-1', tag: 'T', creator: { kind: 'human' }, queen: 'q', members: [], status: 'running', createdAt: 'x', endedAt: null, seenAt: null }, depth: 0, parent: null, members: [] } as unknown as WorkRow;
    expect(headLook(buildTeams([swarm], needs)[0]!.head)).toEqual({ kind: 'swarm', swarmId: 'sw-1' });
  });
});
