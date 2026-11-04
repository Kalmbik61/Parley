// A43: the window's side of the parity fixture shared with the phone (remote-client/test/fixtures/card-parity.json):
// `cardRows`, `archivedRows` and the closed count on one map. The phone's side: remote-client test/window-parity.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WindowWorkMap } from '@parley/core';
import { treeOrder } from '../lib/tree-order.js';
import { archivedRows, cardRows, type CardRow } from './sort.js';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../../remote-client/test/fixtures/card-parity.json'), 'utf8'));
const map = fixture.map as WindowWorkMap;

const sig = (r: CardRow): string => {
  const id = r.kind === 'session' ? r.session.id : r.kind === 'room' ? r.room.id : r.swarm.id;
  const members = r.kind === 'room' ? `[${r.members.map((m) => m.id).join(',')}]` : '';
  return `${r.kind}:${id}${members}@${r.depth}^${r.parent}`;
};

describe('card parity fixture (window side)', () => {
  for (const showClosed of [false, true]) {
    it(`cardRows and archivedRows, showClosed=${showClosed}`, () => {
      const want = fixture.expected[String(showClosed)];
      expect(cardRows(map, showClosed).map(sig)).toEqual(want.rows);
      expect(archivedRows(map, showClosed).map((r) => `${r.room.id}[${r.sessions.map((m) => m.id).join(',')}]`)).toEqual(want.archived);
    });
  }

  it('closed count of the card', () => {
    expect(treeOrder(map.sessions).filter(({ session }) => session.lifecycle === 'closed').length).toBe(fixture.expected.closedCount);
  });
});
