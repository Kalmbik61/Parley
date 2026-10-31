import { describe, expect, it } from 'vitest';
import { initialRemoteState, workKeyOf, type RemoteState } from '@parley/remote-client';
import { selectLetters } from './letters-model';

const msg = (id: string, at: string, read = false) =>
  ({ id, roomId: null, from: 'Greta', to: ['human'], at, text: id, kind: 'note', readBy: read ? { human: at } : {} }) as never;

describe('selectLetters', () => {
  const state: RemoteState = {
    ...initialRemoteState(),
    snapshot: { works: [{ projectPath: '/p', id: 'w', title: 'Work' }] } as never,
    letters: { [workKeyOf('/p', 'w')]: { a: msg('a', '2026-01-01T10:00:00Z'), b: msg('b', '2026-01-02T10:00:00Z'), c: msg('c', '2026-01-03T10:00:00Z', true) } },
  };
  it('unread first, newest first', () => {
    expect(selectLetters(state).map((r) => r.message.id)).toEqual(['b', 'a', 'c']);
  });
  it('a letter opened on the phone sinks but stays', () => {
    const rows = selectLetters(state, new Set(['b']));
    expect(rows.map((r) => [r.message.id, r.unread])).toEqual([['a', true], ['c', false], ['b', false]]);
  });
});
