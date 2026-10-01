/**
 * Кусок 7.2, тесты 5, 10, 11: вкладка «Файлы» — `gitStatus` не чаще раза в 2 с и по своим
 * поводам, отказ слежения и «Refresh», выбор корня держится, корень исчез — проект.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import { refKey, type EventData } from '@parley/protocol';
import type { DirEntry, FileRoot } from '../../shared/files-types.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { FilesPanel } from './FilesPanel.js';
import { useFilesStore } from './store.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = '/tmp/proj w-01';
const worktree = (id: string) => ({ path: `/wt/${id}`, branch: `harnas/w-0001/${id}`, base: 'main', createdAt: '2026-09-27T08:00:00.000Z' });
const ENTRY: WorkEntry = makeWork('w-01', {
  projectPath: '/tmp/proj',
  sessions: [
    makeSession('s-01', 'plain'),
    makeSession('s-02', 'two', { worktree: worktree('s02') }),
    makeSession('s-03', 'three', { worktree: worktree('s03') }),
  ],
});
const PROJECT: FileRoot = { workKey: KEY, spec: { kind: 'project' } };
const S02: FileRoot = { workKey: KEY, spec: { kind: 'worktree', sessionId: 's-02' } };
const S03: FileRoot = { workKey: KEY, spec: { kind: 'worktree', sessionId: 's-03' } };

const term = (sessionId: string): TabSpec => ({ kind: 'terminal', id: `terminal:${sessionId}`, sessionId });
const FILE_TAB: TabSpec = { kind: 'file', id: 'file:w:s-02:a.ts', root: { kind: 'worktree', sessionId: 's-02' }, path: 'a.ts' };

function dirEntry(name: string, kind: DirEntry['kind'] = 'file'): DirEntry {
  return { name, kind, size: 1, mtimeMs: 1, ignored: false, target: null };
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
  useFilesStore.setState({ rootByWork: {}, expanded: {} });
  useActivityStore.setState({ byRef: {} });
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true });
  useUiStore.getState().init(bridge);
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: emptyLayout() },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function openInLayout(tab: TabSpec): void {
  act(() => {
    useLayoutStore.getState().apply(KEY, (layout) => openTab(layout, tab));
  });
}

function activity(
  sessionId: string,
  state: 'working' | 'idle',
  heldByBackground = false,
): EventData<'activity.changed'> {
  return {
    ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId },
    activity: {
      activity: state,
      subagents: 0,
      tasks: [],
      waitingFor: null,
      heldByBackground,
      turnEndedAt: null,
      lastEventAt: null,
      source: 'hooks',
      exited: false,
      hooksMissing: false,
    },
    metrics: null,
  };
}

function setActivity(entry: EventData<'activity.changed'>): void {
  act(() => useActivityStore.setState((state) => ({ byRef: { ...state.byRef, [refKey(entry.ref)]: entry } })));
}

describe('gitStatus (тест 5)', () => {
  it('три treeChanged за секунду — один вызов; works.changed, idle сессии корня и повторный показ — перечитывание', async () => {
    vi.useFakeTimers();
    const view = render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await act(async () => {
      await Promise.resolve();
    });
    // Показ панели — первый вызов.
    expect(bridge.gitStatusCalls).toHaveLength(1);
    expect(bridge.gitStatusCalls[0]).toEqual(PROJECT);

    for (let i = 0; i < 3; i += 1) {
      act(() => bridge.emitTreeChanged({ rootKey: rootKey(PROJECT), dirs: [''] }));
      act(() => vi.advanceTimersByTime(300));
    }
    expect(bridge.gitStatusCalls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(bridge.gitStatusCalls).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    act(() => bridge.emit('works.changed', { entries: [] } as unknown as EventData<'works.changed'>));
    expect(bridge.gitStatusCalls).toHaveLength(3);

    // У проекта — сессии работы без worktree: s-01 закончила ход.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    setActivity(activity('s-01', 'working'));
    setActivity(activity('s-02', 'idle'));
    expect(bridge.gitStatusCalls).toHaveLength(3);
    setActivity(activity('s-01', 'idle'));
    expect(bridge.gitStatusCalls).toHaveLength(4);

    view.unmount();
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    expect(bridge.gitStatusCalls).toHaveLength(5);
  });
});

describe('конец хода лида с фоновыми субагентами (Parley 0.2.0)', () => {
  it('working остаётся, но удержание фоновыми включилось — статус перечитывается; удержание само ничего не будит', async () => {
    vi.useFakeTimers();
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.gitStatusCalls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // У проекта — сессии работы без worktree: s-01 работает сама, потом закончила ход при живых фоновых.
    setActivity(activity('s-01', 'working'));
    expect(bridge.gitStatusCalls).toHaveLength(1);
    setActivity(activity('s-01', 'working', true));
    expect(bridge.gitStatusCalls).toHaveLength(2);

    // Удержание продолжается, снимок пришёл новый — повода нет.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    setActivity({ ...activity('s-01', 'working', true), metrics: null });
    expect(bridge.gitStatusCalls).toHaveLength(2);
  });
});

describe('слежение (тест 10)', () => {
  it('watch корня отказал — в шапке Refresh; клик перечитывает раскрытые папки и статус', async () => {
    bridge.setWatchFails(PROJECT);
    bridge.setDir(PROJECT, '', [dirEntry('src', 'dir')]);
    bridge.setDir(PROJECT, 'src', [dirEntry('a.ts')]);
    const list = vi.spyOn(bridge.files, 'list');
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    fireEvent.click(await screen.findByText('src'));
    await screen.findByText('a.ts');
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    const before = bridge.gitStatusCalls.length;
    list.mockClear();

    fireEvent.click(refresh);
    await waitFor(() => expect(list.mock.calls.map((call) => call[1]).sort()).toEqual(['', 'src']));
    expect(bridge.gitStatusCalls.length).toBe(before + 1);
  });

  it('watch удался — Refresh нет, подписка снимается при размонтировании', async () => {
    const view = render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await waitFor(() => expect(bridge.watchCalls).toHaveLength(1));
    expect(bridge.watchCalls[0]).toMatchObject({ root: PROJECT, path: '' });
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    view.unmount();
    await waitFor(() => expect(bridge.unwatchCalls).toEqual([bridge.watchCalls[0]?.id]));
  });
});

describe('корень (тест 11)', () => {
  it('без выбора — worktree сессии в фокусе; выбран worktree S02 — фокус на файле и терминале S03 его не меняет', async () => {
    openInLayout(term('s-03'));
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await waitFor(() => expect(bridge.watchCalls.at(-1)?.root).toEqual(S03));

    act(() => useFilesStore.getState().setRoot(KEY, S02.spec));
    await waitFor(() => expect(bridge.watchCalls.at(-1)?.root).toEqual(S02));
    const watched = bridge.watchCalls.length;
    openInLayout(FILE_TAB);
    openInLayout(term('s-03'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.watchCalls).toHaveLength(watched);
    expect(bridge.gitStatusCalls.at(-1)).toEqual(S02);
  });

  it('без выбора фокус на вкладке файла корень не сбрасывает на проект', async () => {
    openInLayout(term('s-02'));
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await waitFor(() => expect(bridge.watchCalls.at(-1)?.root).toEqual(S02));
    openInLayout(FILE_TAB);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.watchCalls.at(-1)?.root).toEqual(S02);
    expect(bridge.watchCalls).toHaveLength(1);
  });

  it('корень исчез (worktree удалён) — тост «Session folder no longer exists» и проект', async () => {
    act(() => useFilesStore.getState().setRoot(KEY, S02.spec));
    const view = render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await waitFor(() => expect(bridge.watchCalls.at(-1)?.root).toEqual(S02));
    const gone = makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-01', 'plain'), makeSession('s-02', 'two')] });
    view.rerender(<FilesPanel bridge={bridge} entry={gone} />);
    await waitFor(() => expect(bridge.watchCalls.at(-1)?.root).toEqual(PROJECT));
    expect(toast).toHaveBeenCalledWith('Session folder no longer exists');
    expect(useFilesStore.getState().rootByWork[KEY]).toEqual({ kind: 'project' });
  });

  it('папки worktree нет на диске (list корня — not_found) — тот же тост и проект', async () => {
    act(() => useFilesStore.getState().setRoot(KEY, S02.spec));
    bridge.setDir(S02, '', { code: 'not_found', message: 'нет' });
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    await waitFor(() => expect(useFilesStore.getState().rootByWork[KEY]).toEqual({ kind: 'project' }));
    expect(toast).toHaveBeenCalledWith('Session folder no longer exists');
  });
});

describe('переключатель игнорируемых', () => {
  it('Show ignored files — patchUi({ filesShowIgnored })', async () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    render(<FilesPanel bridge={bridge} entry={ENTRY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show ignored files' }));
    expect(useUiStore.getState().ui.filesShowIgnored).toBe(true);
    expect(saveUi).toHaveBeenCalledWith({ filesShowIgnored: true });
  });
});
