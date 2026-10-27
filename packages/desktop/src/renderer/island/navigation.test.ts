import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { IslandRequest } from './requests.js';
import {
  consentNavigationKey, feedNavigationKey, movePendingSelection, pendingNavigation,
  reconcilePendingNavigation, roomNavigationKey, type PendingNavigationItem,
  pendingKeyCommand, pendingRoomNavigation,
} from './navigation.js';

const ref: SessionRef = { projectPath: '/project', workId: 'work', sessionId: 'session' };
const feed = (key: string, card: IslandRequest['card'] = null): IslandRequest => ({ key, ref, card, summary: 'pending', inWindow: true,
  since: 0, deciding: false, note: null });
const room = (roomId: string, proposalKey = roomId): PendingNavigationItem => pendingRoomNavigation([{
  kind: 'room', key: roomId, projectPath: '/project', workId: 'work', roomId, done: false, proposal: { key: proposalKey },
}])[0]!;

describe('pending navigation queue', () => {
  it('orders consents before feed and rooms with stable, namespaced keys', () => {
    const queue = pendingNavigation([{ id: 'c-1' }], [feed('f-1'), feed('f-2')], [room('r-1')]);
    expect(queue.items.map(({ key, kind }) => [key, kind])).toEqual([
      [consentNavigationKey('c-1'), 'consent'], [feedNavigationKey('f-1'), 'feed'],
      [feedNavigationKey('f-2'), 'feed'], [roomNavigationKey('r-1'), 'room'],
    ]);
    expect(queue.selectedKey).toBe(consentNavigationKey('c-1'));
  });

  it('includes only open rooms with proposals and keys a revision by proposal identity', () => {
    const rooms = pendingRoomNavigation([
      { kind: 'room', key: 'ordinary', projectPath: '/project', workId: 'work', roomId: 'ordinary', done: false },
      { kind: 'room', key: 'pending', projectPath: '/project', workId: 'work', roomId: 'pending', done: false, proposal: { key: 'proposal:rev-7' } },
      { kind: 'room', key: 'done', projectPath: '/project', workId: 'work', roomId: 'done', done: true, proposal: { key: 'proposal:rev-8' } },
    ]);
    expect(rooms.map((item) => item.key)).toEqual([roomNavigationKey('proposal:rev-7')]);
  });

  it('preserves selection through reorder, chooses the next item when removed, and handles a new room revision', () => {
    const original = pendingNavigation([], [feed('f-1'), feed('f-2')], [room('r-1', 'proposal:r-1:rev1')]);
    const selected = { ...original, selectedKey: feedNavigationKey('f-2') };
    const reordered = pendingNavigation([], [feed('f-2'), feed('f-1')], [room('r-1', 'proposal:r-1:rev1')]);
    expect(reconcilePendingNavigation(selected, reordered.items).selectedKey).toBe(feedNavigationKey('f-2'));
    const removed = pendingNavigation([], [feed('f-1')], [room('r-1', 'proposal:r-1:rev1')]);
    expect(reconcilePendingNavigation(selected, removed.items).selectedKey).toBe(roomNavigationKey('proposal:r-1:rev1'));
    const revised = pendingNavigation([], [feed('f-1')], [room('r-1', 'proposal:r-1:rev2')]);
    expect(reconcilePendingNavigation({ ...removed, selectedKey: roomNavigationKey('proposal:r-1:rev1') }, revised.items).selectedKey)
      .toBe(roomNavigationKey('proposal:r-1:rev2'));
  });

  it('wraps arrow movement, leaves repeat coalescing to one keydown, and handles an empty queue', () => {
    const state = pendingNavigation([], [feed('f-1'), feed('f-2')], [room('r-1', 'proposal:r-1')]);
    expect(movePendingSelection(state, 1).selectedKey).toBe(feedNavigationKey('f-2'));
    expect(movePendingSelection({ ...state, selectedKey: roomNavigationKey('proposal:r-1') }, 1).selectedKey).toBe(feedNavigationKey('f-1'));
    expect(movePendingSelection(state, -1).selectedKey).toBe(roomNavigationKey('proposal:r-1'));
    expect(pendingNavigation([], [], [])).toEqual({ items: [], selectedKey: null });
  });

  it('gives only feed and room entries targets; a consent without work/session identity has no target', () => {
    const question = { kind: 'question', cardId: 'q-1' } as IslandRequest['card'];
    const queue = pendingNavigation([{ id: 'c-1', requestedBy: { source: 'launch' } }],
      [feed('f-question', question), feed('f-terminal')], [room('r-1')]);
    expect(queue.items[0]?.target).toBeUndefined();
    expect(queue.items[1]?.target).toEqual({ kind: 'session', ref, cardId: 'q-1' });
    expect(queue.items[2]?.target).toEqual({ kind: 'session', ref, view: 'terminal' });
    expect(queue.items[3]?.target).toEqual({ kind: 'room', projectPath: '/project', workId: 'work', roomId: 'r-1' });
  });

  it('ignores editable fields, IME and repeated keydown while preserving native Enter/Space activation', () => {
    const key = (patch: Partial<Parameters<typeof pendingKeyCommand>[0]>) => pendingKeyCommand({
      key: 'ArrowDown', ctrlKey: false, isComposing: false, repeat: false, editable: false, ...patch,
    });
    expect(key({})).toBe('next');
    expect(key({ key: 'ArrowUp' })).toBe('previous');
    expect(key({ editable: true })).toBeNull();
    expect(key({ key: 'Escape', editable: true })).toBe('escape');
    expect(key({ isComposing: true })).toBeNull();
    expect(key({ repeat: true })).toBeNull();
    expect(key({ key: 'Enter', ctrlKey: true })).toBe('open');
    expect(key({ key: 'Escape' })).toBe('escape');
    expect(key({ key: 'Enter' })).toBeNull();
    expect(key({ key: ' ' })).toBeNull();
  });
});
