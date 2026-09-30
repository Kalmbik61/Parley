/**
 * Ведущий комнаты в окне повторяет правило `liveLead` из core (дизайн комнат, 3.1–3.2):
 * назначенный, пока жив; у старой карты — первый из `members`; закрытого или удалённого
 * подменяет первый живой участник, за ним создатель-сессия; в закрытой комнате ведущего нет.
 */

import { describe, expect, it } from 'vitest';
import type { Room } from '@harnas/core';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { roomLiveLead } from './room-lead.js';

function room(patch: Partial<Room>): Room {
  return { ...makeRoom('r-01', 'Refunds'), ...patch };
}

const alive = (id: string) => makeSession(id, id);
const closed = (id: string) => makeSession(id, id, { lifecycle: 'closed' });

describe('roomLiveLead', () => {
  it('назначенный живой ведущий — он', () => {
    const { map } = makeWork('w', { sessions: [alive('s-01'), alive('s-02')] });
    expect(roomLiveLead(map, room({ members: ['s-01', 's-02'], lead: 's-02' }))).toBe('s-02');
  });

  it('старая карта без lead — первый из members', () => {
    const { map } = makeWork('w', { sessions: [alive('s-01'), alive('s-02')] });
    expect(roomLiveLead(map, room({ members: ['s-02', 's-01'], lead: null }))).toBe('s-02');
  });

  it('закрытого ведущего подменяет первый живой участник', () => {
    const { map } = makeWork('w', { sessions: [closed('s-01'), closed('s-02'), alive('s-03')] });
    expect(roomLiveLead(map, room({ members: ['s-02', 's-03'], lead: 's-01' }))).toBe('s-03');
  });

  it('удалённого из карты ведущего подменяет первый живой участник', () => {
    const { map } = makeWork('w', { sessions: [alive('s-03')] });
    expect(roomLiveLead(map, room({ members: ['s-02', 's-03'], lead: 's-02' }))).toBe('s-03');
  });

  it('живых участников нет — ведёт живой создатель-сессия', () => {
    const { map } = makeWork('w', { sessions: [alive('s-01'), closed('s-02')] });
    expect(roomLiveLead(map, room({ creator: 's-01', members: ['s-02'], lead: 's-02' }))).toBe(
      's-01',
    );
  });

  it('закрытая комната — ведущего нет, человек-создатель не в счёт', () => {
    const { map } = makeWork('w', { sessions: [closed('s-01'), closed('s-02')] });
    expect(
      roomLiveLead(map, room({ creator: 'human', members: ['s-01', 's-02'], lead: null })),
    ).toBeNull();
  });
});
