/**
 * Тесты 1–5 и 9 куска 6.3: `runAction` — одна ветка на каждое реализованное действие реестра,
 * контекст читается в момент действия, ошибки асинхронных действий — тостом.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionId } from '../../shared/keybindings.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { workKey } from '../../shared/work-keys.js';
import { useBrowserStore, wantsAddressFocus } from '../browser/store.js';
import { IMPLEMENTED_ACTIONS } from '../keys/handler.js';
import { createMruCycle } from '../keys/mru-cycle.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, focusGroup, groups, openTab, splitGroup } from '../layout/tree.js';
import type { TerminalSurfaceHandle } from '../terminal/surface-registry.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { runAction, type ActionContext, type ActionSource } from './actions.js';

// Ключ — настоящий `workKey`: `chat.toggleView` ищет сессию вкладки в снимке работ по нему.
const KEY = workKey('/tmp/p', 'w-01');
const ORDER = Array.from({ length: 9 }, (_, index) => workKey('/tmp/p', `w-0${index + 1}`));

function term(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

/** Раскладка одной группы с девятью вкладками — хватает ⌃1…⌃9. */
function nineTabs(): WorkLayout {
  let layout = emptyLayout();
  for (let n = 1; n <= 9; n += 1) layout = openTab(layout, term(`s-0${n}`));
  return layout;
}

function surface(): TerminalSurfaceHandle & { openSearch: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } {
  return { focus: vi.fn(), scrollToBottom: vi.fn(), search: null, openSearch: vi.fn(), clear: vi.fn(), hasFocus: () => false };
}

type Spies = ReturnType<typeof makeContext>;

const BROWSER_TAB = 'browser:0000c1';

function makeContext(patch: { source?: ActionSource; activeWorkKey?: string | null; focused?: boolean; active?: boolean; browser?: boolean } = {}) {
  const layoutValue = nineTabs();
  const focused = surface();
  const active = surface();
  const layout = {
    activeWorkKey: patch.activeWorkKey === undefined ? KEY : patch.activeWorkKey,
    layouts: { [KEY]: layoutValue } as Record<string, WorkLayout>,
    mru: { [KEY]: [tabId.terminal('s-09'), tabId.terminal('s-08')] } as Record<string, string[]>,
    entries: vi.fn(() => []),
    apply: vi.fn(() => null),
    setActiveWork: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    requestCloseTabs: vi.fn(async () => true),
  };
  const ui = {
    toggleSidebar: vi.fn(),
    showRightTab: vi.fn(),
    openNewWork: vi.fn(),
    openNewSession: vi.fn(),
    openNewRoom: vi.fn(),
    openSettings: vi.fn(),
    setAppearance: vi.fn(),
    toggleShowArchived: vi.fn(),
    toggleWake: vi.fn(async () => {}),
    confirmRestartHost: vi.fn(),
  };
  const palette = { open: false, mode: 'default' as const, openWith: vi.fn(), close: vi.fn() };
  const attention = { next: vi.fn(() => null) };
  const toast = vi.fn();
  const files = { openSearch: vi.fn() };
  const mruCycle = createMruCycle();
  const step = vi.spyOn(mruCycle, 'step');
  const bridge = createFakeBridge();
  const ctx: ActionContext = {
    source: patch.source ?? 'key',
    bridge,
    layout,
    mruCycle,
    sidebar: { order: () => ORDER },
    ui,
    palette,
    terminals: { focused: () => (patch.focused === false ? null : focused), active: () => (patch.active === false ? null : active) },
    attention,
    files,
    toast,
    browser: { active: () => (patch.browser === false ? null : { tabId: BROWSER_TAB, webContentsId: 7 }) },
  };
  return { ctx, layout, ui, palette, attention, files, toast, focused, active, step, bridge };
}

