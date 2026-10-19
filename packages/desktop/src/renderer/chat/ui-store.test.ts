import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindAgentsPinToLayout, REVEAL_TTL_MS, resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

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

  it('requestRevealItem ставит просьбу по itemId с новым nonce и заменяет прежнюю; гаснет по сроку', () => {
    vi.useFakeTimers();
    const { requestReveal, requestRevealItem } = useChatUiStore.getState();
    requestReveal('s1', 'agent-1');
    const first = useChatUiStore.getState().reveal!;
    requestRevealItem('s1', 'perm:1');
    const second = useChatUiStore.getState().reveal!;
    expect(second).toMatchObject({ sessionKey: 's1', itemId: 'perm:1' });
    expect('agentId' in second).toBe(false);
    expect(second.nonce).toBeGreaterThan(first.nonce);
    vi.advanceTimersByTime(REVEAL_TTL_MS);
    expect(useChatUiStore.getState().reveal).toBeNull();
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

describe('ui-store: панель агентов', () => {
  it('выбор агента и раскрытие Finished — по сессии', () => {
    resetChatUiStoreForTests();
    const store = useChatUiStore.getState();
    store.selectAgent('s1', { by: 'agent', id: 'a1' });
    store.setFinishedOpen('s1', true);
    expect(useChatUiStore.getState().agentPanel['s1']).toEqual({ by: 'agent', id: 'a1' });
    expect(useChatUiStore.getState().agentPanel['s2']).toBeUndefined();
    expect(useChatUiStore.getState().finishedOpen['s1']).toBe(true);
    useChatUiStore.getState().selectAgent('s1', null);
    expect(useChatUiStore.getState().agentPanel['s1']).toBeNull();
  });
});

import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import type { TabSpec } from '../../shared/layout-types.js';
describe('Agents pin follows actual tab activation without a mounted panel', () => {
 const key = '/tmp/p w-01';
 const activate = (tab: TabSpec) => useLayoutStore.setState({ activeWorkKey: key, layouts: { [key]: { root: { type: 'group', id: 'g1', tabs: tab.id === 'terminal:B' ? [tab] : [{ kind: 'terminal', id: 'terminal:B', sessionId: 'B' }, tab], activeTabId: tab.id }, activeGroupId: 'g1', closedTabs: [] } } });
 it.each(['terminal', 'diff'] as const)('clears on %s activation even when MRU already names B', (kind) => {
  activate({ kind: 'room', id: 'room:r-01', roomId: 'r-01' });
  useLayoutStore.setState({ mru: { [key]: ['terminal:B'] }, history: { entries: [{ workKey: key, tabId: 'terminal:B', at: 1 }, { workKey: key, tabId: 'room:r-01', at: 2 }], index: 1 } });
  expect(focusedSessionOf(useLayoutStore.getState(), key)).toBe('B');
  const off = bindAgentsPinToLayout();
  useChatUiStore.getState().pinAgentsSession(key, 'A');
  activate(kind === 'terminal' ? { kind, id: 'terminal:B', sessionId: 'B' } : { kind, id: 'diff:B', sessionId: 'B', commit: null });
  expect(focusedSessionOf(useLayoutStore.getState(), key)).toBe('B');
  expect(useChatUiStore.getState().agentsPin[key]).toBeNull(); off();
 });
 it('keeps pins for room/file changes and stops reacting after unsubscribe', () => {
  activate({ kind: 'terminal', id: 'terminal:B', sessionId: 'B' });
  const off = bindAgentsPinToLayout(); useChatUiStore.getState().pinAgentsSession(key, 'A');
  activate({ kind: 'room', id: 'room:r-01', roomId: 'r-01' });
  activate({ kind: 'file', id: 'file:a', root: { kind: 'project' }, path: 'a' });
  expect(useChatUiStore.getState().agentsPin[key]).toBe('A');
  off(); activate({ kind: 'terminal', id: 'terminal:B', sessionId: 'B' });
  expect(useChatUiStore.getState().agentsPin[key]).toBe('A');
  resetChatUiStoreForTests(); expect(useChatUiStore.getState().agentsPin).toEqual({});
 });
});
