// A43: the phone's rows of one work follow the window's `cardRows` / `archivedRows` / `isSwarmShown` on one map.
import { describe, expect, it } from 'vitest';
import { createRemoteStore, selectWork, selectWorks, type WorkRow } from '../src/index.js';
import { PROJECT, room, session, snap, work } from './fixtures.js';

const swarm = (id: string, status: 'running' | 'done' | 'cancelled' | 'failed', seenAt: string | null) => ({
  id,
  tag: id,
  creator: { kind: 'session' as const, sessionId: 'lead' },
  queen: 'q',
  members: [{ sessionId: 'q', role: 'queen' as const, n: 0, handedAt: null }],
  status,
  createdAt: '2026-10-31T09:00:00.000Z',
  endedAt: status === 'running' ? null : '2026-10-31T09:30:00.000Z',
  seenAt,
});

const closed = (id: string, over = {}) => session(id, { lifecycle: 'closed', ...over });

const map = () =>
  work('w-1', {
    sessions: [
      session('lead'),
      session('worker', { createdBy: 'lead' }),
      closed('old', { createdBy: 'lead' }),
      closed('anchor', { createdBy: 'lead' }),
      closed('member-closed'),
      session('member-open'),
      session('arch-active'),
      session('arch-sleeping', { lifecycle: 'sleeping' }),
      closed('q'),
    ],
    rooms: [
      room('r-open', { ownerId: 'anchor', members: ['anchor', 'member-closed', 'member-open'] }),
      room('r-arch', { archived: true, ownerId: null, members: ['arch-active', 'arch-sleeping'] }),
    ],
    swarms: [swarm('sw-cancelled', 'cancelled', null), swarm('sw-seen', 'done', '2026-10-31T10:00:00.000Z'), swarm('sw-unseen', 'done', null), swarm('sw-run', 'running', null)],
  });

const state = (w = map()) => {
  const store = createRemoteStore();
  store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
  store.dispatch({ t: 'snapshot', snapshot: snap(1, [w]) });
  return store.getState();
};
const ref = { projectPath: PROJECT, workId: 'w-1' };
const ids = (rows: WorkRow[]): string[] => rows.map((r) => (r.kind === 'session' ? r.session.id : r.kind === 'room' ? r.room.id : r.swarm.id));

describe('A43: work rows hide closed and archived like the window', () => {
  const view = (showClosed: boolean) => selectWork(state(), ref, { showClosed })!;

  it('by default: closed sessions hidden, closed anchor of an open room stays, finished swarms by isSwarmShown', () => {
    const v = view(false);
    const rows = ids(v.rows);
    expect(rows).toEqual(expect.arrayContaining(['lead', 'worker', 'anchor', 'r-open', 'arch-active', 'sw-unseen', 'sw-run']));
    expect(rows).not.toContain('old');
    expect(rows).not.toContain('member-closed');
    expect(rows).not.toContain('sw-cancelled');
    expect(rows).not.toContain('sw-seen');
    // An archived room: the active member is an ordinary row, the sleeping one is not; the room itself is under the link.
    expect(rows).not.toContain('arch-sleeping');
    expect(rows).not.toContain('r-arch');
    expect(v.archivedRooms.map((r) => r.room.id)).toEqual(['r-arch']);
  });

  it('a closed room member is not in the open room row, an open one is', () => {
    const r = view(false).rows.find((x) => x.kind === 'room' && x.room.id === 'r-open');
    expect(r?.kind === 'room' && r.members.map((m) => m.id)).toEqual(['member-open']);
    const all = view(true).rows.find((x) => x.kind === 'room' && x.room.id === 'r-open');
    expect(all?.kind === 'room' && all.members.map((m) => m.id)).toEqual(['anchor', 'member-closed', 'member-open']);
  });

  it('"N more closed" counts all closed sessions; expanding puts them back and cancelled/seen swarms too', () => {
    expect(view(false).closedCount).toBe(view(true).closedCount);
    // old, anchor, member-closed, q
    expect(view(false).closedCount).toBe(4);
    const rows = ids(view(true).rows);
    expect(rows).toEqual(expect.arrayContaining(['old', 'sw-cancelled', 'sw-seen']));
  });

  it('with no closed sessions there is nothing to count', () => {
    const w = work('w-1', { sessions: [session('a')] });
    expect(selectWork(state(w), ref)!.closedCount).toBe(0);
  });

  it('an archived work still resolves, with or without showClosed', () => {
    const w = { ...map(), status: 'archived' as const };
    const s = state(w);
    expect(selectWork(s, ref)?.work.id).toBe('w-1');
    expect(selectWork(s, ref, { showClosed: true })?.work.id).toBe('w-1');
    expect(selectWorks(s).flatMap((g) => g.works)).toEqual([]);
    expect(selectWork(s, { projectPath: PROJECT, workId: 'nope' })).toBeNull();
  });
});
