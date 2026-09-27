/**
 * Кусок 2.6, тесты 8, 10, 11, 13: один `DndContext` в `AppShell` накрывает
 * сайдбар и центр; его `onDragEnd` раскладывает броски в раскладку активной
 * работы, бросок в терминал уходит в `onTerminalDrop`; клики под контекстом
 * работают, а перетаскивание начинается со сдвига больше 4 px.
 *
 * `DndContext` обёрнут, чтобы достать его пропы (`onDragEnd`,
 * `collisionDetection`) и проверить, что строка сайдбара и тело группы — под
 * одним контекстом. Сам контекст настоящий.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRect, DndContextProps, DragEndEvent, DroppableContainer } from '@dnd-kit/core';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { onTerminalDrop, type DragSourceData, type DropTargetData } from '../layout/dnd.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { AppShell } from './AppShell.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const captured = vi.hoisted(() => ({ props: [] as unknown[] }));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/core')>();
  const { createElement } = await import('react');
  return {
    ...mod,
    DndContext: (props: DndContextProps) => {
      captured.props.push(props);
      return createElement(
        'div',
        { 'data-testid': 'dnd-root' },
        createElement(mod.DndContext, props),
      );
    },
  };
});

vi.mock('../layout/dnd.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../layout/dnd.js')>();
  return { ...mod, onTerminalDrop: vi.fn() };
});

const state = vi.hoisted(() => ({ terminals: [] as unknown[], disposed: 0 }));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => {
    const instance = {};
    state.terminals.push(instance);
    return {
      cols: 80,
      rows: 24,
      options: { ...initialOptions },
      open: () => {},
      loadAddon: () => {},
      write: () => {},
      reset: () => {},
      dispose: () => {
        state.disposed += 1;
      },
      resize: () => {},
      focus: () => {},
      scrollToBottom: () => {},
      onData: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: () => {},
      hasSelection: () => false,
      getSelection: () => '',
    };
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })),
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({ findNext: () => true })),
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));
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

/** Вкладка терминала по id сессии — короче, чем писать `TabSpec` литералом на каждый вызов (тесты 10, 13, 14 куска 2.4). */
function term(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

function work(id: string, createdAt: string, title: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

let bridge: FakeBridge;

beforeEach(() => {
  state.terminals = [];
  state.disposed = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));

  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: {
      newWork: false,
      newSession: { open: false, parentSessionId: null },
      settings: false,
      createRoom: null,
    },
    visibleSessionRefs: {},
    ui: DEFAULT_UI,
    uiLoaded: true,
    paletteOpen: false,
    picker: null,
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const STATUS = {
  state: 'connected' as const,
  hostVersion: '0.0.0-test',
  methods: [...REQUIRED_METHODS],
};

function keyOf(id: string): string {
  return `/tmp/${id} ${id}`;
}

function lastProps(): DndContextProps {
  const props = captured.props[captured.props.length - 1];
  if (props === undefined) throw new Error('DndContext не смонтирован');
  return props as DndContextProps;
}

const RECT: ClientRect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };

function endEvent(
  source: DragSourceData,
  target: DropTargetData | null,
  point = { x: 400, y: 300 },
): DragEndEvent {
  return {
    active: {
      id: 'drag',
      data: { current: source },
      rect: { current: { initial: null, translated: null } },
    },
    over:
      target === null
        ? null
        : { id: 'over', rect: RECT, disabled: false, data: { current: target } },
    delta: { x: point.x - 1, y: point.y - 1 },
    activatorEvent: new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }),
    collisions: null,
  } as unknown as DragEndEvent;
}

async function renderShell(entries: WorkEntry[]): Promise<void> {
  useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
  render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
  await flush();
  await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).not.toBeNull());
}

async function activate(key: string): Promise<void> {
  act(() => useLayoutStore.getState().setActiveWork(key));
  await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
  await flush();
}

function soleGroupId(key: string): string {
  const layout = useLayoutStore.getState().layouts[key];
  const group = layout === undefined ? undefined : groups(layout)[0];
  if (group === undefined) throw new Error('нет группы');
  return group.id;
}

beforeEach(() => {
  captured.props = [];
  vi.mocked(onTerminalDrop).mockClear();
});

describe('AppShell — сессия из сайдбара в тело группы (тест 8)', () => {
  it('onDragEnd с active строки сессии и over тела открывает вкладку терминала; строка и тело под одним DndContext', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    const key = keyOf('w-01');
    await activate(key);

    const roots = screen.getAllByTestId('dnd-root');
    expect(roots).toHaveLength(1);
    const row = document.querySelector('[data-session-id="s-01"]');
    const groupId = soleGroupId(key);
    const body = document.querySelector(`[data-group-body="${groupId}"]`);
    expect(row).not.toBeNull();
    expect(body).not.toBeNull();
    expect(roots[0]?.contains(row)).toBe(true);
    expect(roots[0]?.contains(body)).toBe(true);
    expect(row?.hasAttribute('data-draggable')).toBe(true);

    act(() =>
      lastProps().onDragEnd?.(
        endEvent(
          { item: { kind: 'session', sessionId: 's-01' } },
          { workKey: key, kind: 'body', groupId },
        ),
      ),
    );
    await flush();

    const layout = useLayoutStore.getState().layouts[key];
    if (layout === undefined) throw new Error('нет раскладки');
    expect(
      groups(layout)
        .find((group) => group.id === groupId)
        ?.tabs.map((tab) => tab.id),
    ).toEqual([tabId.terminal('s-01')]);
  });
});

