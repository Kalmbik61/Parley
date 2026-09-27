/**
 * Тест 17 куска 2.4: `LayoutView` отдаёт `fontFamily`/`fontSize` телу терминала
 * (контекст `GroupView.tsx#LayoutBodyContext`, как раньше `PanelHostContext`),
 * а тело комнаты получает тот же `bridge` — раскладка с двумя группами:
 * терминал в одной, комната в другой.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { SplitNode } from '../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutView } from './LayoutView.js';
import { useLayoutStore } from './store.js';

const state = vi.hoisted(() => ({ terminalOptions: [] as Array<Record<string, unknown>> }));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => {
    state.terminalOptions.push(initialOptions);
    return {
      cols: 80,
      rows: 24,
      options: { ...initialOptions },
      open: () => {},
      loadAddon: () => {},
      write: () => {},
      reset: () => {},
      dispose: () => {},
      resize: () => {},
      onData: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: () => {},
      hasSelection: () => false,
      getSelection: () => '',
    };
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn().mockImplementation(() => ({ findNext: () => true })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
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

function room(id: string, title: string): Room {
  return { id, title, creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' };
}

function entry(): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms: [room('r-01', 'общая')],
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions: [session('s-01', 'исполнитель')],
      messages: [],
    },
  };
}

const WORK_KEY = '/tmp/p w';
let bridge: FakeBridge;

beforeEach(() => {
  state.terminalOptions = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  bridge.setHandler('providers.list', () => ({ providers: [] }));

  useWorksStore.setState({ entries: [entry()], branches: {}, loading: false, error: null });

  const root: SplitNode = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    children: [
      { type: 'group', id: 'g1', tabs: [{ kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }], activeTabId: 'terminal:s-01' },
      { type: 'group', id: 'g2', tabs: [{ kind: 'room', id: 'room:r-01', roomId: 'r-01' }], activeTabId: 'room:r-01' },
    ],
  };
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root, activeGroupId: 'g1', closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('LayoutView — тест 17', () => {
  it('тело терминала создаёт Terminal с fontFamily/fontSize; тело комнаты получает тот же bridge', async () => {
    render(<LayoutView workKey={WORK_KEY} bridge={bridge} fontFamily="Menlo" fontSize={15} />);
    await flush();

    expect(state.terminalOptions).toHaveLength(1);
    expect(state.terminalOptions[0]).toMatchObject({ fontFamily: 'Menlo', fontSize: 15 });

    // Тело комнаты получило тот же bridge: providers.list уходит через него, и
    // содержимое комнаты (её название) видно, значит `entry` тоже дошёл.
    expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true);
    // «общая» видно и в самой вкладке (заголовок из `tabMeta`), и в шапке
    // `RoomPanel` — оба места означают, что `entry`/`bridge` дошли до тела.
    expect(screen.getAllByText('общая').length).toBeGreaterThan(0);
  });
});
