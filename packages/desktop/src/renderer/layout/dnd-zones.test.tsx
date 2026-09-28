/**
 * Кусок 2.6, тесты 12 и 15: скрытые зоны броска выключены — у неактивной
 * работы все droppable и sortable её `LayoutView` (с `GroupView` и
 * `TabStrip`) зовутся с `disabled: true`; у скрытой вкладки терминала —
 * тоже; индикатор лежит над поверхностями (`z-index` 10), а у корня
 * поверхности и у тела группы `z-index` не задан.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ClientRect, DroppableContainer } from '@dnd-kit/core';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { LayoutNode } from '../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { dndId, layoutCollision, type DragItem, type DropTargetData } from './dnd.js';
import { DropIndicator, setDropPreview } from './DropIndicator.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutView } from './LayoutView.js';
import { useLayoutStore } from './store.js';
import { SurfaceLayer } from './SurfaceLayer.js';

const spies = vi.hoisted(() => ({
  droppable: [] as { id: string; data?: unknown; disabled?: boolean }[],
  sortable: [] as { id: string; data?: unknown; disabled?: unknown }[],
}));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...mod,
    useDroppable: (args: Parameters<typeof mod.useDroppable>[0]) => {
      spies.droppable.push({ id: String(args.id), data: args.data, disabled: args.disabled });
      return mod.useDroppable(args);
    },
  };
});
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...mod,
    useSortable: (args: Parameters<typeof mod.useSortable>[0]) => {
      spies.sortable.push({ id: String(args.id), data: args.data, disabled: args.disabled });
      return mod.useSortable(args);
    },
  };
});

vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })),
}));
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

const PROJECT = '/tmp/p';
const WORK_KEY = '/tmp/p w';

function entry(sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: PROJECT,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: {
        id: 'w',
        title: 'Работа',
        goal: '',
        status: 'active',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      sessions,
      messages: [],
    },
  };
}

function setLayout(root: LayoutNode, activeGroupId: string): void {
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root, activeGroupId, closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

/** Две группы: g1 — [a, x] (активна a), g2 — [b]. */
function twoGroups(): LayoutNode {
  return {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    children: [
      {
        type: 'group',
        id: 'g1',
        tabs: [
          { kind: 'terminal', id: 'terminal:a', sessionId: 'a' },
          { kind: 'terminal', id: 'terminal:x', sessionId: 'x' },
        ],
        activeTabId: 'terminal:a',
      },
      {
        type: 'group',
        id: 'g2',
        tabs: [{ kind: 'terminal', id: 'terminal:b', sessionId: 'b' }],
        activeTabId: 'terminal:b',
      },
    ],
  };
}

let bridge: FakeBridge;

