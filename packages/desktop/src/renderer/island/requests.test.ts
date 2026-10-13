/** Очередь запросов острова: снимок по переходу в «ждёт», повтор, порядок, собственное решение и «Answered elsewhere». */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ASK_RETRY_MS, ELSEWHERE_MS, useIslandRequests } from './requests.js';

const PROJECT = '/tmp/proj';
const ref = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-1', sessionId });
const entries = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b'), makeSession('s-03', 'c', { provider: 'codex' })] })];

function permission(cardId: string, command = 'rm -rf build'): FeedCard {
  return {
    id: cardId, at: '2026-10-12T10:00:00.000Z', kind: 'permission', cardId, state: 'pending', toolUseId: null,
    toolName: 'Bash', toolInput: { command }, suggestions: [], notified: false,
  };
}

/** Мост: `feed.snapshot` отдаёт карточки по сессии из таблицы, `feed.decide` — по сценарию теста. */
function bridge(cards: Record<string, FeedCard[]>, decide = vi.fn().mockResolvedValue({ applied: true, state: 'allowed' })) {
  const snapshot = vi.fn(async ({ ref: target }: { ref: { sessionId: string } }) => ({
    items: cards[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' as const,
  }));
  const call = vi.fn((method: string, params: never) => (method === 'feed.snapshot' ? snapshot(params) : decide(params)));
  return { call, snapshot, decide };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('очередь запросов острова', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useIslandRequests.getState().clear();
  });
  afterEach(() => {
    useIslandRequests.getState().bind(null);
    vi.useRealTimers();
  });

  it('сессия начала ждать — в очередь все её ждущие карточки; Codex не спрашивается', async () => {
    const { call, snapshot } = bridge({ 's-01': [permission('c-1'), permission('c-2', 'ls')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked'), makeActivity(ref('s-03'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items.map((item) => [item.card.cardId, item.summary])).toEqual([
      ['c-1', 'Run: rm -rf build'],
      ['c-2', 'Run: ls'],
    ]);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('карточки ещё нет — один повтор через 500 мс', async () => {
    const cards: Record<string, FeedCard[]> = {};
    const { call, snapshot } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
    cards['s-01'] = [permission('c-1')];
    await vi.advanceTimersByTimeAsync(ASK_RETRY_MS);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(useIslandRequests.getState().items).toHaveLength(1);
  });

  it('сессия перестала ждать — её карточки уходят', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'working')]));
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('порядок — по времени, когда сессия начала ждать', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')], 's-02': [permission('c-2')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-02'), 'blocked')]));
    await vi.advanceTimersByTimeAsync(10);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-02'), 'blocked'), makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items.map((item) => item.card.cardId)).toEqual(['c-2', 'c-1']);
  });

  it('applied: true — карточка уходит; решение уходит хосту с cardId', async () => {
    const { call, decide } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const [item] = useIslandRequests.getState().items;
    await useIslandRequests.getState().decide(item!.key, { kind: 'permission', behavior: 'allow' });
    expect(decide).toHaveBeenCalledWith({ ref: ref('s-01'), cardId: 'c-1', decision: { kind: 'permission', behavior: 'allow' } });
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('applied: false — «Answered elsewhere», через секунду уходит; кнопки не висят', async () => {
    const decide = vi.fn().mockResolvedValueOnce({ applied: false, state: 'elsewhere' });
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'deny' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'elsewhere' });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_MS);
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('applied: false при state: pending — хук ещё не удержан: «failed», карточка остаётся и после секунды', async () => {
    const decide = vi.fn().mockResolvedValueOnce({ applied: false, state: 'pending' });
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'allow' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'failed' });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_MS);
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'failed' });
  });

  it('not_found — тоже «Answered elsewhere»', async () => {
    const decide = vi.fn().mockRejectedValueOnce({ code: 'not_found', message: 'no such card' });
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'allow' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'elsewhere' });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_MS);
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('ошибка сети — «failed», карточка остаётся, кнопки снова доступны', async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error('socket closed'));
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'allow' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'failed' });
  });

  it('clear — очередь и ожидания пусты (хост отключился)', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().clear();
    expect(useIslandRequests.getState()).toMatchObject({ items: [], index: 0, waitingSince: {} });
    expect(refKey(ref('s-01')) in useIslandRequests.getState().waitingSince).toBe(false);
  });
});