/** Что должно случиться у каждого действия — по реестру, один случай на действие (тест 1). */
function expectation(id: ActionId): (spies: Spies) => void {
  if (id.startsWith('work.goto.')) {
    const n = Number(id.slice('work.goto.'.length));
    return ({ layout }) => expect(layout.setActiveWork).toHaveBeenCalledWith(ORDER[n - 1]);
  }
  if (id.startsWith('tab.goto.')) {
    const n = Number(id.slice('tab.goto.'.length));
    return ({ layout }) => {
      expect(layout.apply).toHaveBeenCalledTimes(1);
      const op = layout.apply.mock.calls[0]?.[1] as unknown as (l: WorkLayout) => WorkLayout;
      const next = op(layout.layouts[KEY] as WorkLayout);
      expect(groups(next)[0]?.activeTabId).toBe(tabId.terminal(`s-0${n}`));
    };
  }
  const table: Partial<Record<ActionId, (spies: Spies) => void>> = {
    'palette.open': ({ palette }) => expect(palette.openWith).toHaveBeenCalledWith('default'),
    'work.new': ({ ui }) => expect(ui.openNewWork).toHaveBeenCalledTimes(1),
    'session.new': ({ ui }) => expect(ui.openNewSession).toHaveBeenCalledTimes(1),
    'room.new': ({ ui }) => expect(ui.openNewRoom).toHaveBeenCalledTimes(1),
    'settings.open': ({ ui }) => expect(ui.openSettings).toHaveBeenCalledTimes(1),
    'sidebar.left.toggle': ({ ui }) => expect(ui.toggleSidebar).toHaveBeenCalledWith('left'),
    'sidebar.right.toggle': ({ ui }) => expect(ui.toggleSidebar).toHaveBeenCalledWith('right'),
    'sidebar.files': ({ ui }) => expect(ui.showRightTab).toHaveBeenCalledWith('files'),
    'sidebar.changes': ({ ui }) => expect(ui.showRightTab).toHaveBeenCalledWith('changes'),
    'work.prev': ({ layout }) => expect(layout.setActiveWork).toHaveBeenCalledWith(ORDER[8]),
    'work.next': ({ layout }) => expect(layout.setActiveWork).toHaveBeenCalledWith(ORDER[1]),
    'works.showArchived': ({ ui }) => expect(ui.toggleShowArchived).toHaveBeenCalledTimes(1),
    'history.back': ({ layout }) => expect(layout.back).toHaveBeenCalledTimes(1),
    'history.forward': ({ layout }) => expect(layout.forward).toHaveBeenCalledTimes(1),
    'group.splitRight': ({ palette }) => expect(palette.openWith).toHaveBeenCalledWith('splitRight'),
    'group.splitDown': ({ palette }) => expect(palette.openWith).toHaveBeenCalledWith('splitDown'),
    'group.prev': ({ layout }) => expect(layout.apply).toHaveBeenCalledTimes(1),
    'group.next': ({ layout }) => expect(layout.apply).toHaveBeenCalledTimes(1),
    'tab.close': ({ layout }) => expect(layout.requestCloseTabs).toHaveBeenCalledWith(KEY, [tabId.terminal('s-09')]),
    'tab.reopen': ({ layout }) => expect(layout.apply).toHaveBeenCalledTimes(1),
    'tab.prev': ({ layout }) => expect(layout.apply).toHaveBeenCalledTimes(1),
    'tab.next': ({ layout }) => expect(layout.apply).toHaveBeenCalledTimes(1),
    'tab.mruNext': ({ step, layout }) => {
      expect(step).toHaveBeenCalledWith(KEY, layout.mru[KEY], 1);
      expect(layout.apply).toHaveBeenCalledTimes(1);
    },
    'tab.mruPrev': ({ step, layout }) => {
      expect(step).toHaveBeenCalledWith(KEY, layout.mru[KEY], -1);
      expect(layout.apply).toHaveBeenCalledTimes(1);
    },
    find: ({ focused }) => expect(focused.openSearch).toHaveBeenCalledTimes(1),
    'terminal.clear': ({ focused }) => expect(focused.clear).toHaveBeenCalledTimes(1),
    'attention.next': ({ attention }) => expect(attention.next).toHaveBeenCalledTimes(1),
    'wake.toggle': ({ ui }) => expect(ui.toggleWake).toHaveBeenCalledTimes(1),
    'host.restart': ({ ui }) => expect(ui.confirmRestartHost).toHaveBeenCalledTimes(1),
    'appearance.system': ({ ui }) => expect(ui.setAppearance).toHaveBeenCalledWith('system'),
    'appearance.dark': ({ ui }) => expect(ui.setAppearance).toHaveBeenCalledWith('dark'),
    'appearance.light': ({ ui }) => expect(ui.setAppearance).toHaveBeenCalledWith('light'),
    'files.quickOpen': ({ palette }) => expect(palette.openWith).toHaveBeenCalledWith('files'),
    'files.search': ({ ui, files }) => {
      expect(ui.showRightTab).toHaveBeenCalledWith('files');
      expect(files.openSearch).toHaveBeenCalledWith(KEY);
    },
    // 9.2a: новая вкладка браузера без адреса в активной группе.
    'browser.newTab': ({ layout }) => {
      expect(layout.apply).toHaveBeenCalledTimes(1);
      const op = layout.apply.mock.calls[0]?.[1] as unknown as (l: WorkLayout) => WorkLayout;
      const next = op(layout.layouts[KEY] as WorkLayout);
      expect(groups(next)[0]?.tabs.at(-1)).toMatchObject({ kind: 'browser', url: '' });
    },
    // 9.2b: цель — browser.active(), вкладка браузера активной группы.
    'browser.find': () => expect(useBrowserStore.getState().tabs[BROWSER_TAB]?.findOpen).toBe(true),
    'browser.zoomIn': ({ bridge }) => expect(bridge.browserCalls).toEqual([{ method: 'zoom', args: [7, 1] }]),
    'browser.zoomOut': ({ bridge }) => expect(bridge.browserCalls).toEqual([{ method: 'zoom', args: [7, -1] }]),
    'browser.zoomReset': ({ bridge }) => expect(bridge.browserCalls).toEqual([{ method: 'zoom', args: [7, 0] }]),
    // План 2026-10-01: активная вкладка s-09 — Claude без поля view, то есть в чате; действие ставит terminal.
    'chat.toggleView': ({ layout }) => {
      expect(layout.apply).toHaveBeenCalledTimes(1);
      const op = layout.apply.mock.calls[0]?.[1] as unknown as (l: WorkLayout) => WorkLayout;
      const next = op(layout.layouts[KEY] as WorkLayout);
      expect(groups(next)[0]?.tabs.find((tab) => tab.id === tabId.terminal('s-09'))).toMatchObject({ view: 'terminal' });
    },
  };
  const check = table[id];
  if (check === undefined) throw new Error(`нет ожидания для ${id}`);
  return check;
}

