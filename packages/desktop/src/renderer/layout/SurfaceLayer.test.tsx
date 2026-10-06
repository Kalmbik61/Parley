/**
 * Тесты 2, 3, 5, 12, 13, 14, 17 куска 2.5: слой поверхностей работы рядом с
 * её `LayoutView` — так их монтирует контейнер работы в `AppShell.tsx`.
 * xterm подменён фейком со счётчиками конструктора и `dispose`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { refKey, type Result } from '@parley/protocol';
import type { WorkEntry, WorkSession } from '@parley/core';
import type { LayoutNode } from '../../shared/layout-types.js';
import { resetFeedStoreForTests, useFeedStore } from '../chat/store.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity } from '../test-utils/work-fixtures.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import { terminalSurfaces } from '../terminal/surface-registry.js';
import { XTERM_LIGHT } from '../terminal/xterm-themes.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutView } from './LayoutView.js';
import { useLayoutStore } from './store.js';
import { SurfaceLayer } from './SurfaceLayer.js';
import { tabMeta } from './tab-meta.js';
import { focusTab, moveTab, updateTab } from './tree.js';

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

const PROJECT = '/tmp/p';
const WORK_KEY = '/tmp/p w';

function entry(sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: PROJECT,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

function refOf(sessionId: string): { projectPath: string; workId: string; sessionId: string } {
  return { projectPath: PROJECT, workId: 'w', sessionId };
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
      { type: 'group', id: 'g2', tabs: [{ kind: 'terminal', id: 'terminal:b', sessionId: 'b' }], activeTabId: 'terminal:b' },
    ],
  };
}

let bridge: FakeBridge;

function renderWork(active = true): ReturnType<typeof render> {
  return render(
    <div data-testid="work-container">
      <LayoutView workKey={WORK_KEY} active={active} bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
      <SurfaceLayer workKey={WORK_KEY} active={active} bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
    </div>,
  );
}

function surface(tabId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-surface-layer] [data-tab-id="${tabId}"]`);
}

function attachCount(sessionId: string): number {
  return bridge.calls.filter(
    (call) => call.method === 'pty.attach' && (call.params as { ref: { sessionId: string } }).ref.sessionId === sessionId,
  ).length;
}

function detachCount(sessionId: string): number {
  return bridge.calls.filter(
    (call) => call.method === 'pty.detach' && (call.params as { ref: { sessionId: string } }).ref.sessionId === sessionId,
  ).length;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  xtermMock.reset();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: 'СНИМОК', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  useWorksStore.setState({
    entries: [entry([session('a', 'альфа'), session('b', 'бета'), session('x', 'икс')])],
    branches: {},
    loading: false,
    error: null,
  });
  useUiStore.setState({ visibleSessionRefs: {} });
  act(() => useUiStore.getState().setDark(true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => useUiStore.getState().setDark(false));
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

describe('SurfaceLayer — перенос вкладки (тест 2)', () => {
  it('Terminal создан один раз, pty.attach не прибавилось, data-mount-id прежний, меняется только якорь', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();

    const before = surface('terminal:a');
    if (before === null) throw new Error('нет поверхности terminal:a');
    const mountId = before.dataset.mountId;
    expect(mountId).toMatch(/.+/);
    expect(before.style.getPropertyValue('position-anchor')).toBe('--g-g1');
    const constructed = xtermMock.constructed;
    const attaches = attachCount('a');
    expect(attaches).toBe(1);

    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => moveTab(layout, 'terminal:a', { groupId: 'g2', index: 1 }));
    });
    await flush();

    const after = surface('terminal:a');
    expect(after).toBe(before);
    expect(after?.dataset.mountId).toBe(mountId);
    expect(after?.style.getPropertyValue('position-anchor')).toBe('--g-g2');
    expect(xtermMock.constructed).toBe(constructed);
    expect(attachCount('a')).toBe(attaches);
    // Тело группы объявляет якорь, к которому привязана поверхность.
    expect(document.querySelector<HTMLElement>('[data-group-body="g2"]')?.style.getPropertyValue('anchor-name')).toBe('--g-g2');
  });
});

describe('SurfaceLayer — видимость (тесты 3, 17)', () => {
  it('тест 3: вкладка стала неактивной → pty.detach, снова активной → pty.attach со снимком', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(attachCount('a')).toBe(1);
    expect(attachCount('x')).toBe(0);
    expect(surface('terminal:x')?.style.visibility).toBe('hidden');
    expect(surface('terminal:x')?.hasAttribute('inert')).toBe(true);
    expect(surface('terminal:a')?.hasAttribute('inert')).toBe(false);

    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => focusTab(layout, 'terminal:x'));
    });
    await flush();
    expect(detachCount('a')).toBe(1);
    expect(attachCount('x')).toBe(1);
    expect(surface('terminal:a')?.style.visibility).toBe('hidden');
    expect(surface('terminal:a')?.hasAttribute('inert')).toBe(true);

    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => focusTab(layout, 'terminal:a'));
    });
    await flush();
    expect(attachCount('a')).toBe(2);
    expect(xtermMock.constructed).toBe(3);
  });

  it('тест 17: visibleSessionRefs держит refKey видимой поверхности; неактивная или размонтированная — ключа нет', async () => {
    setLayout(twoGroups(), 'g1');
    const { unmount } = renderWork();
    await flush();
    const visible = (): Record<string, true> => useUiStore.getState().visibleSessionRefs;
    expect(visible()[refKey(refOf('a'))]).toBe(true);
    expect(visible()[refKey(refOf('b'))]).toBe(true);
    expect(refKey(refOf('x')) in visible()).toBe(false);

    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => focusTab(layout, 'terminal:x'));
    });
    await flush();
    expect(refKey(refOf('a')) in visible()).toBe(false);
    expect(visible()[refKey(refOf('x'))]).toBe(true);

    unmount();
    expect(visible()).toEqual({});
  });
});

describe('SurfaceLayer — реестр terminalSurfaces (тест 5)', () => {
  it('ключ есть, пока поверхность смонтирована', async () => {
    setLayout(twoGroups(), 'g1');
    const { unmount } = renderWork();
    await flush();
    expect(terminalSurfaces.has(refKey(refOf('a')))).toBe(true);
    expect(terminalSurfaces.has(refKey(refOf('x')))).toBe(true);

    await act(async () => {
      await useLayoutStore.getState().requestCloseTabs(WORK_KEY, ['terminal:x']);
    });
    await flush();
    expect(terminalSurfaces.has(refKey(refOf('x')))).toBe(false);
    expect(terminalSurfaces.has(refKey(refOf('a')))).toBe(true);

    unmount();
    expect(terminalSurfaces.has(refKey(refOf('a')))).toBe(false);
  });
});

describe('SurfaceLayer — стабильный sessionRef (раунд fix-main-r1, п.5)', () => {
  it('перерисовка слоя с тем же ref не переустанавливает слушатель paste поверхности', async () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    try {
      setLayout(twoGroups(), 'g1');
      const view = renderWork();
      await flush();
      const pasteListeners = (): number => add.mock.calls.filter(([type]) => type === 'paste').length;
      const before = pasteListeners();
      expect(before).toBeGreaterThan(0);

      // Слой перерисован (новая раскладка того же набора вкладок), поля ref не менялись.
      act(() => useLayoutStore.getState().apply(WORK_KEY, (layout) => focusTab(layout, 'terminal:x')));
      view.rerender(
        <div data-testid="work-container">
          <LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
          <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
        </div>,
      );
      await flush();
      expect(pasteListeners()).toBe(before);
    } finally {
      add.mockRestore();
    }
  });
});

describe('SurfaceLayer — фон обёртки отступа (тест 12)', () => {
  it('#0b0a09 (лист окна) при dark; после setDark(false) — фон XTERM_LIGHT, Terminal не создан заново', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    const pad = surface('terminal:a')?.querySelector<HTMLElement>('[data-testid="terminal-surface-pad"]');
    if (pad === null || pad === undefined) throw new Error('нет обёртки отступа');
    expect(pad.style.backgroundColor).toBe('rgb(11, 10, 9)');
    const constructed = xtermMock.constructed;

    act(() => useUiStore.getState().setDark(false));
    const probe = document.createElement('div');
    probe.style.backgroundColor = XTERM_LIGHT.background ?? '';
    expect(pad.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(xtermMock.constructed).toBe(constructed);
  });
});

describe('SurfaceLayer — удалённая сессия (тест 13)', () => {
  it('в слое нет поверхности её вкладки, в теле видна MissingBody, «Close» убирает вкладку', async () => {
    const root: LayoutNode = {
      type: 'group',
      id: 'g1',
      tabs: [{ kind: 'terminal', id: 'terminal:gone', sessionId: 'gone' }],
      activeTabId: 'terminal:gone',
    };
    setLayout(root, 'g1');
    renderWork();
    await flush();

    expect(surface('terminal:gone')).toBeNull();
    expect(attachCount('gone')).toBe(0);
    const body = document.querySelector<HTMLElement>('[data-group-body="g1"]');
    if (body === null) throw new Error('нет тела группы');
    expect(within(body).getByText('Session deleted')).toBeTruthy();
    fireEvent.click(within(body).getByRole('button', { name: 'Close' }));
    await flush();
    const layout = useLayoutStore.getState().layouts[WORK_KEY];
    expect(layout?.root.type === 'group' ? layout.root.tabs : null).toEqual([]);
  });
});

describe('SurfaceLayer — граница ошибки поверхности (тест 14)', () => {
  it('xterm одной вкладки бросает: запасной вид с заголовком внутри корня, «Close» — requestCloseTabs; соседняя жива', async () => {
    // Порядок поверхностей — по id вкладки: первым конструируется terminal:a.
    xtermMock.throwOnCall = 1;
    const requestClose = vi.spyOn(useLayoutStore.getState(), 'requestCloseTabs');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setLayout(twoGroups(), 'g1');
      renderWork();
      await flush();

      const root = surface('terminal:a');
      if (root === null) throw new Error('корень поверхности terminal:a размонтирован');
      const fallback = within(root);
      const title = tabMeta({ kind: 'terminal', id: 'terminal:a', sessionId: 'a' }, useWorksStore.getState().entries[0] ?? null).title;
      expect(fallback.getByText(title)).toBeTruthy();
      fireEvent.click(fallback.getByRole('button', { name: 'Close' }));
      expect(requestClose).toHaveBeenCalledWith(WORK_KEY, ['terminal:a']);

      // Соседняя поверхность (terminal:b, другая группа) жива.
      expect(surface('terminal:b')?.querySelector('[data-testid="terminal-surface-pad"]')).not.toBeNull();
      expect(xtermMock.disposed).toBe(0);
    } finally {
      spy.mockRestore();
      requestClose.mockRestore();
    }
  });
});

describe('SurfaceLayer — вкладка браузера (тест 4 куска 9.2a)', () => {
  it('перенос между группами: ключ и webview прежние, узлы слоя не переставлены, меняется только якорь', async () => {
    const root = twoGroups();
    if (root.type !== 'split' || root.children[0].type !== 'group') throw new Error('не та раскладка');
    const browser = { kind: 'browser' as const, id: 'browser:0a0a0a', url: 'http://localhost:5173/' };
    root.children[0] = { ...root.children[0], tabs: [...root.children[0].tabs, browser], activeTabId: browser.id };
    setLayout(root, 'g1');
    renderWork();
    await flush();

    const layer = document.querySelector('[data-surface-layer]');
    const order = (): string[] => [...(layer?.children ?? [])].map((node) => (node as HTMLElement).dataset.tabId ?? '');
    const before = surface(browser.id);
    const view = before?.querySelector('webview');
    if (before === null || view === null || view === undefined) throw new Error('нет поверхности браузера');
    const orderBefore = order();
    expect(orderBefore).toEqual([...orderBefore].sort());
    expect(before.style.getPropertyValue('position-anchor')).toBe('--g-g1');

    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => moveTab(layout, browser.id, { groupId: 'g2', index: 0 }));
    });
    await flush();

    const after = surface(browser.id);
    expect(after).toBe(before);
    expect(after?.querySelector('webview')).toBe(view);
    expect(after?.style.getPropertyValue('position-anchor')).toBe('--g-g2');
    expect(order()).toEqual(orderBefore);
    // Тело группы с вкладкой браузера — без запасного вида ошибки.
    expect(document.body.textContent).not.toContain("Couldn't show layout");
  });
});

describe('SurfaceLayer — вид «Chat» (план 2026-10-01, решение 6, решение контролёра Ж)', () => {
  const FEED_METHODS = [...REQUIRED_METHODS, 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe'];
  let disposeFeed: () => void = () => {};

  beforeEach(() => {
    resetFeedStoreForTests();
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: FEED_METHODS } });
    bridge.setHandler('feed.subscribe', () => ({ ok: true }));
    bridge.setHandler('feed.unsubscribe', () => ({ ok: true }));
    bridge.setHandler('feed.snapshot', () => ({ items: [], revision: 0, schemaVersion: 1, mode: null }));
    // Сессии стартовали (есть событие журнала): без явного выбора вид — чат (кусок 4a, решение М).
    useActivityStore.setState({
      byRef: activityMap(['a', 'b', 'x'].map((id) => makeActivity(refOf(id), 'idle'))),
      loaded: true,
    });
    disposeFeed = useFeedStore.getState().init(bridge);
    useProvidersStore.setState({
      providers: [{ id: 'claude', label: 'Claude Code', available: true, version: '2.1.286', limits: null }],
      loaded: true,
    });
  });

  afterEach(() => {
    disposeFeed();
    resetFeedStoreForTests();
    useActivityStore.setState({ byRef: {}, loaded: false });
    useHostStore.setState({ status: { state: 'connecting' } });
    useProvidersStore.setState({ providers: [], loaded: false });
  });

  const feedCalls = (method: string, sessionId: string): number =>
    bridge.calls.filter(
      (call) => call.method === method && (call.params as { ref: { sessionId: string } }).ref.sessionId === sessionId,
    ).length;

  const setView = (tabId: string, view: 'chat' | 'terminal'): void => {
    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => updateTab(layout, tabId, { view }));
    });
  };

  it('Claude без поля view — чат: поверхности нет, лента подписана, сессия видима', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(screen.getAllByTestId('chat-view')).toHaveLength(2); // a в g1 и b в g2
    expect(attachCount('a')).toBe(0);
    // Подписка — на каждую открытую вкладку в чате, не только активную: x в g1 скрыта.
    expect(feedCalls('feed.subscribe', 'x')).toBe(1);
    expect(useUiStore.getState().visibleSessionRefs[refKey(refOf('a'))]).toBe(true);
    expect(useUiStore.getState().visibleSessionRefs[refKey(refOf('x'))]).toBeUndefined();
  });

  it('сессия ещё не стартовала (нет lastEventAt) — терминал; первое событие журнала переводит в чат', async () => {
    useActivityStore.setState({ byRef: {} });
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(surface('terminal:a')).not.toBeNull();
    expect(attachCount('a')).toBe(1);
    expect(bridge.calls.some((call) => call.method.startsWith('feed.'))).toBe(false);
    expect(screen.queryByTestId('chat-view')).toBeNull();

    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(refOf('a'), 'working')]) });
    });
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(detachCount('a')).toBe(1);
    expect(feedCalls('feed.subscribe', 'a')).toBe(1);
    // b и x событий не имели — остаются терминалами.
    expect(surface('terminal:b')).not.toBeNull();
  });

  it('снимок активности ещё не пришёл — ни поверхности, ни подписки; после снимка — терминал', async () => {
    useActivityStore.setState({ byRef: {}, loaded: false });
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(attachCount('a')).toBe(0);
    expect(bridge.calls.some((call) => call.method.startsWith('feed.'))).toBe(false);

    act(() => {
      useActivityStore.setState({ loaded: true });
    });
    await flush();
    expect(surface('terminal:a')).not.toBeNull();
    expect(attachCount('a')).toBe(1);
  });

  it('view terminal — поверхность под тулбаром; переход туда и обратно монтирует её заново', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();

    setView('terminal:a', 'terminal');
    await flush();
    const first = surface('terminal:a');
    if (first === null) throw new Error('нет поверхности terminal:a');
    const mountId = first.dataset.mountId;
    // jsdom переставляет слагаемые calc и роняет голый anchor(): сверяем только отступ.
    expect(first.style.getPropertyValue('top')).toContain('36px');
    expect(first.style.getPropertyValue('height')).toContain('36px');
    expect(attachCount('a')).toBe(1);
    expect(feedCalls('feed.unsubscribe', 'a')).toBe(1);
    expect(within(document.querySelector<HTMLElement>('[data-group-body="g1"]')!).getAllByTestId('chat-toolbar')).toHaveLength(1);

    setView('terminal:a', 'chat');
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(detachCount('a')).toBe(1);
    expect(feedCalls('feed.subscribe', 'a')).toBe(2);

    setView('terminal:a', 'terminal');
    await flush();
    const second = surface('terminal:a');
    expect(second).not.toBeNull();
    expect(second?.dataset.mountId).not.toBe(mountId);
    expect(attachCount('a')).toBe(2);
  });

  it('клик по сегменту Terminal пишет view в раскладку', async () => {
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    const body = within(document.querySelector<HTMLElement>('[data-group-body="g1"]')!);
    fireEvent.click(body.getByRole('radio', { name: 'Terminal' }));
    await flush();
    const layout = useLayoutStore.getState().layouts[WORK_KEY]!;
    const tab = layout.root.type === 'split' && layout.root.children[0].type === 'group' ? layout.root.children[0].tabs[0] : null;
    expect(tab).toMatchObject({ id: 'terminal:a', view: 'terminal' });
    expect(surface('terminal:a')).not.toBeNull();
  });

  it('providers.list ещё не ответил — ни поверхности, ни подписки; ответ пришёл — подписка (2.1.286) или поверхность (null)', async () => {
    useProvidersStore.setState({ providers: [], loaded: false });
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(attachCount('a')).toBe(0);
    expect(bridge.calls.some((call) => call.method.startsWith('feed.'))).toBe(false);
    expect(screen.queryByTestId('chat-view')).toBeNull();

    act(() => {
      useProvidersStore.setState({
        providers: [{ id: 'claude', label: 'Claude Code', available: true, version: '2.1.286', limits: null }],
        loaded: true,
      });
    });
    await flush();
    expect(surface('terminal:a')).toBeNull();
    expect(feedCalls('feed.subscribe', 'a')).toBe(1);
    expect(screen.getAllByTestId('chat-view')).toHaveLength(2);
  });

  it('версия claude неизвестна (null) после ответа — терминал с поверхностью, подписки нет', async () => {
    useProvidersStore.setState({ providers: [], loaded: false });
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    act(() => {
      useProvidersStore.setState({
        providers: [{ id: 'claude', label: 'Claude Code', available: true, version: null, limits: null }],
        loaded: true,
      });
    });
    await flush();
    expect(surface('terminal:a')).not.toBeNull();
    expect(attachCount('a')).toBe(1);
    expect(bridge.calls.some((call) => call.method.startsWith('feed.'))).toBe(false);
    expect(screen.queryByTestId('chat-view')).toBeNull();
  });

  it('переподключение не перемонтирует поверхность: пока providers.list нового хоста в пути, xterm и последний вывод прежние (раунд main-r2, п. 2)', async () => {
    // Проба версий выключена, как в E2E: вид — терминал.
    useProvidersStore.setState({
      providers: [{ id: 'claude', label: 'Claude Code', available: true, version: null, limits: null }],
      loaded: true,
    });
    bridge.setHandler('pty.attach', () => ({ snapshot: 'последний вывод', cols: 80, rows: 24 }));
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    const before = surface('terminal:a');
    if (before === null) throw new Error('нет поверхности terminal:a');
    const mountId = before.dataset.mountId;
    const constructed = xtermMock.constructed;
    const term = xtermMock.terminals.find((item) => item.element !== null && before.contains(item.element));
    expect(term?.writes).toEqual(['последний вывод']);

    // «Restart host»: связь рвётся, новый хост агента не знает — его pty.attach отказывает.
    act(() => useHostStore.setState({ status: { state: 'disconnected', reason: 'closed' } }));
    await flush();
    bridge.setHandler('pty.attach', () => {
      throw new Error('no live PTY');
    });
    let answer: (result: Result<'providers.list'>) => void = () => {};
    bridge.setHandler('providers.list', () => new Promise((resolve) => (answer = resolve)));
    let disposeProviders: () => void = () => {};
    act(() => {
      useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: FEED_METHODS } });
      // Связь вернулась — App заново заводит хранилища (`App.tsx`).
      disposeProviders = useProvidersStore.getState().init(bridge);
    });
    await flush();
    expect(surface('terminal:a')).toBe(before);
    expect(before.dataset.mountId).toBe(mountId);
    expect(xtermMock.constructed).toBe(constructed);
    expect(term?.disposed).toBe(false);
    expect(term?.resets).toBe(0);

    act(() => answer({ providers: [{ id: 'claude', label: 'Claude Code', available: true, version: null }] }));
    await flush();
    expect(surface('terminal:a')).toBe(before);
    expect(xtermMock.constructed).toBe(constructed);
    expect(term?.writes).toEqual(['последний вывод']);
    disposeProviders();
  });

  it('хост без feed.snapshot — терминал без тулбара, как раньше', async () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.2.0', methods: [...REQUIRED_METHODS] } });
    // Без ленты у хоста ответа providers.list не ждём.
    useProvidersStore.setState({ providers: [], loaded: false });
    setLayout(twoGroups(), 'g1');
    renderWork();
    await flush();
    expect(surface('terminal:a')?.style.getPropertyValue('top')).not.toContain('36px');
    expect(screen.queryByTestId('chat-toolbar')).toBeNull();
    expect(bridge.calls.some((call) => call.method.startsWith('feed.'))).toBe(false);
  });
});
