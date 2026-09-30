/**
 * Тест 14 куска 4.3 (отложенный тест 2.5 «focus() поверхности фоновой работы»): цель — сессия
 * работы, которая ни разу не была активной (вне LRU, раскладка не гидрирована). Переход ждёт
 * `hydrate` в очереди; после него поверхность получает прокрутку и фокус, и в момент фокуса
 * ни поверхность, ни контейнер работы не `inert`.
 *
 * xterm подменён фейком, как в `shell/AppShell.test.tsx`: настоящий рисует в канву, которой в
 * jsdom нет. Общий мок (`test-utils/xterm-mock.ts`) через `onCall` запоминает, был ли контейнер
 * под `inert` в момент `focus()`.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { AppShell } from '../shell/AppShell.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { terminalSurfaces } from '../terminal/surface-registry.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import { flashTab } from './flash.js';
import { applyFocusTarget, whenShown } from './focus-target.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const xterm = vi.hoisted(() => ({
  events: [] as Array<{ call: 'focus' | 'scrollToBottom'; inert: boolean; workContainer: string | null }>,
}));

vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', async () => (await import('../test-utils/xterm-mock.js')).searchModule);
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
  };
}

function work(id: string, createdAt: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

const STATUS = { state: 'connected' as const, hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] };

let bridge: FakeBridge;

beforeEach(() => {
  xterm.events = [];
  xtermMock.reset();
  // Был ли контейнер терминала под `inert` в момент `focus()`/`scrollToBottom()`.
  xtermMock.onCall = (term, method) => {
    if (method !== 'focus' && method !== 'scrollToBottom') return;
    xterm.events.push({
      call: method,
      inert: term.element?.closest('[inert]') != null,
      workContainer: term.element?.closest('[data-work-container]')?.getAttribute('data-work-container') ?? null,
    });
  };
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: { open: false, projectPath: null, title: '' }, newSession: { open: false, work: null, room: false }, settings: false, mergeRoom: null, restartHost: false },
    visibleSessionRefs: {},
    ui: DEFAULT_UI,
    uiLoaded: true,
  });
  useUiStore.getState().init(bridge);
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('applyFocusTarget в AppShell — фоновая работа вне LRU (тест 14 куска 4.3)', () => {
  it('openTab ждёт hydrate; после него focus() и scrollToBottom() поверхности, и в момент focus() ничего не inert', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'planner')]);
    const w2 = work('w-02', '2026-01-02', [session('s-02', 'executor')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    const key1 = workKey('/tmp/w-01', 'w-01');
    const key2 = workKey('/tmp/w-02', 'w-02');
    // Активна первая работа с открытым терминалом; вторая ни разу не показывалась.
    const layout1 = openTab(emptyLayout(), { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' });
    useLayoutStore.setState({ activeWorkKey: key1, layouts: { [key1]: layout1 }, hydrated: { [key1]: true } });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector(`[data-work-container="${key2}"]`)).toBeNull();
    xterm.events = [];

    const ref = { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-02' };
    let applied = false;
    act(() => {
      applied = applyFocusTarget(
        { kind: 'session', ref },
        {
          works: useWorksStore.getState().entries,
          setActiveWork: (key) => useLayoutStore.getState().setActiveWork(key),
          openTab: (key, tab) => {
            useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
          },
          whenShown,
          surface: (target) => terminalSurfaces.get(refKey(target)),
          flash: (key, id) => flashTab(key, id),
        },
      );
      // До `hydrate` операция стоит в очереди — раскладки второй работы ещё нет.
      expect(useLayoutStore.getState().hydrated[key2]).toBeUndefined();
      expect(useLayoutStore.getState().pending[key2]).toHaveLength(1);
    });
    expect(applied).toBe(true);

    await waitFor(() => expect(xterm.events.map((event) => event.call)).toContain('focus'));
    expect(useLayoutStore.getState().hydrated[key2]).toBe(true);
    const focus = xterm.events.find((event) => event.call === 'focus');
    expect(focus).toEqual({ call: 'focus', inert: false, workContainer: key2 });
    expect(xterm.events.filter((event) => event.workContainer === key2).map((event) => event.call)).toEqual(['scrollToBottom', 'focus']);
  });
});
