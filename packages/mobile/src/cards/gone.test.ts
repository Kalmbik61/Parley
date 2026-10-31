import { describe, expect, it } from 'vitest';
import { initialRemoteState } from '@parley/remote-client';
import { demoSnapshot } from '../dev/demo';
import { goneEntries } from './gone';

describe('goneEntries', () => {
  it('names the session and work of a card answered at the Mac', () => {
    const state = {
      ...initialRemoteState(),
      snapshot: demoSnapshot,
      gone: { k: { sessionKey: '/Users/me/parley\u0000w1\u0000d1', cardId: 'c', card: {} as never, at: 1 } },
    };
    expect(goneEntries(state)).toMatchObject([{ key: 'k', sessionLabel: 'Mobile-D1-designer', workTitle: 'Improvements' }]);
  });
  it('falls back when the snapshot lacks the session', () => {
    const state = { ...initialRemoteState(), gone: { k: { sessionKey: 'p\u0000w\u0000s', cardId: 'c', card: {} as never, at: 1 } } };
    expect(goneEntries(state)).toMatchObject([{ sessionLabel: 'Session', workTitle: '' }]);
  });
});