describe('AppShell — бросок в терминал (тест 10)', () => {
  it('зона terminal раскладку не меняет и зовёт onTerminalDrop(item, sessionId)', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    const key = keyOf('w-01');
    await activate(key);
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-01')));
    });
    await flush();
    const before = useLayoutStore.getState().layouts[key];

    const item = { kind: 'tab', tabId: 'mail' } as const;
    act(() =>
      lastProps().onDragEnd?.(
        endEvent({ item }, { workKey: key, kind: 'terminal', sessionId: 's-01' }),
      ),
    );
    await flush();

    expect(useLayoutStore.getState().layouts[key]).toBe(before);
    expect(onTerminalDrop).toHaveBeenCalledWith(item, 's-01');
  });
});

describe('AppShell — две работы в LRU (тест 11)', () => {
  it('collisionDetection отдаёт тело активной работы, onDragEnd меняет её раскладку, чужая — та же ссылка', async () => {
    await renderShell([
      work('w-01', '2026-01-01', 'Первая', [
        session('s-01', 'один'),
        session('s-11', 'одиннадцать'),
      ]),
      work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]),
    ]);
    const keyA = keyOf('w-01');
    const keyB = keyOf('w-02');
    await activate(keyB);
    act(() => {
      useLayoutStore.getState().apply(keyB, (layout) => openTab(layout, term('s-02')));
    });
    await activate(keyA);
    act(() => {
      useLayoutStore.getState().apply(keyA, (layout) => openTab(layout, term('s-01')));
    });
    await flush();
    expect(document.querySelectorAll('[data-work-container]')).toHaveLength(2);

    const groupA = soleGroupId(keyA);
    const groupB = soleGroupId(keyB);
    const bodyA: DropTargetData = { workKey: keyA, kind: 'body', groupId: groupA };
    const bodyB: DropTargetData = { workKey: keyB, kind: 'body', groupId: groupB };
    const containers = [
      {
        id: 'b',
        key: 'b',
        data: { current: bodyB },
        disabled: false,
        node: { current: null },
        rect: { current: null },
      },
      {
        id: 'a',
        key: 'a',
        data: { current: bodyA },
        disabled: false,
        node: { current: null },
        rect: { current: null },
      },
    ] as DroppableContainer[];
    const source: DragSourceData = { item: { kind: 'session', sessionId: 's-11' } };
    const detect = lastProps().collisionDetection;
    if (detect === undefined) throw new Error('нет collisionDetection');
    const hits = detect({
      active: {
        id: 'drag',
        data: { current: source },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: RECT,
      droppableRects: new Map([
        ['a', RECT],
        ['b', RECT],
      ]),
      droppableContainers: containers,
      pointerCoordinates: { x: 400, y: 300 },
    } as unknown as Parameters<typeof detect>[0]);
    expect(hits.map((hit) => hit.id)).toEqual(['a']);

    const layoutB = useLayoutStore.getState().layouts[keyB];
    act(() =>
      lastProps().onDragEnd?.(
        endEvent(source, hits[0]?.data?.droppableContainer.data.current as DropTargetData),
      ),
    );
    await flush();

    const layoutA = useLayoutStore.getState().layouts[keyA];
    if (layoutA === undefined) throw new Error('нет раскладки A');
    expect(groups(layoutA)[0]?.tabs.map((tab) => tab.id)).toEqual([
      tabId.terminal('s-01'),
      tabId.terminal('s-11'),
    ]);
    expect(useLayoutStore.getState().layouts[keyB]).toBe(layoutB);
  });
});

describe('AppShell — клики под DndContext (тест 13)', () => {
  it('клик по строке сессии открывает вкладку, крестик закрывает; сдвиг на 5 px начинает перетаскивание, на 3 px — нет', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    const key = keyOf('w-01');
    await activate(key);

    const row = document.querySelector<HTMLElement>('[data-session-id="s-01"]');
    if (row === null) throw new Error('нет строки');
    fireEvent.pointerDown(row, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(row, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(row);
    await flush();
    const opened = useLayoutStore.getState().layouts[key];
    if (opened === undefined) throw new Error('нет раскладки');
    expect(groups(opened)[0]?.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-01')]);

    const tab = document.querySelector<HTMLElement>('[role="tab"][data-tab-id="terminal:s-01"]');
    const close = tab?.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (close === null || close === undefined) throw new Error('нет крестика');
    fireEvent.pointerDown(close, { isPrimary: true, button: 0, clientX: 50, clientY: 5 });
    fireEvent.pointerUp(close, { isPrimary: true, button: 0, clientX: 50, clientY: 5 });
    fireEvent.click(close);
    await waitFor(() =>
      expect(groups(useLayoutStore.getState().layouts[key]!)[0]?.tabs).toEqual([]),
    );

    // Порог: 3 px — ещё не перетаскивание.
    fireEvent.pointerDown(row, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 13, clientY: 10 });
    await flush();
    expect(document.querySelector('[data-drag-overlay]')).toBeNull();
    // 5 px — перетаскивание пошло: в DragOverlay — ярлык строки.
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 15, clientY: 10 });
    await flush();
    expect(document.querySelector('[data-drag-overlay]')?.textContent).toContain('S01');
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 15, clientY: 10 });
    await flush();
    expect(document.querySelector('[data-drag-overlay]')).toBeNull();
  });
});
