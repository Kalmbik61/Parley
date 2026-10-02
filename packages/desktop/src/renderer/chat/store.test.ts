/**
 * Стор лент вида «Chat» (план 2026-10-01, Task 3, решение контролёра З) на подставном мосте: порядок
 * subscribe → snapshot, правила `revision`, разрыв, отписка, переподключение и хост без ленты.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';
import { cardKey, resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const KEY = refKey(REF);
const FEED_METHODS = [...REQUIRED_METHODS, 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe'];

const prompt = (id: string, text = id): FeedItem => ({ id, at: '2026-10-01T00:00:00.000Z', kind: 'prompt', text, images: 0 });

function connect(methods: string[] | null = FEED_METHODS): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods } });
}

type Snap = { items: FeedItem[]; revision: number; mode?: string | null };

/** Снимок по очереди ответов: каждый вызов `feed.snapshot` берёт следующий. */
function setSnapshots(bridge: FakeBridge, answers: Array<Snap | Promise<Snap>>): void {
  let n = 0;
  bridge.setHandler('feed.snapshot', async () => {
    const answer = await answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    return { mode: null, ...answer, schemaVersion: 1 };
  });
}

function feedCalls(bridge: FakeBridge): string[] {
  return bridge.calls.filter((call) => call.method.startsWith('feed.')).map((call) => call.method);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const feed = () => useFeedStore.getState().feeds[KEY];

let bridge: FakeBridge;
let dispose: (() => void) | null = null;

beforeEach(() => {
  resetFeedStoreForTests();
  connect();
  bridge = createFakeBridge();
  bridge.setHandler('feed.subscribe', () => ({ ok: true }));
  bridge.setHandler('feed.unsubscribe', () => ({ ok: true }));
  setSnapshots(bridge, [{ items: [prompt('a'), prompt('b')], revision: 5 }]);
  dispose = useFeedStore.getState().init(bridge);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  resetFeedStoreForTests();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('открытие ленты', () => {
  it('subscribe, затем snapshot; лента ready с revision снимка', async () => {
    useFeedStore.getState().open(REF);
    expect(feed()?.status).toBe('loading');
    await flush();
    expect(feedCalls(bridge)).toEqual(['feed.subscribe', 'feed.snapshot']);
    expect(feed()).toEqual({ items: [prompt('a'), prompt('b')], revision: 5, mode: null, status: 'ready' });
  });

  it('две вкладки одной сессии — одна подписка; отписка только при закрытии последней', async () => {
    useFeedStore.getState().open(REF);
    useFeedStore.getState().open(REF);
    await flush();
    expect(feedCalls(bridge)).toEqual(['feed.subscribe', 'feed.snapshot']);
    useFeedStore.getState().close(REF);
    await flush();
    expect(feedCalls(bridge)).not.toContain('feed.unsubscribe');
    expect(feed()?.status).toBe('ready');
    useFeedStore.getState().close(REF);
    await flush();
    expect(feedCalls(bridge)).toEqual(['feed.subscribe', 'feed.snapshot', 'feed.unsubscribe']);
    expect(feed()).toBeUndefined();
  });

  it('отказ хоста — error; закрытие после ошибки тоже отписывается', async () => {
    bridge.setHandler('feed.snapshot', () => {
      throw new Error('boom');
    });
    useFeedStore.getState().open(REF);
    await flush();
    expect(feed()?.status).toBe('error');
    useFeedStore.getState().close(REF);
    await flush();
    expect(feedCalls(bridge)).toEqual(['feed.subscribe', 'feed.snapshot', 'feed.unsubscribe']);
  });

  it('хост без feed.snapshot — ни одного вызова', async () => {
    connect(REQUIRED_METHODS as string[]);
    useFeedStore.getState().open(REF);
    await flush();
    useFeedStore.getState().close(REF);
    await flush();
    expect(feedCalls(bridge)).toEqual([]);
    expect(feed()).toBeUndefined();
  });
});

describe('дельты по revision', () => {
  beforeEach(async () => {
    useFeedStore.getState().open(REF);
    await flush();
  });

  it('r+1 применяется: известный — на месте, новые — в конец по порядку, removed удаляет', () => {
    bridge.emit('feed.changed', { mode: null,
      ref: REF,
      revision: 6,
      upsert: [prompt('c'), prompt('a', 'a2'), prompt('d')],
      removed: ['b'],
    });
    expect(feed()?.revision).toBe(6);
    expect(feed()?.items).toEqual([prompt('a', 'a2'), prompt('c'), prompt('d')]);
  });

  it('дельта ≤ r отбрасывается', () => {
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 5, upsert: [prompt('x')], removed: [] });
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 3, upsert: [prompt('y')], removed: ['a'] });
    expect(feed()).toEqual({ items: [prompt('a'), prompt('b')], revision: 5, mode: null, status: 'ready' });
  });

  it('чужая сессия ленту не трогает', () => {
    bridge.emit('feed.changed', { mode: null, ref: { ...REF, sessionId: 's-02' }, revision: 6, upsert: [prompt('x')], removed: [] });
    expect(feed()?.revision).toBe(5);
  });

  it('разрыв > r+1 — снимок заново, дельты до его прихода отброшены', async () => {
    let answer!: (value: { items: FeedItem[]; revision: number }) => void;
    setSnapshots(bridge, [new Promise((resolve) => (answer = resolve))]);
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 8, upsert: [prompt('gap')], removed: [] });
    await flush();
    expect(feedCalls(bridge)).toEqual(['feed.subscribe', 'feed.snapshot', 'feed.subscribe', 'feed.snapshot']);
    expect(feed()?.status).toBe('loading');
    // Пока снимок в пути — дельты отбрасываются, даже «следующие».
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 6, upsert: [prompt('lost')], removed: [] });
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 9, upsert: [prompt('lost2')], removed: [] });
    answer({ items: [prompt('a'), prompt('z')], revision: 10 });
    await flush();
    expect(feed()).toEqual({ items: [prompt('a'), prompt('z')], revision: 10, mode: null, status: 'ready' });
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 11, upsert: [prompt('next')], removed: [] });
    expect(feed()?.items.map((item) => item.id)).toEqual(['a', 'z', 'next']);
  });
});

