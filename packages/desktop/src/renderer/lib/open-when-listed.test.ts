/**
 * Открытие созданного, когда снимок работ его принёс (кусок 7 плана «Organic»; раньше — `activateWhenListed` формы
 * новой работы): работа, сессия или комната — не раньше снимка, с тостом и снятой подпиской через 10 с и с отменой
 * при размонтировании.
 */

import { act } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { openWhenListed } from './open-when-listed.js';
import { roomKey } from './room-view.js';
import { workKey } from './tree-order.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const PROJECT = '/tmp/proj';
const KEY = workKey(PROJECT, 'w-01');

const tabs = (): string[] => {
  const layout = useLayoutStore.getState().layouts[KEY];
  return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
};

beforeEach(() => {
  vi.useFakeTimers();
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: { [KEY]: { root: { type: 'group', id: 'g-1', tabs: [], activeTabId: null }, activeGroupId: 'g-1', closedTabs: [] } },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  useUiStore.setState({ roomExpanded: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(toast).mockClear();
});

describe('openWhenListed', () => {
  it('работа уже в снимке — активируется сразу; вкладку она не открывает', () => {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT })] });
    openWhenListed(PROJECT, 'w-01', { kind: 'work' }, new Set());
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
    expect(tabs()).toEqual([]);
  });

  it('сессия: ждёт снимок с ней; снимок с работой, но без сессии, не активирует', () => {
    openWhenListed(PROJECT, 'w-01', { kind: 'session', sessionId: 's-01' }, new Set());
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT })] }));
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT, sessions: [makeSession('s-01', '')] })] }));
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
    expect(tabs()).toEqual([tabId.terminal('s-01')]);
  });

  it('комната: вкладка комнаты и развёрнутая строка — после снимка с ней', () => {
    openWhenListed(PROJECT, 'w-01', { kind: 'room', roomId: 'r-01' }, new Set());
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT })] }));
    expect(tabs()).toEqual([]);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBeUndefined();
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT, rooms: [makeRoom('r-01', 'Room 1')] })] }));
    expect(tabs()).toEqual([tabId.room('r-01')]);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
  });

  it('уже в снимке — сразу, без ожидания и подписки', () => {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT, rooms: [makeRoom('r-01', 'Room 1')] })] });
    const pending = new Set<() => void>();
    openWhenListed(PROJECT, 'w-01', { kind: 'room', roomId: 'r-01' }, pending);
    expect(tabs()).toEqual([tabId.room('r-01')]);
    expect(pending.size).toBe(0);
  });

  it.each([
    ['work', { kind: 'work' } as const, 'Workspace created — it will appear in the sidebar shortly'],
    ['session', { kind: 'session', sessionId: 's-01' } as const, 'Session started — it will appear in the sidebar shortly'],
    ['room', { kind: 'room', roomId: 'r-01' } as const, 'Room created — it will appear in the sidebar shortly'],
  ])('%s: за 10 с снимка нет — тост по виду созданного, поздний снимок не активирует', (_name, target, text) => {
    const pending = new Set<() => void>();
    openWhenListed(PROJECT, 'w-01', target, pending);
    expect(pending.size).toBe(1);
    act(() => vi.advanceTimersByTime(9_999));
    expect(toast).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(toast).toHaveBeenCalledWith(text);
    expect(pending.size).toBe(0);
    act(() =>
      useWorksStore.setState({
        entries: [makeWork('w-01', { projectPath: PROJECT, sessions: [makeSession('s-01', '')], rooms: [makeRoom('r-01', 'Room 1')] })],
      }),
    );
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
  });

  it('отмена из pending снимает ожидание: ни активации, ни тоста', () => {
    const pending = new Set<() => void>();
    openWhenListed(PROJECT, 'w-01', { kind: 'session', sessionId: 's-01' }, pending);
    for (const cancel of [...pending]) cancel();
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT, sessions: [makeSession('s-01', '')] })] }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
