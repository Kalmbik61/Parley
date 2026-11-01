import { describe, expect, it } from 'vitest';
import { createRemoteStore, isSwarmShown, selectWorks, type WorkRow } from '../src/index.js';
import { activityItem, ref, room, session, snap, work } from './fixtures.js';

const swarm = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tag: 'Audit',
  creator: { kind: 'session' as const, sessionId: 's-1' },
  queen: 's-q',
  members: [
    { sessionId: 's-q', role: 'queen' as const, n: 0, handedAt: null },
    { sessionId: 's-d', role: 'drone' as const, n: 1, handedAt: null },
  ],
  status: 'running' as const,
  createdAt: '2026-10-31T09:00:00.000Z',
  endedAt: null,
  seenAt: null,
  ...over,
});

const label = (r: WorkRow): string =>
  `${r.depth}:${r.kind === 'session' ? r.session.id : r.kind === 'room' ? r.room.id : r.swarm.id}`;

describe('Works view', () => {
  it('сессии под создателем, комнаты под владельцем, рои под создателем; участники роя отдельными строками не идут', () => {
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({
      t: 'snapshot',
      snapshot: snap(1, [
        work('w-1', {
          sessions: [
            session('s-1'),
            session('s-2', { createdBy: 's-1' }),
            session('s-3', { createdBy: 's-2' }),
            session('s-ownerless-child', { createdBy: 's-gone' }),
            session('s-q', { createdBy: 's-1' }),
            session('s-d', { createdBy: 's-1' }),
            session('s-in-room', { createdBy: 's-1' }),
          ],
          rooms: [
            room('r-1', { ownerId: 's-1', members: ['s-in-room'] }),
            room('r-2', { ownerId: null }),
            room('r-arch', { ownerId: 's-1', archived: true }),
          ],
          swarms: [swarm('sw-1'), swarm('sw-room', { creator: { kind: 'room', roomId: 'r-2' }, members: [] }), swarm('sw-human', { creator: { kind: 'human' }, members: [] })],
        }),
      ]),
    });
    const [group] = selectWorks(store.getState());
    expect(group?.name).toBe('proj');
    const view = group?.works[0];
    expect(view?.rows.map(label)).toEqual([
      '0:s-1',
      '1:r-1',
      '1:sw-1',
      '1:s-2',
      '2:s-3',
      '0:s-ownerless-child',
      '0:r-2',
      '1:sw-room',
      '0:sw-human',
    ]);
    // s-in-room стоит участником комнаты r-1, а не строкой; участники роя — в строке роя.
    const roomRow = view?.rows.find((r) => r.kind === 'room' && r.room.id === 'r-1');
    expect(roomRow?.kind === 'room' && roomRow.members.map((s) => s.id)).toEqual(['s-in-room']);
    const swarmRow = view?.rows.find((r) => r.kind === 'swarm' && r.swarm.id === 'sw-1');
    expect(swarmRow?.kind === 'swarm' && swarmRow.members.map((m) => m.member.sessionId)).toEqual(['s-q', 's-d']);
    expect(view?.archivedRooms.map((r) => r.id)).toEqual(['r-arch']);
  });

  it('рои прячутся как isSwarmShown: законченный виден, пока не просмотрен', () => {
    expect(isSwarmShown({ status: 'running', seenAt: null }, false)).toBe(true);
    expect(isSwarmShown({ status: 'done', seenAt: null }, false)).toBe(true);
    expect(isSwarmShown({ status: 'failed', seenAt: null }, false)).toBe(true);
    expect(isSwarmShown({ status: 'done', seenAt: '2026-10-31T10:00:00.000Z' }, false)).toBe(false);
    expect(isSwarmShown({ status: 'cancelled', seenAt: null }, false)).toBe(false);
    expect(isSwarmShown({ status: 'cancelled', seenAt: null }, true)).toBe(true);

    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({
      t: 'snapshot',
      snapshot: snap(1, [work('w-1', { sessions: [session('s-1')], swarms: [swarm('seen', { status: 'done', seenAt: 'x', members: [] }), swarm('new', { status: 'done', members: [] })] })]),
    });
    const ids = (showClosed: boolean) =>
      selectWorks(store.getState(), { showClosed })[0]?.works[0]?.rows.filter((r) => r.kind === 'swarm').map((r) => (r.kind === 'swarm' ? r.swarm.id : ''));
    expect(ids(false)).toEqual(['new']);
    expect(ids(true)).toEqual(['seen', 'new']);
  });

  it('работы: где нужен человек — выше, done и архивные — ниже', () => {
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({
      t: 'snapshot',
      snapshot: snap(1, [
        work('w-1', { title: 'idle', sessions: [session('s-1')] }),
        work('w-2', { title: 'done', status: 'done', sessions: [session('s-2')] }),
        work('w-3', { title: 'needs', sessions: [session('s-3')] }),
        work('w-4', { title: 'arch', status: 'archived' }),
      ]),
    });
    store.dispatch({ t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-3', 'w-3'), 'blocked'), activityItem(ref('s-2', 'w-2'), 'blocked')] });
    const titles = (opts = {}) => selectWorks(store.getState(), opts).flatMap((g) => g.works.map((w) => w.work.title));
    expect(titles()).toEqual(['needs', 'idle', 'done']);
    expect(titles({ showClosed: true })).toEqual(['needs', 'idle', 'done', 'arch']);
  });
});
