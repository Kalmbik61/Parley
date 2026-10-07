import { describe, expect, it } from 'vitest';
import type { MapCompact } from '@parley/core';
import { makeLetter, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { roomUnreadForHuman, workAttention } from './derive.js';

const compact = (unread: MapCompact['unread']): MapCompact => ({
  version: 1,
  messages: { total: 500, included: 1, latestId: 'm-500', rooms: {} },
  unread,
  cut: [],
  omitted: {},
});

describe('внимание по компактной карте (P35)', () => {
  it('непрочитанное в комнатах и прямые письма — точные счётчики хоста, а не письма окна', () => {
    const entry = makeWork('w-01', {
      sessions: [makeSession('s-01', 'план')],
      rooms: [makeRoom('r-01', 'К'), makeRoom('r-02', 'Д')],
      // В окне одно непрочитанное письмо, на деле их 250 в комнате и 3 прямых.
      messages: [makeLetter('m-500', { roomId: 'r-01', to: [], from: 's-01', readBy: {} })],
    });
    const map = { ...entry.map, compact: compact({ letters: 3, rooms: { 'r-01': 250 } }) };
    expect(roomUnreadForHuman(map, 'r-01')).toBe(250);
    expect(roomUnreadForHuman(map, 'r-02')).toBe(0);
    const attention = workAttention({ ...entry, map }, {});
    expect(attention.roomsUnread).toEqual({ 'r-01': 250 });
    expect(attention.humanUnread).toBe(3);
  });

  it('карта без compact (хост до P35) считается по письмам, как прежде', () => {
    const entry = makeWork('w-01', {
      sessions: [makeSession('s-01', 'план')],
      rooms: [makeRoom('r-01', 'К')],
      messages: [
        makeLetter('m-01', { roomId: 'r-01', to: [], from: 's-01', readBy: {} }),
        makeLetter('m-02', { roomId: 'r-01', to: [], from: 's-01', readBy: {} }),
        makeLetter('m-03', { roomId: null, to: ['human'], from: 's-01', readBy: {} }),
      ],
    });
    expect(roomUnreadForHuman(entry.map, 'r-01')).toBe(2);
    expect(workAttention(entry, {}).humanUnread).toBe(1);
  });
});
