/**
 * Меню строки сессии в карточке (кусок 3.4, спека 6.4): пункты прежнего `SessionMenu` плюс
 * «Copy worktree path». Тест 12 (вторая часть): «Open to the side» у строки неактивной и
 * ещё не гидрированной работы — работа активна, сплит применяется из очереди после `hydrate`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkSession } from '@harnas/core';
import type { TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, LIMITS, openTab, splitGroup } from '../layout/tree.js';
import { useReviewStore, bindReviewToLayout } from '../review/store.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { toast } from 'sonner';
import { SessionRowMenu } from './SessionRowMenu.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;
const KEY = '/tmp/proj w-01';

function renderMenu(session: WorkSession, onOpen = vi.fn()): void {
  render(
    <SessionRowMenu workKey={KEY} projectPath="/tmp/proj" workId="w-01" session={session} bridge={bridge} onOpen={onOpen}>
      <div>row</div>
    </SessionRowMenu>,
  );
  fireEvent.contextMenu(screen.getByText('row'));
}

const term = (sessionId: string): TabSpec => ({ kind: 'terminal', id: tabId.terminal(sessionId), sessionId });

beforeEach(() => {
  bridge = createFakeBridge();
  useUiStore.setState({
    sidebarHolds: {},
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null, work: null }, settings: false, createRoom: null },
  });
  vi.mocked(toast).mockClear();
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionRowMenu — пункты', () => {
  it('Copy worktree path — только у сессии со своим worktree, в буфер путь worktree', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderMenu(makeSession('s-01', 'plan'));
    expect(screen.queryByText('Copy worktree path')).toBeNull();
    cleanup();

    renderMenu(makeSession('s-01', 'plan', { worktree: { path: '/tmp/wt/s01', branch: 'harnas/s01', base: 'main', createdAt: '2026-09-27T08:00:00.000Z' } }));
    fireEvent.click(screen.getByText('Copy worktree path'));
    expect(writeText).toHaveBeenCalledWith('/tmp/wt/s01');
  });

  it('Stop — только после подтверждения; Create room with… — диалог с обязательным участником', () => {
    bridge.setHandler('sessions.stop', () => ({ ok: true as const }));
    renderMenu(makeSession('s-01', 'plan'));
    fireEvent.click(screen.getByText('Stop'));
    expect(bridge.calls).toEqual([]);
    fireEvent.click(screen.getAllByText('Stop')[0] as HTMLElement);
    expect(bridge.calls).toEqual([{ method: 'sessions.stop', params: { ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' } } }]);

    fireEvent.contextMenu(screen.getByText('row'));
    fireEvent.click(screen.getByText('Create room with…'));
    expect(useUiStore.getState().dialogs.createRoom).toEqual({
      projectPath: '/tmp/proj',
      workId: 'w-01',
      requiredMember: { id: 's-01', label: 'S01 plan' },
    });
  });

  it('Open — колбэк строки; открытое меню держит порядок сайдбара', () => {
    const onOpen = vi.fn();
    renderMenu(makeSession('s-01', 'plan'), onOpen);
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
    fireEvent.click(screen.getByText('Open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().sidebarHolds).toEqual({});
  });
});

describe('SessionRowMenu — Open to the side (тест 12)', () => {
  it('строка неактивной и не гидрированной работы: работа активна, сплит — из очереди после hydrate', () => {
    useLayoutStore.getState().setActiveWork('/tmp/other w-09');
    renderMenu(makeSession('s-02', 'build'));
    fireEvent.click(screen.getByText('Open to the side'));

    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
    expect(useLayoutStore.getState().layouts[KEY]).toBeUndefined();

    act(() => useLayoutStore.getState().hydrate(KEY, openTab(emptyLayout(), term('s-01'))));
    const layout = useLayoutStore.getState().layouts[KEY];
    if (layout === undefined) throw new Error('раскладки нет');
    const all = groups(layout);
    expect(all).toHaveLength(2);
    expect(all[1]?.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-02')]);
    expect(layout.activeGroupId).toBe(all[1]?.id);
  });

  it('раскладка с диска в пределе групп: отказ сплита из очереди — тост, раскладка та же (раунд 1, находка 1)', () => {
    renderMenu(makeSession('s-02', 'build'));
    fireEvent.click(screen.getByText('Open to the side'));
    expect(toast).not.toHaveBeenCalled();

    let full = openTab(emptyLayout(), term('s-01'));
    for (let i = 1; i < LIMITS.maxGroups; i += 1) {
      const next = splitGroup(full, full.activeGroupId, 'row', term(`x-${i}`));
      if (next.error !== null) throw new Error(next.error);
      full = next.layout;
    }
    act(() => useLayoutStore.getState().hydrate(KEY, full));
    expect(useLayoutStore.getState().layouts[KEY]).toBe(full);
    expect(toast).toHaveBeenCalledWith(S.tabs.tooManyGroups);
  });
});

describe('SessionRowMenu — двойной клик в подтверждении (раунд 1, находка 6)', () => {
  it('Delete: два клика подряд по кнопке — один вызов; новое открытие — снова можно', () => {
    bridge.setHandler('sessions.delete', () => ({ ok: true as const }));
    renderMenu(makeSession('s-01', 'plan'));
    fireEvent.click(screen.getByText('Delete'));
    const confirm = screen.getAllByText('Delete').at(-1) as HTMLElement;
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(bridge.calls.filter((call) => call.method === 'sessions.delete')).toHaveLength(1);

    fireEvent.contextMenu(screen.getByText('row'));
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getAllByText('Delete').at(-1) as HTMLElement);
    expect(bridge.calls.filter((call) => call.method === 'sessions.delete')).toHaveLength(2);
  });
});

describe('SessionRowMenu — Delete и несохранённые файлы worktree (тест 8 куска 7.3a)', () => {
  const wt = { kind: 'worktree', sessionId: 's-01' } as const;
  const own: TabSpec = { kind: 'file', id: tabId.file(wt, 'a.ts'), root: wt, path: 'a.ts' };
  const project: TabSpec = { kind: 'file', id: tabId.file({ kind: 'project' }, 'a.ts'), root: { kind: 'project' }, path: 'a.ts' };
  const other: TabSpec = { kind: 'file', id: tabId.file({ kind: 'worktree', sessionId: 's-02' }, 'a.ts'), root: { kind: 'worktree', sessionId: 's-02' }, path: 'a.ts' };

  beforeEach(() => {
    useLayoutStore.setState({
      activeWorkKey: KEY,
      layouts: { [KEY]: { root: { type: 'group', id: 'g1', tabs: [own, project, other], activeTabId: own.id }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [KEY]: true },
    });
    bridge.setHandler('sessions.delete', () => ({ ok: true as const }));
  });

  afterEach(() => useLayoutStore.getState().setCloseGuard(null));

  const tabIds = (): string[] => {
    const root = useLayoutStore.getState().layouts[KEY]?.root;
    return root?.type === 'group' ? root.tabs.map((tab) => tab.id) : [];
  };

  it('Cancel — sessions.delete нет, вкладки на месте; вопрос — только про файлы её worktree', async () => {
    const guard = vi.fn(async () => false);
    useLayoutStore.getState().setCloseGuard(guard);
    renderMenu(makeSession('s-01', 'plan'));
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getAllByText('Delete').at(-1) as HTMLElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(guard).toHaveBeenCalledWith(KEY, [own.id]);
    expect(bridge.calls.filter((call) => call.method === 'sessions.delete')).toHaveLength(0);
    expect(tabIds()).toEqual([own.id, project.id, other.id]);
  });

  it("Don't save — вкладка закрыта, sessions.delete вызван", async () => {
    useLayoutStore.getState().setCloseGuard(async () => true);
    renderMenu(makeSession('s-01', 'plan'));
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getAllByText('Delete').at(-1) as HTMLElement);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.calls.filter((call) => call.method === 'sessions.delete')).toHaveLength(1);
    expect(tabIds()).toEqual([project.id, other.id]);
  });
});

describe('SessionRowMenu — Changes (тест 9 куска 8.2b)', () => {
  const WT = { path: '/tmp/wt/s01', branch: 'harnas/s01', base: 'main', createdAt: '2026-09-27T08:00:00.000Z' };

  beforeEach(() => {
    useReviewStore.setState({ changesSession: {}, revealed: {}, discarded: {} });
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, rightSidebar: { open: false, width: 350, tab: 'files' } } });
  });

  it.each([
    ['с worktree', makeSession('s-01', 'plan', { worktree: WT })],
    ['без worktree', makeSession('s-01', 'plan')],
  ])('сессия %s: сайдбар открыт на changes, в шапке эта сессия, вкладки diff нет', (_name, session) => {
    const setSidebar = vi.spyOn(useUiStore.getState(), 'setSidebar');
    useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: openTab(emptyLayout(), term('s-02')) }, hydrated: { [KEY]: true } });
    renderMenu(session);
    fireEvent.click(screen.getByText('Changes'));
    expect(setSidebar).toHaveBeenCalledWith('right', { open: true, tab: 'changes' });
    expect(useReviewStore.getState().changesSession).toEqual({ [KEY]: 's-01' });
    const layout = useLayoutStore.getState().layouts[KEY];
    expect(groups(layout ?? emptyLayout()).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.terminal('s-02')]);
    setSidebar.mockRestore();
  });

  it('сессия неактивной работы: работа стала активной, выбор не стёрт', () => {
    const unbind = bindReviewToLayout();
    useLayoutStore.getState().setActiveWork('/tmp/other w-09');
    renderMenu(makeSession('s-01', 'plan'));
    fireEvent.click(screen.getByText('Changes'));
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
    expect(useReviewStore.getState().changesSession).toEqual({ [KEY]: 's-01' });
    unbind();
  });
});
