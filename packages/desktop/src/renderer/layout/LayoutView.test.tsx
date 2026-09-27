/**
 * Тест 17 куска 2.4: `LayoutView` отдаёт `fontFamily`/`fontSize` телу терминала
 * (контекст `GroupView.tsx#LayoutBodyContext`, как раньше `PanelHostContext`),
 * а тело комнаты получает тот же `bridge` — раскладка с двумя группами:
 * терминал в одной, комната в другой. С куска 2.5 сам терминал живёт в слое
 * поверхностей — шрифт до него доходит через `SurfaceLayer` рядом с
 * `LayoutView`, как их монтирует контейнер работы в `AppShell.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { GroupNode, SplitNode } from '../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutView } from './LayoutView.js';
import { SurfaceLayer } from './SurfaceLayer.js';
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
    render(
      <>
        <LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={15} />
        <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={15} />
      </>,
    );
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

describe('LayoutView — раунд исправлений 1: ⌃Tab держит зажатым ⌃ (VS Code/Orca)', () => {
  function activeTabId(): string | null | undefined {
    const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
    return root?.type === 'group' ? root.activeTabId : undefined;
  }

  function setUpThreeTabs(): void {
    // Три вкладки в одной группе, все — сессии из entry() плюс две добавочные.
    const withThree: WorkEntry = {
      ...entry(),
      map: {
        ...entry().map,
        sessions: [session('a', ''), session('b', ''), session('c', '')],
      },
    };
    useWorksStore.setState({ entries: [withThree], branches: {}, loading: false, error: null });

    const group: GroupNode = {
      type: 'group',
      id: 'g1',
      tabs: [
        { kind: 'terminal', id: 'terminal:a', sessionId: 'a' },
        { kind: 'terminal', id: 'terminal:b', sessionId: 'b' },
        { kind: 'terminal', id: 'terminal:c', sessionId: 'c' },
      ],
      activeTabId: 'terminal:c',
    };
    useLayoutStore.setState({
      activeWorkKey: WORK_KEY,
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
      pending: {},
      history: EMPTY_HISTORY,
      // «Вкладки A,B,C открыты по порядку» → MRU (свежая первой): C,B,A.
      mru: { [WORK_KEY]: ['terminal:c', 'terminal:b', 'terminal:a'] },
      navigating: false,
    });
  }

  it('⌃ удержан, Tab ×2 обходит MRU дальше двух последних; отпускание ⌃ фиксирует итог', async () => {
    setUpThreeTabs();
    render(<LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />);
    await flush();
    expect(activeTabId()).toBe('terminal:c');

    // ⌃ зажат — два Tab подряд, без keyup между ними.
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeTabId()).toBe('terminal:a');
    // Пока ⌃ зажат, живой MRU ещё не зафиксирован в ожидаемом порядке снимка —
    // фиксация только на отпускании.
    fireEvent.keyUp(window, { key: 'Control' });
    expect(useLayoutStore.getState().mru[WORK_KEY]).toEqual(['terminal:a', 'terminal:c', 'terminal:b']);

    // Одиночный ⌃Tab после фиксации — снимок берётся заново, из уже нового порядка.
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Control' });
    expect(activeTabId()).toBe('terminal:c');
  });

  it('потеря фокуса окна во время удержания ⌃ тоже фиксирует итог цикла', async () => {
    setUpThreeTabs();
    render(<LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />);
    await flush();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeTabId()).toBe('terminal:a');

    fireEvent(window, new FocusEvent('blur'));
    expect(useLayoutStore.getState().mru[WORK_KEY]).toEqual(['terminal:a', 'terminal:c', 'terminal:b']);
  });
});

describe('LayoutView — active: false (кусок 2.5)', () => {
  it('неактивная работа не ловит клавиши 2.4 и не порталит строку вкладок в заголовок', async () => {
    const slot = document.createElement('div');
    slot.id = 'titlebar-tabs';
    document.body.appendChild(slot);
    try {
      const group: GroupNode = {
        type: 'group',
        id: 'g1',
        tabs: [
          { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' },
          { kind: 'room', id: 'room:r-01', roomId: 'r-01' },
        ],
        activeTabId: 'room:r-01',
      };
      useLayoutStore.setState({ layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } } });
      render(<LayoutView workKey={WORK_KEY} active={false} bridge={bridge} fontFamily="Menlo" fontSize={13} />);
      await flush();

      fireEvent.keyDown(window, { key: '1', ctrlKey: true });
      const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
      expect(root?.type === 'group' ? root.activeTabId : null).toBe('room:r-01');
      expect(slot.childElementCount).toBe(0);
    } finally {
      slot.remove();
    }
  });
});

describe('LayoutView — work-step проходит мимо (тест 11 куска 3.4)', () => {
  it('⌘⇧↓ не листает вкладки активной группы и не зовёт preventDefault; ⌘⇧] — листает', async () => {
    const group: GroupNode = {
      type: 'group',
      id: 'g1',
      tabs: [
        { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' },
        { kind: 'room', id: 'room:r-01', roomId: 'r-01' },
      ],
      activeTabId: 'terminal:s-01',
    };
    useLayoutStore.setState({ layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } } });
    render(<LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />);
    await flush();
    const activeTab = (): string | null => {
      const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
      return root?.type === 'group' ? root.activeTabId : null;
    };

    const step = new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true, shiftKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(step);
    });
    expect(step.defaultPrevented).toBe(false);
    expect(activeTab()).toBe('terminal:s-01');

    const tabStep = new KeyboardEvent('keydown', { key: ']', metaKey: true, shiftKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(tabStep);
    });
    expect(tabStep.defaultPrevented).toBe(true);
    expect(activeTab()).toBe('room:r-01');
  });
});
