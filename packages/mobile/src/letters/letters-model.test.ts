import { describe, expect, it } from 'vitest';
import { initialRemoteState, selectInbox, workKeyOf, type RemoteState } from '@parley/remote-client';
import { lettersSegmentLabel, parseInboxSegment, plainPreview, selectLetters, withoutLetters } from './letters-model';

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

describe('plainPreview', () => {
  it('drops Markdown marks and joins lines', () => {
    expect(plainPreview('## PR #143 is ready\nSee [the PR](https://x.y/z) and `code`\n- **bold** item')).toBe('PR #143 is ready See the PR and code bold item');
  });
});

describe('Inbox segments', () => {
  const state: RemoteState = {
    ...initialRemoteState(),
    snapshot: { works: [{ projectPath: '/p', id: 'w', title: 'Work', status: 'active', sessions: [], rooms: [] }] } as never,
    letters: { [workKeyOf('/p', 'w')]: { a: msg('a', '2026-01-01T10:00:00Z'), c: msg('c', '2026-01-03T10:00:00Z', true) } },
  };
  it('switching: the route param picks the segment, Needs you by default', () => {
    expect(parseInboxSegment(undefined)).toBe('needs-you');
    expect(parseInboxSegment('junk')).toBe('needs-you');
    expect(parseInboxSegment('letters')).toBe('letters');
  });
  it('the segment shows the unread count', () => {
    expect(lettersSegmentLabel(0)).toBe('Letters');
    expect(lettersSegmentLabel(3)).toBe('Letters 3');
  });
  it('letter rows are absent from Needs you but listed (read and unread) in Letters', () => {
    expect(selectInbox(state).some((i) => i.kind === 'letter')).toBe(true);
    expect(withoutLetters(selectInbox(state))).toEqual([]);
    expect(selectLetters(state).map((r) => [r.message.id, r.unread])).toEqual([['a', true], ['c', false]]);
  });
});