/** Хост с лентой и работа KEY с сессией s-09 нужного провайдера — для `chat.toggleView`. */
function withFeedHost(provider = 'claude'): void {
  useHostStore.setState({
    status: { state: 'connected', hostVersion: '0.3.0', methods: [...REQUIRED_METHODS, 'feed.snapshot'] },
  });
  useWorksStore.setState({
    entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-09', 'S09', { provider })] })],
  });
}

function resetFeedHost(): void {
  useHostStore.setState({ status: { state: 'connecting' } });
  useWorksStore.setState({ entries: [] });
}

describe('runAction — таблица по реестру (тест 1 куска 6.3)', () => {
  beforeEach(() => withFeedHost());
  afterEach(resetFeedHost);

  it.each([...IMPLEMENTED_ACTIONS])('%s', (id) => {
    const spies = makeContext();
    runAction(id, spies.ctx);
    expectation(id)(spies);
    expect(spies.toast).not.toHaveBeenCalled();
  });

  // Тест «действия будущих этапов не реализованы» обеих сторон (browser.newTab основной; files.quickOpen и
  // sidebar.changes полосы) снят слиянием: после этапов 7–9 все действия реестра реализованы, их ветки —
  // в таблице выше.
});

describe('runAction — без активной работы (тест 2 куска 6.3)', () => {
  it('files.quickOpen и files.search без активной работы — тост No active workspace, ничего не открыто (тест 6 куска 7.4)', () => {
    for (const id of ['files.quickOpen', 'files.search'] as const) {
      const spies = makeContext({ activeWorkKey: null });
      runAction(id, spies.ctx);
      expect(spies.toast).toHaveBeenCalledWith('No active workspace');
      expect(spies.palette.openWith).not.toHaveBeenCalled();
      expect(spies.ui.showRightTab).not.toHaveBeenCalled();
      expect(spies.files.openSearch).not.toHaveBeenCalled();
    }
  });

  it('tab.close без активной работы — тост No active workspace, requestCloseTabs не вызван', () => {
    const spies = makeContext({ activeWorkKey: null });
    runAction('tab.close', spies.ctx);
    expect(spies.toast).toHaveBeenCalledWith('No active workspace');
    expect(spies.layout.requestCloseTabs).not.toHaveBeenCalled();
  });

  it('tab.close с активной — requestCloseTabs с id активной вкладки', () => {
    const spies = makeContext();
    runAction('tab.close', spies.ctx);
    expect(spies.layout.requestCloseTabs).toHaveBeenCalledWith(KEY, [tabId.terminal('s-09')]);
  });

  it.each(['session.new', 'room.new', 'group.splitRight', 'group.next', 'tab.reopen', 'tab.mruNext'] as const)(
    '%s без активной работы — тост, действие не выполнено',
    (id) => {
      const spies = makeContext({ activeWorkKey: null });
      runAction(id, spies.ctx);
      expect(spies.toast).toHaveBeenCalledWith('No active workspace');
      expect(spies.ui.openNewSession).not.toHaveBeenCalled();
      expect(spies.ui.openNewRoom).not.toHaveBeenCalled();
      expect(spies.palette.openWith).not.toHaveBeenCalled();
      expect(spies.layout.apply).not.toHaveBeenCalled();
    },
  );

  // Ревью 6.3-A, Minor 1: работа выбрана, а её раскладка ещё читается с диска — тихий no-op.
  it.each([...IMPLEMENTED_ACTIONS].filter((id) => id.startsWith('tab.') || id.startsWith('group.')))(
    '%s при активной работе без гидрированной раскладки — ничего не делает, без тоста',
    (id) => {
      const spies = makeContext();
      spies.layout.layouts = {};
      runAction(id, spies.ctx);
      expect(spies.toast).not.toHaveBeenCalled();
      expect(spies.layout.apply).not.toHaveBeenCalled();
      expect(spies.layout.requestCloseTabs).not.toHaveBeenCalled();
      expect(spies.palette.openWith).not.toHaveBeenCalled();
      expect(spies.step).not.toHaveBeenCalled();
    },
  );

  it.each(['sidebar.right.toggle', 'sidebar.files', 'sidebar.changes'] as const)('%s без активной работы — тост, сайдбар не трогается (7.2)', (id) => {
    const spies = makeContext({ activeWorkKey: null });
    runAction(id, spies.ctx);
    expect(spies.toast).toHaveBeenCalledWith('No active workspace');
    expect(spies.ui.toggleSidebar).not.toHaveBeenCalled();
    expect(spies.ui.showRightTab).not.toHaveBeenCalled();
  });

  it('отказ requestCloseTabs — тост Couldn\'t close tab: …, без необработанного отказа', async () => {
    const spies = makeContext();
    spies.layout.requestCloseTabs.mockRejectedValueOnce(encodeIpcError({ code: 'internal', message: 'сбой' }));
    runAction('tab.close', spies.ctx);
    await vi.waitFor(() => expect(spies.toast).toHaveBeenCalledWith("Couldn't close tab: host error."));
  });
});

