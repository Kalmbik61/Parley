import { describe, expect, it } from 'vitest';
import { createRemoteStore, selectInbox, selectNeedsYouCount, sessionKey, workKeyOf } from '../src/index.js';
import { PROJECT, activityItem, live, permissionCard, proposal, ref, room, session, snap, work } from './fixtures.js';

describe('Inbox', () => {
  it('на фикстуре даёт ожидаемый список и порядок (новые сверху)', () => {
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({
      t: 'snapshot',
      snapshot: snap(1, [
        work('w-1', {
          title: 'Улучшайзинг',
          messages: { direct: { total: 1, unread: 1 }, inline: 0 },
          sessions: [session('s-1'), session('s-2'), session('s-3'), session('s-4', { lifecycle: 'closed' })],
          rooms: [
            room('r-1', { title: 'Stage A', proposal: proposal('p-1', 2, 'Ship A1', '2026-10-31T10:05:00.000Z') }),
            room('r-2', { archived: true, proposal: proposal('p-2', 1, 'old') }),
          ],
        }),
      ]),
    });
    store.dispatch({
      t: 'activity.snapshot',
      epoch: 'e1',
      items: [
        activityItem(ref('s-1'), 'blocked'),
        activityItem(ref('s-2'), 'blocked'),
        { ref: ref('s-3'), activity: live('working', { need: null }), metrics: null },
        activityItem(ref('s-4'), 'blocked'),
      ],
    });
    store.dispatch({ t: 'cards.loaded', ref: ref('s-1'), epoch: 'e1', at: 1, items: [permissionCard('c-1', 'pnpm lint', '2026-10-31T10:03:00.000Z')] });
    store.dispatch({
      t: 'mail',
      event: {
        projectPath: PROJECT,
        workId: 'w-1',
        version: 1,
        prevVersion: 0,
        updatedAt: '',
        rooms: [{ roomId: null, prevTop: 0, top: 1, total: 1, lastAt: null, letters: [{ id: 'm-1', roomId: null, from: 's-9', to: ['human'], at: '2026-10-31T10:10:00.000Z', text: 'PR ready', kind: 'note', readBy: {} }] as never, reads: [], deleted: [] }],
        droppedRooms: [],
        unread: { letters: 1, rooms: {} },
      },
    });
    const items = selectInbox(store.getState());
    expect(items.map((i) => [i.kind, i.at])).toEqual([
      ['letter', '2026-10-31T10:10:00.000Z'],
      ['decision', '2026-10-31T10:05:00.000Z'],
      ['card', '2026-10-31T10:03:00.000Z'],
      ['need', expect.any(String)], // s-2: blocked без карточки
    ]);
    const card = items.find((i) => i.kind === 'card');
    expect(card?.kind === 'card' && card.gist).toEqual({ kind: 'run', command: 'pnpm lint' });
    const need = items.find((i) => i.kind === 'need');
    expect(need?.kind === 'need' && need.ref.sessionId).toBe('s-2');
    // Закрытая s-4 и архивная комната в Inbox не попадают.
    expect(items.some((i) => i.kind === 'decision' && i.roomId === 'r-2')).toBe(false);
    // Бейдж: две сессии + одно решение + одно письмо.
    expect(selectNeedsYouCount(store.getState())).toBe(4);
  });

  it('после ответа на карточку сессия без карточек остаётся строкой «нужен ты», пока activity blocked', () => {
    const store = createRemoteStore();
    store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'e1' });
    store.dispatch({ t: 'snapshot', snapshot: snap(1, [work('w-1', { sessions: [session('s-1')] })]) });
    store.dispatch({ t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-1'), 'blocked')] });
    store.dispatch({ t: 'cards.loaded', ref: ref('s-1'), epoch: 'e1', at: 1, items: [] });
    const [item] = selectInbox(store.getState());
    expect(item?.kind === 'need' && item.cardsLoaded).toBe(true);
    expect(sessionKey(ref('s-1'))).toContain('s-1');
    expect(workKeyOf(PROJECT, 'w-1')).toContain('w-1');
  });
});
