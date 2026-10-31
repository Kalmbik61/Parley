/**
 * Попытка очереди Chat (спека 2026-10-16, 4.3): исход `pty.send` → ушло / повторить / не ушло; тосты — только на
 * окончательных исходах; ушедшее во время хода переходит в серые «Queued».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { FeedItem } from '@parley/core';
import { refKey, type CompactionPhase, type LiveMetrics, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { OutboxItem } from '../lib/outbox.js';
import { useActivityStore } from '../store/activity.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity } from '../test-utils/work-fixtures.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { attemptChatSend, CHAT_AWAIT_PROMPT_MS, CHAT_RETRY_MS, chatOutbox, type ChatOutboxPayload } from './chat-outbox.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const KEY = refKey(REF);
const AT = '2026-10-16T10:00:00.000Z';

let bridge: FakeBridge;
let deps: SendWithToastDeps;

const prompt = (id: string, text: string): FeedItem => ({ id, at: AT, kind: 'prompt', text, images: 0 });
const turn = (id: string): FeedItem => ({ id, at: AT, kind: 'turn', durationMs: 1000 });

function setFeed(items: FeedItem[]): void {
  useFeedStore.setState({ feeds: { [KEY]: { items, revision: 1, mode: null, decisions: null, status: 'ready' } } });
}

const REQUESTED_AT = 1_760_000_000_000;

const item = (text: string): OutboxItem<ChatOutboxPayload> => ({
  id: 'o1',
  status: 'pending',
  payload: { ref: REF, text, deps, requestedAt: REQUESTED_AT },
});

beforeEach(() => {
  bridge = createFakeBridge();
  deps = { bridge, session: () => null, openSession: () => undefined };
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  chatOutbox.resetForTests();
  useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  chatOutbox.resetForTests();
  useWorksStore.setState(useWorksStore.getInitialState(), true);
  useActivityStore.setState({ byRef: {}, loaded: false });
});

describe('attemptChatSend', () => {
  it('pty.send уходит с requestedAt из payload (метка нажатия Send, а не момента вызова)', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    await attemptChatSend(KEY, item('next'));
    expect(bridge.calls).toEqual([{ method: 'pty.send', params: { ref: REF, text: 'next', submit: true, requestedAt: REQUESTED_AT } }]);
  });

  it('ушло без хода — sent, серых «Queued» нет, тоста нет', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    setFeed([prompt('p1', 'go'), turn('u1')]);
    expect(await attemptChatSend(KEY, item('next'))).toEqual({ kind: 'sent' });
    expect(useChatUiStore.getState().queued[KEY] ?? []).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('ушло во время хода — sent и серый «Queued» с тем же id и счётом промптов до отправки', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    setFeed([prompt('p0', 'next'), turn('u0'), prompt('p1', 'go')]);
    expect(await attemptChatSend(KEY, item('next'))).toEqual({ kind: 'sent' });
    expect(useChatUiStore.getState().queued[KEY]).toEqual([{ id: 'o1', text: 'next', seen: 1 }]);
  });

  it('busy — retry без тоста; wait — ровно CHAT_RETRY_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    const result = await attemptChatSend(KEY, item('later'));
    expect(result.kind).toBe('retry');
    expect(toast.error).not.toHaveBeenCalled();
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('blocked — retry без тоста; wait не раньше CHAT_RETRY_MS и пока сессия blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'blocked')]), loaded: true });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    const result = await attemptChatSend(KEY, item('later'));
    expect(result.kind).toBe('retry');
    expect(toast.error).not.toHaveBeenCalled();
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS * 5);
    expect(done).toBe(false);
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('blocked, а окно ещё не видит blocked — всё равно не чаще раза в CHAT_RETRY_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    const result = await attemptChatSend(KEY, item('later'));
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('вставлено без Enter (draft) — sent и прежний тост', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: 'draft' }));
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'sent' });
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([S.send.insertedDraft('S01')]);
  });

  it('сессии нет (not_found) — failed и тост «не запущена»', async () => {
    bridge.setHandler('pty.send', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'failed' });
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.notRunning('S01')]);
  });

  it('no-paste-mode — failed и прежний тост', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'no-paste-mode' }));
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'failed' });
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.noPasteMode('S01')]);
  });
});

describe('chatOutbox — затвор на время хода', () => {
  const sentTexts = (): string[] => bridge.calls.filter((call) => call.method === 'pty.send').map((call) => (call.params as { text: string }).text);
  const payload = (text: string, now?: boolean): ChatOutboxPayload => ({
    ref: REF,
    text,
    deps,
    requestedAt: REQUESTED_AT,
    ...(now === undefined ? {} : { now }),
  });
  const live = (): void => {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-01', 'S01')] })] });
  };
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
  });

  it('живая сессия с идущим ходом: сообщение не уходит; ход закрылся — уходит', async () => {
    live();
    setFeed([prompt('p1', 'go')]);
    chatOutbox.enqueue(KEY, payload('later'));
    await flush();
    expect(sentTexts()).toEqual([]);
    expect(chatOutbox.items(KEY)).toHaveLength(1);
    setFeed([prompt('p1', 'go'), turn('u1')]);
    await flush();
    expect(sentTexts()).toEqual(['later']);
  });

  it('now: уходит несмотря на ход и становится серым «Queued» CLI', async () => {
    live();
    setFeed([prompt('p1', 'go')]);
    const id = chatOutbox.enqueue(KEY, payload('urgent', true));
    await flush();
    expect(sentTexts()).toEqual(['urgent']);
    expect(useChatUiStore.getState().queued[KEY]).toEqual([{ id, text: 'urgent', seen: 0 }]);
  });

  it('сессия не живая: ход в ленте очередь не держит', async () => {
    setFeed([prompt('p1', 'go')]);
    chatOutbox.enqueue(KEY, payload('now'));
    await flush();
    expect(sentTexts()).toEqual(['now']);
  });

  it('после отправки без хода следующее ждёт промпт и закрытие его хода', async () => {
    live();
    setFeed([]);
    chatOutbox.enqueue(KEY, payload('one'));
    await flush();
    chatOutbox.enqueue(KEY, payload('two'));
    await flush();
    expect(sentTexts()).toEqual(['one']);
    setFeed([prompt('p1', 'one')]);
    await flush();
    expect(sentTexts()).toEqual(['one']);
    setFeed([prompt('p1', 'one'), turn('u1')]);
    await flush();
    expect(sentTexts()).toEqual(['one', 'two']);
  });

  it('промпт так и не пришёл (слэш-команда): следующее уходит через CHAT_AWAIT_PROMPT_MS', async () => {
    live();
    setFeed([]);
    chatOutbox.enqueue(KEY, payload('/clear'));
    await flush();
    chatOutbox.enqueue(KEY, payload('two'));
    await vi.advanceTimersByTimeAsync(CHAT_AWAIT_PROMPT_MS - 1);
    expect(sentTexts()).toEqual(['/clear']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentTexts()).toEqual(['/clear', 'two']);
  });

  it('ленты нет, активность working: сообщение не уходит; activity стала idle — уходит', async () => {
    live();
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]), loaded: true });
    chatOutbox.enqueue(KEY, payload('later'));
    await flush();
    expect(sentTexts()).toEqual([]);
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
    await flush();
    expect(sentTexts()).toEqual(['later']);
  });

  it('ход идёт, ленту убрали из стора (закрыли вкладку), активность working: всё ещё не уходит', async () => {
    live();
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]), loaded: true });
    setFeed([prompt('p1', 'go')]);
    chatOutbox.enqueue(KEY, payload('later'));
    await flush();
    useFeedStore.setState({ feeds: {} });
    await flush();
    expect(sentTexts()).toEqual([]);
  });

  describe('сжатие контекста (metrics.compaction)', () => {
    const compactNotice = (id: string, phase: 'pre' | 'post'): FeedItem => ({ id, at: AT, kind: 'notice', notice: { type: 'compact', phase, trigger: 'manual' } });
    // Хост напечатал `/compact`: в ленте слэш-команда и заметка сжатия, хода по ней нет (`turnActive` — false).
    const compactFeed = [prompt('p0', 'go'), turn('u0'), prompt('p1', '/compact'), compactNotice('n1', 'pre')];
    const compaction = (phase: CompactionPhase | null): void => {
      const metrics: LiveMetrics = { tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 0, model: null, compaction: phase };
      useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle', { metrics })]), loaded: true });
    };

    it.each([
      { phase: 'pending' as const, feed: [prompt('p0', 'go'), turn('u0')] },
      { phase: 'running' as const, feed: compactFeed },
    ])('сжатие $phase: сообщение ждёт окном, а не в полёте, — pty.send не зовётся', async ({ phase, feed }) => {
      live();
      setFeed(feed);
      compaction(phase);
      chatOutbox.enqueue(KEY, payload('later'));
      await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS * 3);
      expect(sentTexts()).toEqual([]);
      expect(chatOutbox.items(KEY).map((entry) => entry.status)).toEqual(['pending']);
      expect(chatOutbox.store.getState().flying[KEY]).toBeUndefined();
    });

    it('сжатие кончилось — ждавшее сообщение уходит ровно один раз', async () => {
      live();
      // Пока сжатие держит сессию (`sessions.exclusive`), хост отказывает `blocked`.
      let held = true;
      bridge.setHandler('pty.send', () => (held ? { inserted: false, submitted: false, reason: 'blocked' } : { inserted: true, submitted: true, reason: null }));
      setFeed(compactFeed);
      compaction('running');
      chatOutbox.enqueue(KEY, payload('later'));
      await flush();
      expect(sentTexts()).toEqual([]);
      held = false;
      setFeed([...compactFeed, compactNotice('n2', 'post')]);
      compaction('compacted');
      await flush();
      expect(sentTexts()).toEqual(['later']);
      expect(chatOutbox.items(KEY)).toEqual([]);
      setFeed([...compactFeed, compactNotice('n2', 'post'), prompt('p2', 'later'), turn('u2')]);
      compaction(null);
      await vi.advanceTimersByTimeAsync(CHAT_AWAIT_PROMPT_MS + CHAT_RETRY_MS);
      expect(sentTexts()).toEqual(['later']);
    });
  });

  it('лента грузится (loading), активность idle: сообщение уходит', async () => {
    live();
    useFeedStore.setState({ feeds: { [KEY]: { items: [], revision: 0, mode: null, decisions: null, status: 'loading' } } });
    chatOutbox.enqueue(KEY, payload('later'));
    await flush();
    expect(sentTexts()).toEqual(['later']);
  });
});

