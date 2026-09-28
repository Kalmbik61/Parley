/**
 * Тесты 1–5 и 9 куска 6.3: `runAction` — одна ветка на каждое реализованное действие реестра,
 * контекст читается в момент действия, ошибки асинхронных действий — тостом.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionId } from '../../shared/keybindings.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { IMPLEMENTED_ACTIONS } from '../keys/handler.js';
import { createMruCycle } from '../keys/mru-cycle.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, openTab } from '../layout/tree.js';
import type { TerminalSurfaceHandle } from '../terminal/surface-registry.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { runAction, type ActionContext, type ActionSource } from './actions.js';

const KEY = '/tmp/p\nw-01';
const ORDER = Array.from({ length: 9 }, (_, index) => `/tmp/p\nw-0${index + 1}`);

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

function makeContext(patch: { source?: ActionSource; activeWorkKey?: string | null; focused?: boolean; active?: boolean } = {}) {
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
  const ctx: ActionContext = {
    source: patch.source ?? 'key',
    bridge: createFakeBridge(),
    layout,
    mruCycle,
    sidebar: { order: () => ORDER },
    ui,
    palette,
    terminals: { focused: () => (patch.focused === false ? null : focused), active: () => (patch.active === false ? null : active) },
    attention,
    files,
    toast,
  };
  return { ctx, layout, ui, palette, attention, files, toast, focused, active, step };
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
      expect(files.openSearch).toHaveBeenCalledTimes(1);
    },
  };
  const check = table[id];
  if (check === undefined) throw new Error(`нет ожидания для ${id}`);
  return check;
}

describe('runAction — таблица по реестру (тест 1 куска 6.3)', () => {
  it.each([...IMPLEMENTED_ACTIONS])('%s', (id) => {
    const spies = makeContext();
    runAction(id, spies.ctx);
    expectation(id)(spies);
    expect(spies.toast).not.toHaveBeenCalled();
  });

  it('действия будущих этапов не реализованы и ничего не делают', () => {
    const spies = makeContext();
    for (const id of ['browser.newTab'] as const) {
      expect(IMPLEMENTED_ACTIONS.has(id)).toBe(false);
      runAction(id, spies.ctx);
    }
    expect(spies.layout.apply).not.toHaveBeenCalled();
    expect(spies.palette.openWith).not.toHaveBeenCalled();
    expect(spies.toast).not.toHaveBeenCalled();
  });
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
