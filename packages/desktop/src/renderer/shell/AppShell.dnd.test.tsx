/**
 * Кусок 2.6, тесты 8, 10, 11, 13: один `DndContext` в `AppShell` накрывает
 * сайдбар и центр; его `onDragEnd` раскладывает броски в раскладку активной
 * работы; клики под контекстом работают, а перетаскивание начинается со сдвига
 * больше 4 px. Кусок 7.2, тесты 7 и 8: файл «Файлов» на терминал — `pty.send`
 * с путём (`sendWithToast`), в тело — вкладка файла; без `pty.send` у хоста
 * зоны терминала нет.
 *
 * `DndContext` обёрнут, чтобы достать его пропы (`onDragEnd`,
 * `collisionDetection`) и проверить, что строка сайдбара и тело группы — под
 * одним контекстом. Сам контекст настоящий.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRect, DndContextProps, DragEndEvent, DroppableContainer } from '@dnd-kit/core';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { toast } from 'sonner';
import type { DragItem, DragSourceData, DropTargetData } from '../layout/dnd.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { AppShell } from './AppShell.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { roomKey } from '../lib/room-view.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

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
  xtermMock.reset();
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
      newSession: { open: false, work: null, room: false },
      settings: false,
      mergeRoom: null,
      restartHost: false,
    },
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
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  useHostStore.getState().init(bridge);
});

afterEach(() => useHostStore.setState({ status: { state: 'connecting' } }));

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
  it('вкладка в зоне terminal ничего не делает: раскладка та же, pty.send нет', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    const key = keyOf('w-01');
    await activate(key);
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-01')));
    });
    await flush();
    const before = useLayoutStore.getState().layouts[key];

    act(() =>
      lastProps().onDragEnd?.(
        endEvent({ item: { kind: 'tab', tabId: 'mail' } }, { workKey: key, kind: 'terminal', sessionId: 's-01' }),
      ),
    );
    await flush();

    expect(useLayoutStore.getState().layouts[key]).toBe(before);
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
  });
});

describe('AppShell — файл «Файлов» на терминал и в тело (тесты 7, 8 куска 7.2)', () => {
  const WORKTREE = { path: "/wt/it's s02", branch: 'harnas/w-0001/s02', base: 'main', createdAt: '2026-01-01' };
  const FILE_ITEM = (key: string): DragItem => ({ kind: 'file', root: { workKey: key, spec: { kind: 'worktree', sessionId: 's-02' } }, path: 'src/a b.ts' });
  const REF = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-02' };

  async function setup(): Promise<string> {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [{ ...session('s-02', 'два'), worktree: WORKTREE }])]);
    const key = keyOf('w-01');
    await activate(key);
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-02')));
    });
    await flush();
    return key;
  }

  function collide(key: string, item: DragItem): string[] {
    const groupId = soleGroupId(key);
    const containers = [
      { id: 'body', key: 'body', data: { current: { workKey: key, kind: 'body', groupId } }, disabled: false, node: { current: null }, rect: { current: null } },
      { id: 'term', key: 'term', data: { current: { workKey: key, kind: 'terminal', sessionId: 's-02' } }, disabled: false, node: { current: null }, rect: { current: null } },
    ] as DroppableContainer[];
    const detect = lastProps().collisionDetection;
    if (detect === undefined) throw new Error('нет collisionDetection');
    return detect({
      active: { id: 'drag', data: { current: { item } }, rect: { current: { initial: null, translated: null } } },
      collisionRect: RECT,
      droppableRects: new Map([['body', RECT], ['term', RECT]]),
      droppableContainers: containers,
      pointerCoordinates: { x: 400, y: 300 },
    } as unknown as Parameters<typeof detect>[0]).map((hit) => String(hit.id));
  }

  it('тест 7: на терминал — pty.send с экранированным абсолютным путём и submit: false, раскладка та же; в центр тела — вкладка файла', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: null }));
    const key = await setup();
    const item = FILE_ITEM(key);
    expect(collide(key, item)[0]).toBe('term');
    const before = useLayoutStore.getState().layouts[key];

    act(() => lastProps().onDragEnd?.(endEvent({ item }, { workKey: key, kind: 'terminal', sessionId: 's-02' })));
    await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'pty.send')).toHaveLength(1));
    expect(bridge.calls.find((call) => call.method === 'pty.send')?.params).toEqual({
      ref: REF,
      text: "'/wt/it'\\''s s02/src/a b.ts' ",
      submit: false,
    });
    expect(useLayoutStore.getState().layouts[key]).toBe(before);

    const groupId = soleGroupId(key);
    act(() => lastProps().onDragEnd?.(endEvent({ item }, { workKey: key, kind: 'body', groupId })));
    await flush();
    const tabs = groups(useLayoutStore.getState().layouts[key]!)[0]?.tabs;
    expect(tabs?.map((tab) => tab.id)).toEqual([tabId.terminal('s-02'), 'file:w:s-02:src/a b.ts']);
  });

  it('тест 8: ответ blocked — тост «S02 is waiting for your answer — text not inserted» с Copy; хост без pty.send — зоны терминала нет, файл вкладкой', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    const key = await setup();
    const item = FILE_ITEM(key);
    act(() => lastProps().onDragEnd?.(endEvent({ item }, { workKey: key, kind: 'terminal', sessionId: 's-02' })));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe('S02 is waiting for your answer — text not inserted');
    expect(vi.mocked(toast.error).mock.calls[0]?.[1]).toMatchObject({ action: { label: 'Copy' } });

    act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'pty.send')));
    await flush();
    const hits = collide(key, item);
    expect(hits).toEqual(['body']);
    act(() => lastProps().onDragEnd?.(endEvent({ item }, { workKey: key, kind: 'body', groupId: soleGroupId(key) })));
    await flush();
    expect(groups(useLayoutStore.getState().layouts[key]!)[0]?.tabs.map((tab) => tab.id)).toContain('file:w:s-02:src/a b.ts');
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toHaveLength(1);
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

describe('AppShell — щит над страницами на время перетаскивания (тест 9 куска 9.2b)', () => {
  async function startDrag(): Promise<HTMLElement> {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activate(keyOf('w-01'));
    const row = document.querySelector<HTMLElement>('[data-session-id="s-01"]');
    if (row === null) throw new Error('нет строки');
    expect(screen.queryByTestId('drag-shield')).toBeNull();
    fireEvent.pointerDown(row, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 20, clientY: 10 });
    await flush();
    return row;
  }

  it('во время перетаскивания щит есть, после броска — нет', async () => {
    await startDrag();
    const shield = screen.getByTestId('drag-shield');
    expect(shield.className).toContain('fixed');
    expect(shield.className).toContain('inset-0');
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 20, clientY: 10 });
    await flush();
    expect(screen.queryByTestId('drag-shield')).toBeNull();
  });

  it('после отмены (Esc) — нет', async () => {
    await startDrag();
    expect(screen.getByTestId('drag-shield')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await flush();
    expect(screen.queryByTestId('drag-shield')).toBeNull();
  });
});

describe('AppShell — бросок сессии на строки сайдбара (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5)', () => {
  const PROJECT = '/tmp/w-01';
  const key = keyOf('w-01');
  const other = keyOf('w-02');

  // Развёрнутость строк комнат живёт в сторе окна и переходит из теста в тест — каждый начинает со свёрнутых.
  beforeEach(() => useUiStore.setState({ roomExpanded: {} }));

  /** s-01 и s-02 вне комнат; s-03 и s-04 — в комнате r-01; s-05 закрыта. Вторая работа w-02 — чужая. */
  const entries = (): WorkEntry[] => [
    makeWork('w-01', {
      projectPath: PROJECT,
      title: 'Первая',
      sessions: [
        makeSession('s-01', 'один'),
        makeSession('s-02', 'два'),
        makeSession('s-03', 'три'),
        makeSession('s-04', 'четыре'),
        makeSession('s-05', 'пять', { lifecycle: 'closed' }),
      ],
      rooms: [{ ...makeRoom('r-01', 'Возвраты'), members: ['s-03', 's-04'], lead: 's-03' }],
    }),
    makeWork('w-02', {
      projectPath: '/tmp/w-02',
      title: 'Вторая',
      sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два')],
      rooms: [{ ...makeRoom('r-01', 'Чужая'), members: ['s-02'], lead: 's-02' }],
    }),
  ];

  async function setup(): Promise<void> {
    bridge.setHandler('rooms.addMember', () => ({ messageId: 'm-1' }));
    bridge.setHandler('rooms.create', () => ({ roomId: 'r-02' }));
    await renderShell(entries());
    await activate(key);
  }

  const drop = (sessionId: string, target: DropTargetData): void =>
    act(() => lastProps().onDragEnd?.(endEvent({ item: { kind: 'session', sessionId } }, target)));
  const callsOf = (method: string): unknown[] => bridge.calls.filter((call) => call.method === method).map((call) => call.params);

  it('сессия на сессию — диалог «New room» из двух сессий: ведущая — та, на которую бросили; комнаты и вызовов ещё нет', async () => {
    await setup();
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-02' });
    expect(useUiStore.getState().dialogs.mergeRoom).toEqual({ projectPath: PROJECT, workId: 'w-01', dragged: 's-01', target: 's-02' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New room' })).toBeTruthy();
    expect(within(dialog).getByText('S02 два and S01 один move into the room.')).toBeTruthy();
    expect(callsOf('rooms.create')).toEqual([]);
    expect(callsOf('rooms.addMember')).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(callsOf('rooms.create')[0]).toEqual({
      projectPath: PROJECT,
      workId: 'w-01',
      title: 'Room 2',
      members: ['s-02', 's-01'],
      lead: 's-02',
      origin: ['s-01', 's-02'],
      quiet: true,
    });
  });

  it('после «Create room» диалога 1.6 вкладка комнаты открывается, когда снимок принёс комнату: диалог к тому времени закрыт, ожидание живо', async () => {
    await setup();
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-02' });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(useUiStore.getState().dialogs.mergeRoom).toBeNull());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const tabIds = (): string[] => {
      const layout = useLayoutStore.getState().layouts[key];
      return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
    };
    // Снимка с комнатой ещё нет — вкладки нет; пришёл — открыта, строка развёрнута.
    expect(tabIds()).not.toContain(tabId.room('r-02'));
    const [first, ...rest] = entries();
    if (first === undefined) throw new Error('нет работы');
    const withRoom: WorkEntry = {
      ...first,
      map: { ...first.map, rooms: [...first.map.rooms, { ...makeRoom('r-02', 'Room 2'), members: ['s-02', 's-01'], lead: 's-02' }] },
    };
    act(() => useWorksStore.setState({ entries: [withRoom, ...rest] }));
    await waitFor(() => expect(tabIds()).toContain(tabId.room('r-02')));
    expect(useUiStore.getState().roomExpanded[roomKey(key, 'r-02')]).toBe(true);
  });

  it('сессия на строку комнаты — rooms.addMember, строка комнаты разворачивается; диалога нет', async () => {
    await setup();
    drop('s-01', { workKey: key, kind: 'room-row', roomId: 'r-01' });
    await waitFor(() => expect(callsOf('rooms.addMember')).toHaveLength(1));
    expect(callsOf('rooms.addMember')[0]).toEqual({ projectPath: PROJECT, workId: 'w-01', roomId: 'r-01', sessionId: 's-01' });
    await waitFor(() => expect(useUiStore.getState().roomExpanded[roomKey(key, 'r-01')]).toBe(true));
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
    expect(callsOf('rooms.create')).toEqual([]);
  });

  it('из одной комнаты в другую — тоже rooms.addMember (правило одной комнаты — у хоста)', async () => {
    await setup();
    act(() =>
      useWorksStore.setState({
        entries: [
          makeWork('w-01', {
            projectPath: PROJECT,
            title: 'Первая',
            sessions: [makeSession('s-01', 'один'), makeSession('s-03', 'три')],
            rooms: [
              { ...makeRoom('r-01', 'Возвраты'), members: ['s-03'], lead: 's-03' },
              { ...makeRoom('r-02', 'Отчёты'), members: ['s-01'], lead: 's-01' },
            ],
          }),
        ],
      }),
    );
    drop('s-03', { workKey: key, kind: 'room-row', roomId: 'r-02' });
    await waitFor(() => expect(callsOf('rooms.addMember')).toHaveLength(1));
    expect(callsOf('rooms.addMember')[0]).toMatchObject({ roomId: 'r-02', sessionId: 's-03' });
  });

  it('отказ rooms.addMember — тост «Couldn\'t add the session to the room: …», строка не разворачивается', async () => {
    vi.mocked(toast).mockClear();
    bridge.setHandler('rooms.addMember', () => {
      throw { code: 'bad_request', message: 'сессия закрыта' };
    });
    await renderShell(entries());
    await activate(key);
    drop('s-01', { workKey: key, kind: 'room-row', roomId: 'r-01' });
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("Couldn't add the session to the room: invalid request."));
    expect(useUiStore.getState().roomExpanded[roomKey(key, 'r-01')]).toBeUndefined();
  });

  it('нельзя — ни вызова, ни диалога: на себя, в свою комнату, на закрытую, закрытую сессию, вкладку', async () => {
    await setup();
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-01' }); // на себя
    drop('s-03', { workKey: key, kind: 'room-row', roomId: 'r-01' }); // в свою комнату
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-05' }); // на закрытую
    drop('s-05', { workKey: key, kind: 'session-row', sessionId: 's-01' }); // закрытую сессию
    drop('s-05', { workKey: key, kind: 'room-row', roomId: 'r-01' });
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-99' }); // цели уже нет
    drop('s-01', { workKey: key, kind: 'room-row', roomId: 'r-99' });
    act(() => lastProps().onDragEnd?.(endEvent({ item: { kind: 'tab', tabId: 'mail' } }, { workKey: key, kind: 'room-row', roomId: 'r-01' })));
    await flush();
    expect(callsOf('rooms.addMember')).toEqual([]);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
  });

  it('чужая работа — отказ: цель другой работы (не активной) ничего не открывает и не зовёт', async () => {
    await setup();
    // s-01 тащат из активной работы, а строка комнаты и сессии — в w-02: `layoutCollision` их не отдаёт, а если бы отдал — бросок отклонён.
    drop('s-01', { workKey: other, kind: 'room-row', roomId: 'r-01' });
    drop('s-01', { workKey: other, kind: 'session-row', sessionId: 's-02' });
    await flush();
    expect(callsOf('rooms.addMember')).toEqual([]);
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
    // Раскладка чужой работы не тронута, активная не сменилась.
    expect(useLayoutStore.getState().activeWorkKey).toBe(key);
  });

  it('и collisionDetection не отдаёт строки чужой работы; строки активной — отдаёт только сессии', async () => {
    await setup();
    const detect = lastProps().collisionDetection;
    if (detect === undefined) throw new Error('нет collisionDetection');
    const containers = [
      { id: 'mine', key: 'mine', data: { current: { workKey: key, kind: 'room-row', roomId: 'r-01' } }, disabled: false, node: { current: null }, rect: { current: null } },
      { id: 'theirs', key: 'theirs', data: { current: { workKey: other, kind: 'room-row', roomId: 'r-01' } }, disabled: false, node: { current: null }, rect: { current: null } },
    ] as DroppableContainer[];
    const around = (item: DragItem): string[] =>
      detect({
        active: { id: 'drag', data: { current: { item } }, rect: { current: { initial: null, translated: null } } },
        collisionRect: RECT,
        droppableRects: new Map([['mine', RECT], ['theirs', RECT]]),
        droppableContainers: containers,
        pointerCoordinates: { x: 400, y: 300 },
      } as unknown as Parameters<typeof detect>[0]).map((hit) => String(hit.id));
    expect(around({ kind: 'session', sessionId: 's-01' })).toEqual(['mine']);
    expect(around({ kind: 'tab', tabId: 'mail' })).toEqual([]);
  });

  it('хост без rooms.addMember — на строку комнаты бросать нечем: вызова нет; без rooms.create — диалога 1.6 нет', async () => {
    bridge.setHandler('rooms.addMember', () => ({ messageId: 'm-1' }));
    await renderShell(entries());
    await activate(key);
    act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'rooms.addMember')));
    drop('s-01', { workKey: key, kind: 'room-row', roomId: 'r-01' });
    await flush();
    expect(callsOf('rooms.addMember')).toEqual([]);

    act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'rooms.create')));
    drop('s-01', { workKey: key, kind: 'session-row', sessionId: 's-02' });
    await flush();
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
  });

  it('бросок в раскладку работает как раньше: сессия в тело группы — вкладка терминала, ни диалога, ни rooms.*', async () => {
    await setup();
    const groupId = soleGroupId(key);
    act(() => lastProps().onDragEnd?.(endEvent({ item: { kind: 'session', sessionId: 's-01' } }, { workKey: key, kind: 'body', groupId })));
    await flush();
    const layout = useLayoutStore.getState().layouts[key];
    if (layout === undefined) throw new Error('нет раскладки');
    expect(groups(layout).find((group) => group.id === groupId)?.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-01')]);
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
    expect(callsOf('rooms.addMember')).toEqual([]);
  });
});
