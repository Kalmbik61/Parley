import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import { ELSEWHERE_MS } from '../requests.js';
import { ANSWER_HOLD_MS, createConsentsStore } from './store.js';

function card(id: string, patch: Partial<ConsentCard> = {}): ConsentCard {
  return {
    id, kind: 'folder-trust', folder: `/tmp/${id}`, projectPath: `/tmp/${id}`,
    requestedBy: { source: 'agent', sessionId: 's-03', workId: 'w-1', label: 'S03 Ruslan' },
    at: '2026-10-21T10:00:00.000Z', state: 'pending', ...patch,
  };
}

function setup(answer: { applied: boolean; state: ConsentCard['state'] } | Error = { applied: true, state: 'allowed' }) {
  const store = createConsentsStore();
  const call = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  store.getState().configure({ call: call as never });
  return { store, call };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('стор карточек согласия острова', () => {
  it('replace кладёт ждущие карточки, остальные состояния не остаются', () => {
    const { store } = setup();
    store.getState().replace([card('c-01'), card('c-02', { state: 'allowed' })]);
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01']);
  });

  it('apply: upsert добавляет карточку, повторный upsert заменяет на месте, removed убирает', () => {
    const { store } = setup();
    store.getState().apply({ upsert: [card('c-01'), card('c-02')], removed: [] });
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01', 'c-02']);
    store.getState().apply({ upsert: [card('c-01', { folder: '/tmp/other' })], removed: [] });
    expect(store.getState().items.map((item) => item.folder)).toEqual(['/tmp/other', '/tmp/c-02']);
    store.getState().apply({ upsert: [], removed: ['c-01'] });
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-02']);
  });

  it('apply: решённая карточка (allowed / denied) в items не остаётся', () => {
    const { store } = setup();
    store.getState().apply({ upsert: [card('c-01'), card('c-02')], removed: [] });
    store.getState().apply({ upsert: [card('c-01', { state: 'allowed' })], removed: [] });
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-02']);
  });

  it('decide зовёт consents.decide, держит deciding на время вызова и чистит его после', async () => {
    const { store, call } = setup();
    store.getState().replace([card('c-01')]);
    const pending = store.getState().decide('c-01', 'allow');
    expect(store.getState().deciding).toBe('c-01');
    await pending;
    expect(call).toHaveBeenCalledWith('consents.decide', { id: 'c-01', decision: 'allow' });
    expect(store.getState().deciding).toBeNull();
  });

  it('второе решение, пока первое в пути, не уходит', async () => {
    const { store, call } = setup();
    store.getState().replace([card('c-01')]);
    const first = store.getState().decide('c-01', 'allow');
    await store.getState().decide('c-01', 'deny');
    await first;
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('applied: true — «Done ✓» на ANSWER_HOLD_MS; событие хоста о закрытии карточки в это время её не убирает', async () => {
    const { store } = setup();
    store.getState().replace([card('c-01')]);
    const pending = store.getState().decide('c-01', 'allow');
    // Хост часто присылает «карточка закрыта» раньше ответа на вызов.
    store.getState().apply({ upsert: [], removed: ['c-01'] });
    await pending;
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01']);
    expect(store.getState().note).toBe('done');
    store.getState().apply({ upsert: [card('c-01', { state: 'allowed' })], removed: [] });
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01']);
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().note).toBeNull();
  });

  it('applied: false — пометка «elsewhere» на ELSEWHERE_MS, потом карточка уходит', async () => {
    const { store } = setup({ applied: false, state: 'denied' });
    store.getState().replace([card('c-01')]);
    await store.getState().decide('c-01', 'allow');
    expect(store.getState().note).toBe('elsewhere');
    expect(store.getState().deciding).toBeNull();
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01']);
    vi.advanceTimersByTime(ELSEWHERE_MS);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().note).toBeNull();
  });

  it('ошибка вызова — пометка «failed», карточка остаётся и решается снова', async () => {
    const { store, call } = setup(new Error('host gone'));
    store.getState().replace([card('c-01')]);
    await store.getState().decide('c-01', 'allow');
    expect(store.getState().note).toBe('failed');
    expect(store.getState().deciding).toBeNull();
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-01']);
    await store.getState().decide('c-01', 'allow');
    expect(call).toHaveBeenCalledTimes(2);
    expect(store.getState().note).toBe('failed');
  });

  it('пометка относится к показанной карточке: ушла она — пометки нет у следующей', async () => {
    const { store } = setup(new Error('host gone'));
    store.getState().replace([card('c-01'), card('c-02')]);
    await store.getState().decide('c-01', 'allow');
    expect(store.getState().note).toBe('failed');
    store.getState().apply({ upsert: [], removed: ['c-01'] });
    expect(store.getState().items.map((item) => item.id)).toEqual(['c-02']);
    expect(store.getState().note).toBeNull();
  });

  it('replace сбрасывает удержание: карточку, что держала пометка, уход таймера не трогает', async () => {
    const { store } = setup();
    store.getState().replace([card('c-01')]);
    await store.getState().decide('c-01', 'allow');
    store.getState().replace([card('c-01', { folder: '/tmp/again' })]);
    expect(store.getState().note).toBeNull();
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(store.getState().items.map((item) => item.folder)).toEqual(['/tmp/again']);
  });

  it('решение несуществующей карточки никуда не уходит', async () => {
    const { store, call } = setup();
    await store.getState().decide('c-09', 'allow');
    expect(call).not.toHaveBeenCalled();
  });
});
