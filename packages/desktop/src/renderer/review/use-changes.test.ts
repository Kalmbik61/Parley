/**
 * `useChanges` (кусок 8.2a, тест 8) — поддельные таймеры: дроссель 2 с проверяется
 * временем, а не ожиданием.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { WorkEntry, WorktreeDiff } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useReviewStore } from './store.js';
import { useChanges } from './use-changes.js';

const commit = { hash: 'b'.repeat(40), subject: 'feat', author: 'agent', at: '2026-09-27T09:00:00Z' };

function diff(patch: Partial<WorktreeDiff> = {}): WorktreeDiff {
  return {
    patch: '',
    files: [],
    uncommitted: false,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    mergeBase: 'a'.repeat(40),
    stats: { additions: 0, deletions: 0 },
    commits: [],
    uncommittedPaths: [],
    ...patch,
  };
}

const worktree = { path: '/tmp/wt/s-02', branch: 'harnas/w-a/s02', base: 'master', createdAt: '2026-09-27T08:00:00Z' };

function work(title = 'w-a', createdAt: string | null = worktree.createdAt): WorkEntry {
  return makeWork('w-a', {
    title,
    sessions: [
      makeSession('s-02', 'S02', { worktree: { ...worktree, createdAt } }),
      makeSession('s-03', 'S03', { worktree: { ...worktree, path: '/tmp/wt/s-03', branch: 'harnas/w-a/s03' } }),
      makeSession('s-04', 'S04'),
    ],
  });
}

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-02' };

let bridge: FakeBridge;

function count(method: string): number {
  return bridge.calls.filter((c) => c.method === method).length;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function emitWorks(entries: WorkEntry[]): void {
  act(() => {
    bridge.emit('works.changed', { entries, branches: {} });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge = createFakeBridge();
  bridge.setHandler('worktrees.diff', () => diff({ commits: [commit], files: [{ path: 'a.ts', status: 'M', oldPath: null, additions: 1, deletions: 0 }] }));
  bridge.setHandler('worktrees.mergeCheck', () => ({ status: 'clean' }));
  bridge.setHandler('changes.project', () => ({ patch: '', files: [], stats: { additions: 0, deletions: 0 }, branch: 'master' }));
  useActivityStore.setState({ byRef: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useChanges (кусок 8.2a, тест 8)', () => {
  it('монтирование — worktrees.diff с patch: false, затем mergeCheck; source — worktree', async () => {
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    expect(result.current.loading).toBe(true);
    await flush();
    expect(bridge.calls.filter((c) => c.method === 'worktrees.diff').map((c) => c.params)).toEqual([{ ref, patch: false }]);
    expect(bridge.calls.filter((c) => c.method === 'worktrees.mergeCheck').map((c) => c.params)).toEqual([{ ref }]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    const source = result.current.source;
    expect(source?.kind).toBe('worktree');
    if (source?.kind !== 'worktree') return;
    expect(source.check).toEqual({ status: 'clean' });
    expect(source.base).toBe('master');
    expect(source.branch).toBe('harnas/w-a/s02');
  });

  it('три works.changed этой работы за секунду → один worktrees.diff', async () => {
    renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    expect(count('worktrees.diff')).toBe(1);
    await flush(100);
    emitWorks([work('t1')]);
    await flush(400);
    emitWorks([work('t2')]);
    await flush(400);
    emitWorks([work('t3')]);
    await flush(2000);
    expect(count('worktrees.diff')).toBe(2);
    // Тот же снимок ещё раз — карта не изменилась, вызова нет.
    emitWorks([work('t3')]);
    await flush(3000);
    expect(count('worktrees.diff')).toBe(2);
  });

  it('works.changed, где изменилась только другая работа, — вызова нет', async () => {
    renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush(2500);
    emitWorks([work(), makeWork('w-b', { title: 'x' })]);
    await flush(100);
    emitWorks([work(), makeWork('w-b', { title: 'y' })]);
    await flush(3000);
    expect(count('worktrees.diff')).toBe(1);
  });

  it('переход сессии из working — обновление; refresh() — сразу, мимо дросселя', async () => {
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush(2500);
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working')]) });
    });
    await flush(100);
    expect(count('worktrees.diff')).toBe(1);
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'idle')]) });
    });
    await flush();
    expect(count('worktrees.diff')).toBe(2);
    // Только что загружено: дроссель держал бы, refresh — нет.
    act(() => {
      result.current.refresh();
    });
    await flush();
    expect(count('worktrees.diff')).toBe(3);
  });

  it('лид закончил ход, а фоновые субагенты идут (working остаётся, удержание включилось) — обновление', async () => {
    renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush(2500);
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working')]) });
    });
    await flush(100);
    expect(count('worktrees.diff')).toBe(1);

    act(() => {
      useActivityStore.setState({
        byRef: activityMap([makeActivity(ref, 'working', { heldByBackground: true })]),
      });
    });
    await flush();
    expect(count('worktrees.diff')).toBe(2);

    // Удержание продолжается — новых поводов нет; когда фоновые закончились, переход в idle — ещё один.
    await flush(2500);
    act(() => {
      useActivityStore.setState({
        byRef: activityMap([
          makeActivity(ref, 'working', {
            heldByBackground: true,
            lastEventAt: '2026-09-27T09:05:00.000Z',
          }),
        ]),
      });
    });
    await flush(2500);
    expect(count('worktrees.diff')).toBe(2);
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'unseen')]) });
    });
    await flush();
    expect(count('worktrees.diff')).toBe(3);
  });

  it('переход другой сессии из working вкладку не будит', async () => {
    renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush(2500);
    const other = { ...ref, sessionId: 's-03' };
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(other, 'working')]) });
    });
    act(() => {
      useActivityStore.setState({ byRef: activityMap([makeActivity(other, 'idle')]) });
    });
    await flush(3000);
    expect(count('worktrees.diff')).toBe(1);
  });

  it('mergeCheck: без коммитов ветки — нет; mergeCheck: false — нет', async () => {
    bridge.setHandler('worktrees.diff', () => diff());
    const first = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    expect(count('worktrees.mergeCheck')).toBe(0);
    first.unmount();

    bridge.setHandler('worktrees.diff', () => diff({ commits: [commit] }));
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02', mergeCheck: false }));
    await flush();
    expect(count('worktrees.diff')).toBe(2);
    expect(count('worktrees.mergeCheck')).toBe(0);
    expect(result.current.source?.kind === 'worktree' && result.current.source.check).toBeNull();
  });

  it('отказ проверки → check: null, error: null и console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('worktrees.mergeCheck', () => {
      throw { code: 'internal', message: 'merge-tree упал' };
    });
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.source?.kind).toBe('worktree');
    expect(result.current.source?.kind === 'worktree' && result.current.source.check).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('отказ diff с причиной git — текст по причине', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('worktrees.diff', () => {
      throw { code: 'internal', message: 'нет git', data: { reason: 'git-missing' } };
    });
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    expect(result.current.error).toBe('Git not found');
    expect(result.current.loading).toBe(false);
  });

  it('отказ diff с причиной worktree-missing — признак discarded в сторе ревью, без текста ошибки (раунд 8, пункт 1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useReviewStore.setState({ discarded: {} });
    bridge.setHandler('worktrees.diff', () => {
      throw { code: 'bad_request', message: 'нет папки', data: { reason: 'worktree-missing' } };
    });
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    expect(useReviewStore.getState().discarded[refKey(ref)]).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('pending → ни worktrees.diff, ни changes.project', async () => {
    const { result } = renderHook(() => useChanges({ bridge, entry: work('w-a', null), sessionId: 's-02' }));
    await flush(3000);
    expect(count('worktrees.diff')).toBe(0);
    expect(count('changes.project')).toBe(0);
    expect(result.current.source).toEqual({ kind: 'pending' });
    expect(result.current.loading).toBe(false);
  });

  it('сессия без worktree — changes.project с patch: false', async () => {
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-04' }));
    await flush();
    expect(bridge.calls.filter((c) => c.method === 'changes.project').map((c) => c.params)).toEqual([
      { ref: { ...ref, sessionId: 's-04' }, patch: false },
    ]);
    expect(count('worktrees.diff')).toBe(0);
    expect(result.current.source?.kind).toBe('project');
  });

  it('ответ запроса прежней сессии отбрасывается', async () => {
    let release: ((value: WorktreeDiff) => void) | null = null;
    bridge.setHandler('worktrees.diff', (params) =>
      params.ref.sessionId === 's-02'
        ? new Promise<WorktreeDiff>((resolve) => {
            release = resolve;
          })
        : diff({ files: [{ path: 'fresh.ts', status: 'A', oldPath: null, additions: 1, deletions: 0 }] }),
    );
    const entry = work();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useChanges({ bridge, entry, sessionId: id }), {
      initialProps: { id: 's-02' },
    });
    await flush();
    rerender({ id: 's-03' });
    await flush();
    act(() => {
      release?.(diff({ files: [{ path: 'stale.ts', status: 'A', oldPath: null, additions: 1, deletions: 0 }] }));
    });
    await flush();
    const source = result.current.source;
    expect(source?.kind === 'worktree' && source.diff.files.map((f) => f.path)).toEqual(['fresh.ts']);
    expect(source?.kind === 'worktree' && source.branch).toBe('harnas/w-a/s03');
  });

  it('каждая загрузка — новый объект source', async () => {
    const { result } = renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush();
    const first = result.current.source;
    act(() => {
      result.current.refresh();
    });
    await flush();
    expect(result.current.source).not.toBe(first);
    expect(result.current.source).toEqual(first);
  });

  it('возврат связи с хостом — загрузка заново', async () => {
    renderHook(() => useChanges({ bridge, entry: work(), sessionId: 's-02' }));
    await flush(2500);
    act(() => {
      useHostStore.setState((state) => ({ connections: state.connections + 1 }));
    });
    await flush();
    expect(count('worktrees.diff')).toBe(2);
  });

  it('sessionId: null или сессии нет в карте — вызовов нет, source: null', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useChanges({ bridge, entry: work(), sessionId: id }), {
      initialProps: { id: null as string | null },
    });
    await flush(3000);
    expect(result.current.source).toBeNull();
    rerender({ id: 's-99' });
    await flush(3000);
    expect(result.current.source).toBeNull();
    expect(bridge.calls).toEqual([]);
  });
});