function renderWork(active = true): ReturnType<typeof render> {
  return render(
    <div data-testid="work-container">
      <LayoutView
        workKey={WORK_KEY}
        active={active}
        bridge={bridge}
        fontFamily="Menlo"
        fontSize={13}
      />
      <SurfaceLayer
        workKey={WORK_KEY}
        active={active}
        bridge={bridge}
        fontFamily="Menlo"
        fontSize={13}
        sendDeps={{ bridge, session: () => null, openSession: () => {} }}
      />
    </div>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  spies.droppable = [];
  spies.sortable = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  useWorksStore.setState({
    entries: [entry([session('a', 'альфа'), session('b', 'бета'), session('x', 'икс')])],
    branches: {},
    loading: false,
    error: null,
  });
  useUiStore.setState({ visibleSessionRefs: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Последний вызов хука на каждый id — состояние после последнего рендера. */
function latest<T extends { id: string }>(calls: T[]): T[] {
  const byId = new Map<string, T>();
  for (const call of calls) byId.set(call.id, call);
  return [...byId.values()];
}

describe('скрытые зоны выключены (тест 12)', () => {
  it('у неактивной работы все droppable и sortable раскладки disabled, у активной — нет', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork(false);
    await flush();
    const layoutDroppables = latest(spies.droppable).filter(
      (call) => (call.data as DropTargetData | undefined)?.kind !== 'terminal',
    );
    const sortables = latest(spies.sortable);
    // Тела двух групп и хвосты двух строк; вкладки — три sortable.
    expect(layoutDroppables.length).toBeGreaterThanOrEqual(4);
    expect(sortables).toHaveLength(3);
    for (const call of [...layoutDroppables, ...sortables]) expect(call.disabled).toBe(true);
    for (const call of [...layoutDroppables, ...sortables])
      expect((call.data as DropTargetData).workKey).toBe(WORK_KEY);

    cleanup();
    spies.droppable = [];
    spies.sortable = [];
    renderWork(true);
    await flush();
    const active = [
      ...latest(spies.droppable).filter(
        (call) => (call.data as DropTargetData | undefined)?.kind !== 'terminal',
      ),
      ...latest(spies.sortable),
    ];
    expect(active.length).toBeGreaterThanOrEqual(7);
    for (const call of active) expect(call.disabled).toBe(false);
  });

  it('два терминала в группе: droppable скрытой вкладки disabled; принимаемый предмет над телом — терминал видимой', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork(true);
    await flush();
    const calls = latest(spies.droppable);
    const terminals = calls.filter(
      (call) => (call.data as DropTargetData | undefined)?.kind === 'terminal',
    );
    const bySession = (id: string) =>
      terminals.find((call) => (call.data as { sessionId: string }).sessionId === id);
    expect(bySession('a')?.disabled).toBe(false);
    expect(bySession('x')?.disabled).toBe(true);
    expect(bySession('b')?.disabled).toBe(false);

    // Все зоны группы g1 — на одном прямоугольнике, как в окне: поверхности
    // привязаны к телу своей группы.
    const rect: ClientRect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    const g1 = calls.filter((call) => {
      const data = call.data as DropTargetData;
      return (
        (data.kind === 'body' && data.groupId === 'g1') ||
        (data.kind === 'terminal' && data.sessionId !== 'b')
      );
    });
    const containers = g1
      .filter((call) => call.disabled !== true)
      .map(
        (call) =>
          ({
            id: call.id,
            key: call.id,
            data: { current: call.data },
            disabled: false,
            node: { current: null },
            rect: { current: null },
          }) as DroppableContainer,
      );
    const detect = layoutCollision(WORK_KEY, () => true);
    const hits = detect({
      active: {
        id: 'x',
        data: { current: { item: { kind: 'file', path: '/tmp/f' } } },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: rect,
      droppableRects: new Map(g1.map((call) => [call.id, rect])),
      droppableContainers: containers,
      pointerCoordinates: { x: 400, y: 300 },
    } as unknown as Parameters<ReturnType<typeof layoutCollision>>[0]);
    expect(hits[0]?.data?.droppableContainer.data.current).toEqual({
      workKey: WORK_KEY,
      kind: 'terminal',
      sessionId: 'a',
    });
    const item: DragItem = { kind: 'tab', tabId: 'terminal:b' };
    const plain = layoutCollision(WORK_KEY)({
      active: {
        id: 'x',
        data: { current: { item } },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: rect,
      droppableRects: new Map(g1.map((call) => [call.id, rect])),
      droppableContainers: containers,
      pointerCoordinates: { x: 400, y: 300 },
    } as unknown as Parameters<ReturnType<typeof layoutCollision>>[0]);
    expect((plain[0]?.data?.droppableContainer.data.current as DropTargetData).kind).toBe('body');
  });
});

describe('индикатор над поверхностями (тест 15)', () => {
  it('DropIndicator несёт z-index 10; у корня TerminalSurface и тела группы z-index не задан', async () => {
    const { container } = render(<DropIndicator edge="left" />);
    const indicator = container.querySelector<HTMLElement>('[data-drop-indicator]');
    expect(indicator?.style.zIndex).toBe('10');
    expect(indicator?.style.position).toBe('absolute');
    cleanup();

    setLayout(twoGroups(), 'g1');
    renderWork(true);
    await flush();
    const surfaceRoot = document.querySelector<HTMLElement>(
      '[data-surface-layer] [data-tab-id="terminal:a"]',
    );
    const body = document.querySelector<HTMLElement>('[data-group-body="g1"]');
    if (surfaceRoot === null || body === null) throw new Error('нет поверхности или тела');
    expect(surfaceRoot.style.zIndex).toBe('');
    expect(body.style.zIndex).toBe('');
    expect(surfaceRoot.className).not.toMatch(/\bz-/);
    expect(body.className).not.toMatch(/\bz-/);
  });
});

describe('превью броска перерисовывает только свою зону (раунд исправлений 1, ревью A)', () => {
  const PROJECT_B = '/tmp/q';
  const WORK_KEY_B = '/tmp/q w';

  /** Число рендеров каждого droppable с прошлого сброса: шпион `useDroppable` зовётся на каждый рендер. */
  function renders(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const call of spies.droppable) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
    return counts;
  }

  it('смена зоны над группой g1 работы A не перерисовывает другие группы, поверхности и работу B', async () => {
    // Работа B — те же id групп, вкладок и сессий: превью различает работы по ключу.
    const entryB = { ...entry([session('a', 'альфа'), session('b', 'бета'), session('x', 'икс')]), projectPath: PROJECT_B };
    useWorksStore.setState({ entries: [entry([session('a', 'альфа'), session('b', 'бета'), session('x', 'икс')]), entryB] });
    setLayout(twoGroups(), 'g1');
    useLayoutStore.setState((state) => ({
      layouts: { ...state.layouts, [WORK_KEY_B]: { root: twoGroups(), activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { ...state.hydrated, [WORK_KEY_B]: true },
    }));
    render(
      <>
        <div data-work-container={WORK_KEY}>
          <LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />
          <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
        </div>
        <div data-work-container={WORK_KEY_B}>
          <LayoutView workKey={WORK_KEY_B} active={false} bridge={bridge} fontFamily="Menlo" fontSize={13} />
          <SurfaceLayer workKey={WORK_KEY_B} active={false} bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
        </div>
      </>,
    );
    await flush();
    const bodyA1 = dndId.body(WORK_KEY, 'g1');
    const stripA1 = dndId.strip(WORK_KEY, 'g1');
    const terminalA = dndId.terminal(WORK_KEY, 'terminal:a');
    const all = new Set(spies.droppable.map((call) => call.id));

    // Центр тела g1: индикатор — свой компонент, ни одна зона не перерисована.
    spies.droppable = [];
    act(() => setDropPreview(WORK_KEY, { kind: 'center', groupId: 'g1' }));
    expect(renders().size).toBe(0);
    expect(document.querySelector(`[data-work-container="${WORK_KEY}"] [data-group-body="g1"] [data-drop-indicator="center"]`)).not.toBeNull();
    expect(document.querySelectorAll('[data-drop-indicator]')).toHaveLength(1);

    // Та же зона ещё раз — никто не перерисован.
    spies.droppable = [];
    act(() => setDropPreview(WORK_KEY, { kind: 'center', groupId: 'g1' }));
    expect(renders().size).toBe(0);

    // Край того же тела — снова без перерисовки зон; строка g1 — только она.
    spies.droppable = [];
    act(() => setDropPreview(WORK_KEY, { kind: 'edge', groupId: 'g1', edge: 'left' }));
    expect(renders().size).toBe(0);
    expect(document.querySelector('[data-drop-indicator="left"]')).not.toBeNull();
    spies.droppable = [];
    act(() => setDropPreview(WORK_KEY, { kind: 'strip', groupId: 'g1', index: 1 }));
    expect([...renders().keys()]).toEqual([stripA1]);
    expect(document.querySelectorAll('[data-drop-indicator]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-drop-line]')).toHaveLength(1);

    // Терминал сессии a: только его поверхность в A (и строка g1 гасит линию).
    spies.droppable = [];
    act(() => setDropPreview(WORK_KEY, { kind: 'terminal', sessionId: 'a' }));
    expect(new Set(renders().keys())).toEqual(new Set([stripA1, terminalA]));

    // Конец перетаскивания: гаснет только терминал; прочие droppable
    // (другие группы, поверхности, вся работа B) не перерисовывались ни разу.
    spies.droppable = [];
    act(() => setDropPreview(null, null));
    expect([...renders().keys()]).toEqual([terminalA]);
    const untouched = [...all].filter((id) => ![stripA1, terminalA].includes(id));
    expect(untouched).toContain(bodyA1);
    expect(untouched.length).toBeGreaterThanOrEqual(10);
    expect(untouched.some((id) => id.includes(WORK_KEY_B))).toBe(true);
    expect(document.querySelectorAll('[data-drop-indicator], [data-drop-line]')).toHaveLength(0);
  });
});
