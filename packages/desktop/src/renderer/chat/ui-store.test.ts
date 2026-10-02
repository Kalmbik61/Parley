import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_TTL_MS, resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

beforeEach(() => {
  resetChatUiStoreForTests();
});

describe('ui-store: вложения поля ввода', () => {
  it('списки путей — по сессии, сброс для тестов их стирает', () => {
    const { setAttachments } = useChatUiStore.getState();
    setAttachments('a', ['/x.png']);
    setAttachments('b', ['/y.txt', '/z.txt']);
    expect(useChatUiStore.getState().attachments).toEqual({ a: ['/x.png'], b: ['/y.txt', '/z.txt'] });
    resetChatUiStoreForTests();
    expect(useChatUiStore.getState().attachments).toEqual({});
  });

  it('тот же массив — стор не трогается: подписчики не вызываются', () => {
    const paths = ['/x.png'];
    useChatUiStore.getState().setAttachments('a', paths);
    const listener = vi.fn();
    const off = useChatUiStore.subscribe(listener);
    useChatUiStore.getState().setAttachments('a', paths);
    expect(listener).not.toHaveBeenCalled();
    useChatUiStore.getState().setAttachments('a', ['/x.png']);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('ui-store: просьба показать карточку агента (кусок 4b)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ставит просьбу {sessionKey, agentId, nonce}; новая заменяет прежнюю, nonce растёт и у просьбы про того же агента', () => {
    const { requestReveal } = useChatUiStore.getState();
    requestReveal('s1', 'agent-1');
    const first = useChatUiStore.getState().reveal!;
    expect(first).toEqual({ sessionKey: 's1', agentId: 'agent-1', nonce: expect.any(Number) });
    requestReveal('s1', 'agent-1');
    const second = useChatUiStore.getState().reveal!;
    expect(second.nonce).toBeGreaterThan(first.nonce);
    requestReveal('s2', 'agent-9');
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: 's2', agentId: 'agent-9' });
  });

  it('clearReveal гасит просьбу с этим nonce; чужой (уже заменённой) просьбы не трогает, подписчиков зря не будит', () => {
    const { requestReveal, clearReveal } = useChatUiStore.getState();
    requestReveal('s1', 'a');
    const old = useChatUiStore.getState().reveal!.nonce;
    requestReveal('s1', 'b');
    const listener = vi.fn();
    const off = useChatUiStore.subscribe(listener);
    clearReveal(old);
    expect(useChatUiStore.getState().reveal).toMatchObject({ agentId: 'b' });
    expect(listener).not.toHaveBeenCalled();
    clearReveal(useChatUiStore.getState().reveal!.nonce);
    expect(useChatUiStore.getState().reveal).toBeNull();
    off();
  });

  it(`сама гаснет через ${REVEAL_TTL_MS} мс: вкладка без вида Chat её не исполнит, и позже она не сработает; новая просьба старым таймером не гасится`, () => {
    vi.useFakeTimers();
    const { requestReveal } = useChatUiStore.getState();
    requestReveal('s1', 'a');
    vi.advanceTimersByTime(REVEAL_TTL_MS - 1);
    expect(useChatUiStore.getState().reveal).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useChatUiStore.getState().reveal).toBeNull();

    requestReveal('s1', 'a');
    vi.advanceTimersByTime(REVEAL_TTL_MS - 1000);
    requestReveal('s1', 'b');
    vi.advanceTimersByTime(1000);
    // Таймер первой просьбы прошёл, вторая жива.
    expect(useChatUiStore.getState().reveal).toMatchObject({ agentId: 'b' });
    vi.advanceTimersByTime(REVEAL_TTL_MS);
    expect(useChatUiStore.getState().reveal).toBeNull();
  });

  it('сброс для тестов стирает просьбу', () => {
    useChatUiStore.getState().requestReveal('s1', 'a');
    resetChatUiStoreForTests();
    expect(useChatUiStore.getState().reveal).toBeNull();
  });
});