describe('runAction — контекст свежий (тест 3 куска 6.3)', () => {
  const STORE_KEY = '/tmp/store\nw-01';

  beforeEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });
  afterEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });

  /** Контекст на момент действия: `useLayoutStore.getState()`, а не снимок при создании. */
  function freshContext(mruCycle = createMruCycle()): () => ActionContext {
    const { ctx } = makeContext();
    return () => ({ ...ctx, mruCycle, layout: useLayoutStore.getState() });
  }

  it('после apply(openTab) tab.mruNext берёт новый mru и фокусирует прежнюю вкладку; history.back — layout.back()', () => {
    const store = useLayoutStore.getState();
    store.setActiveWork(STORE_KEY);
    store.hydrate(STORE_KEY, null);
    const ctx = freshContext();
    useLayoutStore.getState().apply(STORE_KEY, (l) => openTab(l, term('s-01')));
    useLayoutStore.getState().apply(STORE_KEY, (l) => openTab(l, term('s-02')));

    runAction('tab.mruNext', ctx());
    const layout = useLayoutStore.getState().layouts[STORE_KEY];
    expect(layout === undefined ? null : groups(layout)[0]?.activeTabId).toBe(tabId.terminal('s-01'));

    const back = vi.spyOn(useLayoutStore.getState(), 'back');
    runAction('history.back', ctx());
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe('runAction — тема и поиск (тесты 4, 5 куска 6.3)', () => {
  it('appearance.dark — ui.setAppearance("dark"), app.saveUi не вызван', () => {
    const spies = makeContext();
    const saveUi = vi.spyOn(spies.ctx.bridge.app, 'saveUi');
    runAction('appearance.dark', spies.ctx);
    expect(spies.ui.setAppearance).toHaveBeenCalledWith('dark');
    expect(saveUi).not.toHaveBeenCalled();
  });

  it.each(['key', 'menu', 'palette'] as const)('find (%s) — у терминала в фокусе, без него — у активного', (source) => {
    const withFocus = makeContext({ source });
    runAction('find', withFocus.ctx);
    expect(withFocus.focused.openSearch).toHaveBeenCalledTimes(1);
    expect(withFocus.active.openSearch).not.toHaveBeenCalled();

    const noFocus = makeContext({ source, focused: false });
    runAction('find', noFocus.ctx);
    expect(noFocus.active.openSearch).toHaveBeenCalledTimes(1);
  });

  it.each(['key', 'menu'] as const)('terminal.clear (%s) — только терминал в фокусе; без фокуса — ничего', (source) => {
    const withFocus = makeContext({ source });
    runAction('terminal.clear', withFocus.ctx);
    expect(withFocus.focused.clear).toHaveBeenCalledTimes(1);
    expect(withFocus.active.clear).not.toHaveBeenCalled();

    const noFocus = makeContext({ source, focused: false });
    runAction('terminal.clear', noFocus.ctx);
    expect(noFocus.active.clear).not.toHaveBeenCalled();
  });

  it('terminal.clear из палитры — активный терминал по явному выбору строки', () => {
    const spies = makeContext({ source: 'palette', focused: false });
    runAction('terminal.clear', spies.ctx);
    expect(spies.active.clear).toHaveBeenCalledTimes(1);
  });

  it('оба терминала null — find и terminal.clear без ошибки', () => {
    for (const source of ['key', 'palette'] as const) {
      const spies = makeContext({ source, focused: false, active: false });
      expect(() => runAction('find', spies.ctx)).not.toThrow();
      expect(() => runAction('terminal.clear', spies.ctx)).not.toThrow();
    }
  });
});

describe('runAction — будильник (тест 9 куска 6.3)', () => {
  it('отказ toggleWake — тост Couldn\'t toggle auto-wake: …, необработанного отказа нет', async () => {
    const spies = makeContext();
    spies.ui.toggleWake.mockRejectedValueOnce(encodeIpcError({ code: 'unknown_method', message: 'нет метода' }));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      runAction('wake.toggle', spies.ctx);
      await vi.waitFor(() =>
        expect(spies.toast).toHaveBeenCalledWith("Couldn't toggle auto-wake: not supported by this host version."),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('palette.open при открытой обычной палитре — закрыть; в режиме разделения — переключить в обычный', () => {
    const open = makeContext();
    open.ctx.palette = { ...open.palette, open: true, mode: 'default' };
    runAction('palette.open', open.ctx);
    expect(open.palette.close).toHaveBeenCalledTimes(1);
    expect(open.palette.openWith).not.toHaveBeenCalled();

    const split = makeContext();
    split.ctx.palette = { ...split.palette, open: true, mode: 'splitRight' };
    runAction('palette.open', split.ctx);
    expect(split.palette.openWith).toHaveBeenCalledWith('default');
  });
});

describe('вкладки браузера и предел (тест 12 куска 9.2a)', () => {
  afterEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });

  function browserTab(n: number): TabSpec {
    return { kind: 'browser', id: `browser:00000${n.toString(16)}`, url: `http://localhost:${5170 + n}` };
  }

  /** Десять вкладок браузера и закрытая вкладка сверху стека. */
  function tenBrowserTabs(closedTop: TabSpec): WorkLayout {
    let layout = nineTabs();
    for (let n = 0; n < 10; n += 1) layout = openTab(layout, browserTab(n));
    return { ...layout, closedTabs: [closedTop, term('s-77')] };
  }

  it('⌘⇧T при 10 вкладках браузера и закрытой вкладке браузера сверху — тост, раскладка та же', () => {
    const spies = makeContext();
    spies.layout.layouts = { [KEY]: tenBrowserTabs(browserTab(11)) };
    runAction('tab.reopen', spies.ctx);
    expect(spies.toast).toHaveBeenCalledWith('No more than 10 browser tabs per workspace');
    expect(spies.layout.apply).not.toHaveBeenCalled();
  });

  it('⌘⇧T при 10 вкладках браузера, сверху терминал — возвращает его', () => {
    const spies = makeContext();
    spies.layout.layouts = { [KEY]: tenBrowserTabs(term('s-88')) };
    runAction('tab.reopen', spies.ctx);
    expect(spies.toast).not.toHaveBeenCalled();
    expect(spies.layout.apply).toHaveBeenCalledTimes(1);
  });

  it('⌘⇧T пустой вкладки браузера — действие человека: её адресная строка просит фокус (перенос 9.2a)', () => {
    const spies = makeContext();
    const closed: TabSpec = { kind: 'browser', id: 'browser:0000aa', url: '' };
    spies.layout.layouts = { [KEY]: { ...nineTabs(), closedTabs: [closed] } };
    expect(wantsAddressFocus(closed.id)).toBe(false);
    runAction('tab.reopen', spies.ctx);
    expect(spies.layout.apply).toHaveBeenCalledTimes(1);
    expect(wantsAddressFocus(closed.id)).toBe(true);
  });

  it('browser.newTab при 10 вкладках браузера — тост, раскладка та же; без активной работы — No active workspace', () => {
    const spies = makeContext();
    spies.layout.layouts = { [KEY]: tenBrowserTabs(term('s-88')) };
    runAction('browser.newTab', spies.ctx);
    expect(spies.toast).toHaveBeenCalledWith('No more than 10 browser tabs per workspace');
    expect(spies.layout.apply).not.toHaveBeenCalled();

    const none = makeContext({ activeWorkKey: null });
    runAction('browser.newTab', none.ctx);
    expect(none.toast).toHaveBeenCalledWith('No active workspace');
    expect(none.layout.apply).not.toHaveBeenCalled();
  });

  it('«+» неактивной группы, затем browser.newTab — вкладка браузера встаёт в эту группу', () => {
    let layout = openTab(emptyLayout(), term('s-01'));
    const g1 = layout.activeGroupId;
    layout = splitGroup(layout, g1, 'row', term('s-02'), { [g1]: { width: 1200, height: 800 } }).layout;
    const g2 = layout.activeGroupId;
    layout = focusGroup(layout, g1);
    useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: layout }, hydrated: { [KEY]: true }, pending: {} });

    // «+» строки вкладок g2 (TabStrip, 6.2): focusGroup своей группы и палитра в режиме open.
    useLayoutStore.getState().apply(KEY, (current) => focusGroup(current, g2));
    const spies = makeContext();
    const store = useLayoutStore.getState();
    const ctx: ActionContext = {
      ...spies.ctx,
      source: 'palette',
      layout: { ...spies.ctx.layout, activeWorkKey: store.activeWorkKey, layouts: store.layouts, apply: store.apply },
    };
    runAction('browser.newTab', ctx);

    const after = useLayoutStore.getState().layouts[KEY] as WorkLayout;
    const target = groups(after).find((group) => group.id === g2);
    expect(target?.tabs.at(-1)).toMatchObject({ kind: 'browser', url: '' });
    expect(target?.activeTabId).toBe(target?.tabs.at(-1)?.id);
    expect(groups(after).find((group) => group.id === g1)?.tabs.some((tab) => tab.kind === 'browser')).toBe(false);
  });
});

