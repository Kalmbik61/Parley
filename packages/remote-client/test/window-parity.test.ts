// A43: the phone's rows of a work follow the window on one shared map (fixtures/card-parity.json). The window's side is
// desktop/src/renderer/sidebar/card-parity.test.ts; both check the same expected sequences.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectWorksSnapshot } from '@parley/protocol/remote';
import { createRemoteStore, selectWork, type WorkRow } from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/card-parity.json', import.meta.url), 'utf8'));

const sig = (r: WorkRow): string => {
  const id = r.kind === 'session' ? r.session.id : r.kind === 'room' ? r.room.id : r.swarm.id;
  const members = r.kind === 'room' ? `[${r.members.map((m) => m.id).join(',')}]` : '';
  return `${r.kind}:${id}${members}@${r.depth}^${r.parent}`;
};

const view = (showClosed: boolean) => {
  const store = createRemoteStore();
  store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
  store.dispatch({ t: 'snapshot', snapshot: projectWorksSnapshot({ revision: 1, entries: [{ projectPath: '/p', map: fixture.map }] } as never) } as never);
  return selectWork(store.getState(), { projectPath: '/p', workId: 'w-1' }, { showClosed })!;
};

describe('A43: the phone matches the window on the shared map', () => {
  for (const showClosed of [false, true]) {
    it(`rows and archived rooms, showClosed=${showClosed}`, () => {
      const v = view(showClosed);
      const want = fixture.expected[String(showClosed)];
      expect(v.rows.map(sig)).toEqual(want.rows);
      expect(v.archivedRooms.map((r) => `${r.room.id}[${r.sessions.map((m) => m.id).join(',')}]`)).toEqual(want.archived);
    });
  }

  it('"N more closed" counts all closed sessions in both modes', () => {
    expect(view(false).closedCount).toBe(fixture.expected.closedCount);
    expect(view(true).closedCount).toBe(fixture.expected.closedCount);
  });

  it('hides what the window hides: closed room member, cancelled and seen swarms; keeps closed anchor, unseen done/failed', () => {
    const rows = view(false).rows.map(sig).join(' ');
    expect(rows).toContain('session:anchor@1^lead');
    expect(rows).toContain('room:r-open[m-open]');
    expect(rows).not.toContain('m-closed');
    expect(rows).not.toContain('sw-cancelled');
    expect(rows).not.toContain('sw-seen');
    expect(rows).toContain('sw-unseen-done');
    expect(rows).toContain('sw-unseen-failed');
    // Children of a closed creator go to the top level, with its swarm.
    expect(rows).toContain('session:cc-kid@0^null');
    expect(rows).toContain('swarm:sw-cc@0^null');
    // Archived room: working members (active, pending) stay as rows, sleeping and closed go under the link.
    expect(rows).toContain('session:a-active@0^null');
    expect(rows).toContain('session:a-pending@0^null');
    expect(rows).not.toContain('a-sleeping');
  });
});
