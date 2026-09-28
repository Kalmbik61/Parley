/**
 * Тест 17 куска 2.4: `LayoutView` отдаёт `fontFamily`/`fontSize` телу терминала
 * (контекст `GroupView.tsx#LayoutBodyContext`, как раньше `PanelHostContext`),
 * а тело комнаты получает тот же `bridge` — раскладка с двумя группами:
 * терминал в одной, комната в другой. С куска 2.5 сам терминал живёт в слое
 * поверхностей — шрифт до него доходит через `SurfaceLayer` рядом с
 * `LayoutView`, как их монтирует контейнер работы в `AppShell.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { GroupNode, SplitNode } from '../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutView } from './LayoutView.js';
import { SurfaceLayer } from './SurfaceLayer.js';
import { useLayoutStore } from './store.js';

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
  xtermMock.reset();
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
        <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={15} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
      </>,
    );
    await flush();

    expect(xtermMock.terminals.map((term) => term.initialOptions)).toHaveLength(1);
    expect(xtermMock.terminals.map((term) => term.initialOptions)[0]).toMatchObject({ fontFamily: 'Menlo', fontSize: 15 });

    // Тело комнаты получило тот же bridge: providers.list уходит через него, и
    // содержимое комнаты (её название) видно, значит `entry` тоже дошёл.
    expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true);
    // «общая» видно и в самой вкладке (заголовок из `tabMeta`), и в шапке
    // `RoomPanel` — оба места означают, что `entry`/`bridge` дошли до тела.
    expect(screen.getAllByText('общая').length).toBeGreaterThan(0);
  });
});

describe('LayoutView — возврат связи с хостом (fix-7.3)', () => {
  it('тело комнаты перечитывает providers.list, когда связь вернулась: оболочка при обрыве не перемонтируется', async () => {
    const dispose = useHostStore.getState().init(bridge);
    try {
      render(<LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={15} />);
      await flush();
      const lists = (): number => bridge.calls.filter((call) => call.method === 'providers.list').length;
      const before = lists();
      expect(before).toBeGreaterThan(0);
      act(() => bridge.emitStatus({ state: 'disconnected', reason: 'closed' }));
      await flush();
      expect(lists()).toBe(before);
      act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
      await flush();
      expect(lists()).toBe(before + 1);
    } finally {
      dispose();
    }
  });
});

describe('LayoutView — active: false (кусок 2.5)', () => {
  // Клавиши у `LayoutView` больше нет (кусок 6.1b): что они бьют только по активной работе,
  // держит тест 6 куска 6.1b в `AppShell.test.tsx`.
  it('неактивная работа не порталит строку вкладок в заголовок', async () => {
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

      expect(slot.childElementCount).toBe(0);
    } finally {
      slot.remove();
    }
  });
});
