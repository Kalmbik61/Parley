/** Очередь запросов острова: снимок по переходу в «ждёт», повтор, порядок, собственное решение и «Answered elsewhere». */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import { activityMap, makeActivity, makeNeed, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ASK_RETRY_SCHEDULE_MS, ELSEWHERE_MS, useIslandRequests } from './requests.js';

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

/** Ответ `feed.snapshot` с заданными карточками. */
const snap = (items: FeedCard[]) => ({ items, revision: 1, mode: null, decisions: 'window' as const });

/** Обещание, которое тест разрешает сам: ответы хоста приходят в нужном порядке. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('очередь запросов острова', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useIslandRequests.getState().clear();
  });
  afterEach(() => {
    useIslandRequests.getState().bind(null);
    vi.useRealTimers();
  });

  it('сессия начала ждать — в очередь карточки и запрос терминала Codex', async () => {
    const { call, snapshot } = bridge({ 's-01': [permission('c-1'), permission('c-2', 'ls')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked'), makeActivity(ref('s-03'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items.filter((item) => item.card !== null).map((item) => [item.card?.cardId, item.summary])).toEqual([
      ['c-1', 'Run: rm -rf build'],
      ['c-2', 'Run: ls'],
    ]);
    expect(useIslandRequests.getState().items.find((item) => item.ref.sessionId === 's-03')).toMatchObject({ card: null, inWindow: false });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledWith({ ref: ref('s-01'), scope: 'attention' });
  });

  // Спека подписок К16: причина «needs you» одна на окно, остров и Telegram — текст из ядра (`needReason`).
  it('Codex с need: переход к терминалу называет причину; без need — прежний «Codex needs your attention»', async () => {
    const { call } = bridge({});
    useIslandRequests.getState().bind(call as never);
    const approval = makeNeed('approval', { detail: 'ls -la' });
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'blocked', { need: approval })]));
    expect(useIslandRequests.getState().items[0]).toMatchObject({
      card: null,
      inWindow: false,
      summary: 'Waiting for your approval: ls -la',
    });

    useIslandRequests.getState().clear();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'blocked')]));
    expect(useIslandRequests.getState().items[0]?.summary).toBe('Codex needs your attention in the terminal');
  });

  it('Codex упёрся в лимит (ход закончен, но need есть) — в острове причина с часом сброса', async () => {
    const { call } = bridge({});
    useIslandRequests.getState().bind(call as never);
    // Час сброса собран из частей по местному времени — набор не зависит от пояса машины.
    const resetsAt = new Date(2026, 9, 21, 16, 27).toISOString();
    vi.setSystemTime(new Date(2026, 9, 21, 13, 0));
    const limit = makeNeed('limit', { resetsAt, window: 'session' });
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'unseen', { need: limit })]));
    expect(useIslandRequests.getState().items[0]?.summary).toBe('Hit its Codex usage limit; resets at 16:27');
  });

  it('карточки ещё нет — первый повтор через 500 мс', async () => {
    const cards: Record<string, FeedCard[]> = {};
    const { call, snapshot } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
    cards['s-01'] = [permission('c-1')];
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(useIslandRequests.getState().items).toHaveLength(1);
  });

  it('Codex: недоступная лента не скрывает действие в терминале и не разрешает его через feed.decide', async () => {
    const { call, snapshot, decide } = bridge({});
    snapshot.mockRejectedValue(new Error('feed unavailable'));
    useIslandRequests.getState().bind(call as never);
    const blocked = activityMap([makeActivity(ref('s-03'), 'blocked')]);
    useIslandRequests.getState().sync(entries, blocked);
    const first = useIslandRequests.getState().items[0]!;
    expect(first).toMatchObject({ ref: ref('s-03'), card: null, inWindow: false });
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    expect(useIslandRequests.getState().items).toEqual([first]);
    await useIslandRequests.getState().decide(first.key, { kind: 'permission', behavior: 'allow' });
    expect(decide).not.toHaveBeenCalled();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'working')]));
    expect(useIslandRequests.getState().items).toEqual([]);
    useIslandRequests.getState().sync(entries, blocked);
    expect(useIslandRequests.getState().items[0]?.key).not.toBe(first.key);
  });

  it('Codex: поздняя карточка заменяет переход к терминалу, а завершение ожидания отменяет поздний ответ', async () => {
    const cards: Record<string, FeedCard[]> = {};
    const { call } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items[0]?.card).toBeNull();
    cards['s-03'] = [permission('codex-permission')];
    await vi.advanceTimersByTimeAsync(500);
    expect(useIslandRequests.getState().items).toHaveLength(1);
    expect(useIslandRequests.getState().items[0]).toMatchObject({ card: { cardId: 'codex-permission' }, inWindow: true });
    const late = deferred<ReturnType<typeof snap>>();
    useIslandRequests.getState().bind(vi.fn().mockReturnValue(late.promise) as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'blocked')]));
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-03'), 'working')]));
    late.resolve(snap([permission('stale')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
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
    expect(useIslandRequests.getState().items.map((item) => item.card?.cardId)).toEqual(['c-2', 'c-1']);
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
    const state = useIslandRequests.getState();
    expect(state.items).toEqual([]);
    expect(state.index).toBe(0);
    expect(state.waitingSince).toEqual({});
  });

  it('активность ждущей сессии сменилась — новый снимок; та же запись — нет', async () => {
    const { call, snapshot } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    const first = activityMap([makeActivity(ref('s-01'), 'blocked')]);
    useIslandRequests.getState().sync(entries, first);
    await flush();
    useIslandRequests.getState().sync(entries, first);
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(1);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(useIslandRequests.getState().items).toHaveLength(1);
  });

  it('снимок пришёл, когда сессия уже перестала ждать, — ничего не добавляет', async () => {
    const late = deferred<ReturnType<typeof snap>>();
    const call = vi.fn(() => late.promise);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'working')]));
    late.resolve(snap([permission('c-1')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('два снимка одной сессии отвечают не по порядку — побеждает отправленный позже', async () => {
    const older = deferred<ReturnType<typeof snap>>();
    const newer = deferred<ReturnType<typeof snap>>();
    const pending = [older, newer];
    const call = vi.fn(() => pending.shift()!.promise);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    newer.resolve(snap([permission('c-new')]));
    await flush();
    older.resolve(snap([permission('c-old')]));
    await flush();
    expect(useIslandRequests.getState().items.map((item) => item.card?.cardId)).toEqual(['c-new']);
  });

  it('удавшийся снимок без ждущих карточек убирает прежнюю карточку сессии (ответили в терминале)', async () => {
    const cards: Record<string, FeedCard[]> = { 's-01': [permission('c-1')] };
    const { call } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items).toHaveLength(1);
    cards['s-01'] = [];
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('отказавший снимок оставляет прежнюю карточку; повторов нет, пока карточка есть', async () => {
    const { call, snapshot } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    snapshot.mockRejectedValueOnce(new Error('socket closed'));
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(useIslandRequests.getState().items.map((item) => item.card?.cardId)).toEqual(['c-1']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('карточки нет — повторы через 500, 1500 и 4000 мс, потом тишина', async () => {
    expect(ASK_RETRY_SCHEDULE_MS).toEqual([500, 1500, 4000]);
    const { call, snapshot } = bridge({});
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    let calls = 1;
    expect(snapshot).toHaveBeenCalledTimes(calls);
    for (const delay of ASK_RETRY_SCHEDULE_MS) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(snapshot).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      calls += 1;
      expect(snapshot).toHaveBeenCalledTimes(calls);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).toHaveBeenCalledTimes(calls);
  });

  it('карточка появилась на повторе — повторы прекращаются', async () => {
    const cards: Record<string, FeedCard[]> = {};
    const { call, snapshot } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    cards['s-01'] = [permission('c-1')];
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(useIslandRequests.getState().items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('сессия перестала ждать до повтора — повтор не спрашивает хост', async () => {
    const { call, snapshot } = bridge({});
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'working')]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('индекс зажимается, когда очередь сжимается: выбрана вторая, она ушла — индекс 0', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')], 's-02': [permission('c-2')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked'), makeActivity(ref('s-02'), 'blocked')]));
    await flush();
    useIslandRequests.getState().select(1);
    expect(useIslandRequests.getState().index).toBe(1);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked'), makeActivity(ref('s-02'), 'working')]));
    expect(useIslandRequests.getState().items.map((item) => item.card?.cardId)).toEqual(['c-1']);
    expect(useIslandRequests.getState().index).toBe(0);
  });

  it('ждущая сессия завершённой работы (done) игнорируется', async () => {
    const done = makeWork('w-9', { projectPath: PROJECT, status: 'done', sessions: [makeSession('s-01', 'a')] });
    const { call, snapshot } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync([done], activityMap([makeActivity({ projectPath: PROJECT, workId: 'w-9', sessionId: 's-01' }, 'blocked')]));
    await flush();
    expect(snapshot).not.toHaveBeenCalled();
    expect(useIslandRequests.getState().waitingSince).toEqual({});
    expect(useIslandRequests.getState().items).toEqual([]);
  });
});