describe('переподключение', () => {
  it('открытые ленты подписываются и берут снимок заново на новом мосте', async () => {
    useFeedStore.getState().open(REF);
    await flush();
    dispose?.();
    const next = createFakeBridge();
    next.setHandler('feed.subscribe', () => ({ ok: true }));
    setSnapshots(next, [{ items: [prompt('fresh')], revision: 1 }]);
    dispose = useFeedStore.getState().init(next);
    await flush();
    expect(feedCalls(next)).toEqual(['feed.subscribe', 'feed.snapshot']);
    expect(feed()).toEqual({ items: [prompt('fresh')], revision: 1, mode: null, status: 'ready' });
    // Старый мост ленту больше не двигает.
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 2, upsert: [prompt('old')], removed: [] });
    expect(feed()?.revision).toBe(1);
  });
});

describe('решения по карточкам (decide)', () => {
  const CARD = 'card-1';
  const DECISION = { kind: 'permission', behavior: 'allow' } as const;
  const card = (state: 'pending' | 'allowed'): FeedItem => ({
    id: CARD,
    at: '2026-10-01T00:00:00.000Z',
    kind: 'permission',
    cardId: CARD,
    state,
    toolUseId: null,
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    suggestions: [],
    notified: false,
  });
  const deciding = () => useFeedStore.getState().deciding[cardKey(KEY, CARD)];
  const note = () => useFeedStore.getState().notes[cardKey(KEY, CARD)];
  const decideCalls = () => bridge.calls.filter((call) => call.method === 'feed.decide');

  beforeEach(async () => {
    resetChatUiStoreForTests();
    connect([...FEED_METHODS, 'feed.decide']);
    setSnapshots(bridge, [{ items: [card('pending')], revision: 1 }]);
    useFeedStore.getState().open(REF);
    await flush();
  });

  it('второй клик, пока запрос в пути, второго вызова не шлёт', async () => {
    let answer: (value: { applied: boolean; state: 'allowed' }) => void = () => undefined;
    bridge.setHandler('feed.decide', () => new Promise((resolve) => (answer = resolve)));
    const first = useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(deciding()).toBe(true);
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(decideCalls()).toHaveLength(1);
    answer({ applied: true, state: 'allowed' });
    await first;
    // Применено — ждём дельту: решение в пути до неё, а дельта со сменой состояния его снимает.
    expect(deciding()).toBe(true);
    bridge.emit('feed.changed', { mode: null, ref: REF, revision: 2, upsert: [card('allowed')], removed: [] });
    expect(deciding()).toBeUndefined();
  });

  it('applied false при pending — пометка not-applied, кнопки снова доступны', async () => {
    bridge.setHandler('feed.decide', () => ({ applied: false, state: 'pending' as const }));
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(note()).toBe('not-applied');
    expect(deciding()).toBeUndefined();
  });

  it('applied false при уже улаженной карточке — без пометки', async () => {
    bridge.setHandler('feed.decide', () => ({ applied: false, state: 'allowed' as const }));
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(note()).toBeUndefined();
    expect(deciding()).toBeUndefined();
  });

  it('ошибка моста — пометка failed и предупреждение в консоли', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    bridge.setHandler('feed.decide', () => {
      throw new Error('boom');
    });
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(note()).toBe('failed');
    expect(deciding()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('новый клик стирает прежнюю пометку', async () => {
    bridge.setHandler('feed.decide', () => ({ applied: false, state: 'pending' as const }));
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(note()).toBe('not-applied');
    bridge.setHandler('feed.decide', () => new Promise(() => undefined));
    void useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(note()).toBeUndefined();
  });

  it('хост без feed.decide — вызова нет', async () => {
    connect(FEED_METHODS);
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    expect(decideCalls()).toHaveLength(0);
  });

  it('закрытие ленты забывает пометки, решения в пути и черновики карточек', async () => {
    bridge.setHandler('feed.decide', () => ({ applied: false, state: 'pending' as const }));
    await useFeedStore.getState().decide(REF, CARD, DECISION);
    useChatUiStore.getState().setCardDraft(cardKey(KEY, CARD), { message: 'no' });
    useFeedStore.getState().close(REF);
    expect(note()).toBeUndefined();
    expect(useChatUiStore.getState().cardDrafts).toEqual({});
  });
});

describe('режим разрешений в ленте (кусок 4a, решение К)', () => {
  it('режим снимка попадает в запись ленты, дельта без элементов его меняет', async () => {
    setSnapshots(bridge, [{ items: [prompt('a')], revision: 2, mode: 'default' }]);
    useFeedStore.getState().open(REF);
    await flush();
    expect(feed()?.mode).toBe('default');
    bridge.emit('feed.changed', { ref: REF, revision: 3, upsert: [], removed: [], mode: 'plan' });
    expect(feed()).toMatchObject({ revision: 3, mode: 'plan' });
    expect(feed()?.items.map((item) => item.id)).toEqual(['a']);
  });
});