describe('действия страницы: поиск и масштаб (тест 3 куска 9.2b)', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: {}, limitToasted: {} });
  });

  afterEach(() => {
    useBrowserStore.setState({ tabs: {}, limitToasted: {} });
    vi.restoreAllMocks();
  });

  it('без вкладки браузера — ни вызовов, ни полосы, ни тоста', () => {
    const spies = makeContext({ browser: false });
    for (const id of ['browser.find', 'browser.zoomIn', 'browser.zoomOut', 'browser.zoomReset'] as const) runAction(id, spies.ctx);
    expect(spies.bridge.browserCalls).toEqual([]);
    expect(useBrowserStore.getState().tabs).toEqual({});
    expect(spies.toast).not.toHaveBeenCalled();
  });

  it('отказ zoom — в консоль, без тоста', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spies = makeContext();
    spies.bridge.browser.zoom = vi.fn(async () => {
      throw new Error('gone');
    });
    runAction('browser.zoomIn', spies.ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    expect(spies.toast).not.toHaveBeenCalled();
  });
});

describe('chat.toggleView (план 2026-10-01, решение 6)', () => {
  afterEach(resetFeedHost);

  const viewAfter = (spies: Spies): unknown => {
    const op = spies.layout.apply.mock.calls[0]?.[1] as unknown as (l: WorkLayout) => WorkLayout;
    const next = op(spies.layout.layouts[KEY] as WorkLayout);
    return groups(next)[0]?.tabs.find((tab) => tab.id === tabId.terminal('s-09'));
  };

  it('вкладка в терминале — переключает в chat', () => {
    withFeedHost();
    const spies = makeContext();
    spies.layout.layouts[KEY] = { ...(spies.layout.layouts[KEY] as WorkLayout) };
    const group = groups(spies.layout.layouts[KEY] as WorkLayout)[0]!;
    group.tabs = group.tabs.map((tab) => (tab.kind === 'terminal' && tab.sessionId === 's-09' ? { ...tab, view: 'terminal' } : tab));
    runAction('chat.toggleView', spies.ctx);
    expect(viewAfter(spies)).toMatchObject({ view: 'chat' });
  });

  it('codex — тост с подсказкой, раскладка не тронута', () => {
    withFeedHost('codex');
    const spies = makeContext();
    runAction('chat.toggleView', spies.ctx);
    expect(spies.toast).toHaveBeenCalledWith(expect.stringContaining('Chat view is available for Claude Code'));
    expect(spies.layout.apply).not.toHaveBeenCalled();
  });
});
