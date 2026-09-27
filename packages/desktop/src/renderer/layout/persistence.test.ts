/**
 * Тесты 3, 4, 5, 6, 12, 13, 16 куска 2.2 плана каркаса (`layout/persistence.ts`).
 * Стор — модуль-синглтон zustand, сбрасывается в `beforeEach`, как и в
 * `store.test.ts`. Таймер-паттерн (реальные таймеры на `waitFor`, подставные —
 * на проверку тишины) — тот же, что был у сохранения прежнего центра (до 2.7).
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { tabId } from './ids.js';
import { emptyLayout, groups, openTab, splitGroup } from './tree.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { isTabAlive, neighborWork, useLayoutPersistence } from './persistence.js';

function session(id: string, overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id,
    provider: 'claude',
    label: id,
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
    ...overrides,
  };
}

function work(id: string, projectPath: string, sessions: WorkSession[] = []): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

const keyA = '/tmp/a w-a';
const keyB = '/tmp/b w-b';
const keyC = '/tmp/c w-c';

function resetStore(): void {
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  useLayoutStore.getState().setCloseGuard(null);
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('isTabAlive', () => {
  const aliveSession = session('s-01', {
    worktree: { path: '/wt', branch: 'b', base: 'main', createdAt: '2026-01-01' },
  });
  const plannedWorktreeSession = session('s-02', {
    worktree: { path: '/wt2', branch: 'b2', base: 'main', createdAt: null },
  });
  const entry = work('w-a', '/tmp/a', [aliveSession, plannedWorktreeSession]);

  it('terminal и diff — по наличию сессии', () => {
    expect(isTabAlive(entry, { kind: 'terminal', id: 't', sessionId: 's-01' })).toBe(true);
    expect(isTabAlive(entry, { kind: 'terminal', id: 't', sessionId: 's-99' })).toBe(false);
    expect(isTabAlive(entry, { kind: 'diff', id: 'd', sessionId: 's-01', commit: null })).toBe(true);
    expect(isTabAlive(entry, { kind: 'diff', id: 'd', sessionId: 's-99', commit: null })).toBe(false);
  });

  it('room — по наличию комнаты', () => {
    const withRoom = work('w-b', '/tmp/b');
    withRoom.map.rooms.push({ id: 'r-01', title: 'r', creator: 'human', members: [], createdAt: '2026-01-01' });
    expect(isTabAlive(withRoom, { kind: 'room', id: 'x', roomId: 'r-01' })).toBe(true);
    expect(isTabAlive(withRoom, { kind: 'room', id: 'x', roomId: 'r-99' })).toBe(false);
  });

  it('mail и browser — всегда живы', () => {
    expect(isTabAlive(entry, { kind: 'mail', id: 'mail' })).toBe(true);
    expect(isTabAlive(entry, { kind: 'browser', id: 'b', url: 'https://x' })).toBe(true);
  });

  it('file в корне проекта — всегда жив', () => {
    expect(isTabAlive(entry, { kind: 'file', id: 'f', root: { kind: 'project' }, path: 'a.ts' })).toBe(true);
  });

  it('file в worktree — жив, только пока worktree создан на диске', () => {
    expect(
      isTabAlive(entry, { kind: 'file', id: 'f', root: { kind: 'worktree', sessionId: 's-01' }, path: 'a.ts' }),
    ).toBe(true);
    expect(
      isTabAlive(entry, { kind: 'file', id: 'f', root: { kind: 'worktree', sessionId: 's-02' }, path: 'a.ts' }),
    ).toBe(false);
    expect(
      isTabAlive(entry, { kind: 'file', id: 'f', root: { kind: 'worktree', sessionId: 's-99' }, path: 'a.ts' }),
    ).toBe(false);
  });
});

describe('neighborWork', () => {
  it('следующий по порядку; у последней — предыдущий; нет в списке — null', () => {
    expect(neighborWork(['a', 'b', 'c'], 'a')).toBe('b');
    expect(neighborWork(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighborWork(['a'], 'a')).toBeNull();
    expect(neighborWork(['a', 'b'], 'z')).toBeNull();
  });
});

describe('useLayoutPersistence', () => {
  it('до worksLoaded loadLayout не зовётся; после — ровно один для показанной работы (тест 4)', async () => {
    const bridge = createFakeBridge();
    const loadLayoutSpy = vi.spyOn(bridge.app, 'loadLayout');
    const entryA = work('w-a', '/tmp/a');

    const { rerender } = renderHook(
      ({ loaded }: { loaded: boolean }) =>
        useLayoutPersistence({
          bridge,
          works: loaded ? [entryA] : [],
          worksLoaded: loaded,
          order: loaded ? [keyA] : [],
        }),
      { initialProps: { loaded: false } },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadLayoutSpy).not.toHaveBeenCalled();

    rerender({ loaded: true });

    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));
    expect(loadLayoutSpy).toHaveBeenCalledTimes(1);
    expect(loadLayoutSpy).toHaveBeenCalledWith(keyA);
  });

  it('восстановление выбрасывает вкладку удалённой сессии и схлопывает пустую группу (тест 5)', async () => {
    const bridge = createFakeBridge();
    const aliveTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' };
    const deadTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-99'), sessionId: 's-99' };
    let raw: WorkLayout = openTab(emptyLayout(), aliveTab, 'active');
    raw = splitGroup(raw, raw.activeGroupId, 'row', deadTab).layout;
    await bridge.app.saveLayout(keyA, raw);

    const entryA = work('w-a', '/tmp/a', [session('s-01')]); // s-99 в карте нет

    renderHook(() => useLayoutPersistence({ bridge, works: [entryA], worksLoaded: true, order: [keyA] }));

    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));

    const restored = useLayoutStore.getState().layouts[keyA] as WorkLayout;
    const ids = groups(restored).flatMap((g) => g.tabs.map((t) => t.id));
    expect(ids).toEqual([aliveTab.id]);
    expect(groups(restored)).toHaveLength(1);
  });

  it('работа, пропавшая из снимка, — drop и removeLayout (тест 6)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [entryA, entryB], order: [keyA, keyB] } },
    );

    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));
    useLayoutStore.getState().hydrate(keyB, emptyLayout());

    rerender({ entries: [entryA], order: [keyA] });

    expect(bridge.layoutRemovals).toEqual([keyB]);
    expect(useLayoutStore.getState().layouts[keyB]).toBeUndefined();
  });

  it('пять изменений за 200 мс дают одно сохранение; изменения в двух работах — два сохранения (тест 3)', async () => {
    const bridge = createFakeBridge();
    const sessions = Array.from({ length: 5 }, (_, i) => session(`s-0${i}`));
    const entryA = work('w-a', '/tmp/a', sessions);
    const entryB = work('w-b', '/tmp/b', [session('s-10')]);

    renderHook(() =>
      useLayoutPersistence({ bridge, works: [entryA, entryB], worksLoaded: true, order: [keyA, keyB] }),
    );
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));
    // Работа B в этом тесте не активна и не гидрируется сама — гидрируем напрямую,
    // раз тест проверяет именно сохранение, а не восстановление.
    useLayoutStore.getState().hydrate(keyB, emptyLayout());

    vi.useFakeTimers();
    const tabFor = (n: number): TabSpec => ({ kind: 'terminal', id: tabId.terminal(`s-0${n}`), sessionId: `s-0${n}` });

    for (let i = 0; i < 5; i += 1) {
      useLayoutStore.getState().apply(keyA, (l) => openTab(l, tabFor(i), 'active'));
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(bridge.layoutSaves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.layoutSaves.filter((s) => s.workKey === keyA)).toHaveLength(1);
    expect(bridge.layoutSaves).toHaveLength(1);

    const tabB: TabSpec = { kind: 'terminal', id: tabId.terminal('s-10'), sessionId: 's-10' };
    useLayoutStore.getState().apply(keyB, (l) => openTab(l, tabB, 'active'));
    await vi.advanceTimersByTimeAsync(500);

    expect(bridge.layoutSaves.filter((s) => s.workKey === keyB)).toHaveLength(1);
    expect(bridge.layoutSaves).toHaveLength(2);
  });

  // Раунд исправлений 1, Important A: вкладка, открытая через `apply` ДО того,
  // как работа гидрирована (уходит в `pending`), должна попасть на диск после
  // гидрации — иначе, если по этой работе больше ничего не изменится, она не
  // сохранится вообще никогда (переход `layouts[key]: undefined → значение`
  // сам по себе не считается «изменением», см. тест 3/4 — это тот самый
  // случай, когда его всё-таки нужно посчитать: очередь была не пуста).
  it('вкладка из pending, применённая на первой гидрации, всё равно сохраняется (раунд исправлений 1, Important A)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a', [session('s-01')]);
    const pendingTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' };

    // Клик по сессии этой работы до того, как она стала показанной (сценарий
    // 2.7/4.3) — уходит в pending, потому что `worksLoaded`/гидрация ещё не было.
    useLayoutStore.getState().apply(keyA, (l) => openTab(l, pendingTab, 'active'));
    expect(useLayoutStore.getState().layouts[keyA]).toBeUndefined();

    renderHook(() => useLayoutPersistence({ bridge, works: [entryA], worksLoaded: true, order: [keyA] }));

    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));

    await waitFor(
      () => {
        expect(bridge.layoutSaves.some((s) => s.workKey === keyA)).toBe(true);
      },
      { timeout: 2000 },
    );

    const saved = bridge.layoutSaves.find((s) => s.workKey === keyA);
    const ids = groups(saved?.layout as WorkLayout).flatMap((g) => g.tabs.map((t) => t.id));
    expect(ids).toContain(pendingTab.id);
  });

  it('первый снимок после worksLoaded зовёт retainLayouts ровно один раз (тест 13)', () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { rerender } = renderHook(
      ({ order }: { order: string[] }) =>
        useLayoutPersistence({ bridge, works: [entryA, entryB], worksLoaded: true, order }),
      { initialProps: { order: [keyA, keyB] } },
    );

    expect(bridge.layoutRetains).toEqual([[keyA, keyB]]);

    rerender({ order: [keyA, keyB] });
    rerender({ order: [keyB, keyA] });
    expect(bridge.layoutRetains).toHaveLength(1);
  });

  it('активная работа пропала → активна соседняя по прежнему order (тест 12)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');
    const entryC = work('w-c', '/tmp/c');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [entryA, entryB, entryC], order: [keyA, keyB, keyC] } },
    );
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyA));

    useLayoutStore.getState().setActiveWork(keyB);
    rerender({ entries: [entryA, entryC], order: [keyA, keyC] });

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyC);
    expect(bridge.layoutRemovals).toEqual([keyB]);
  });

  it('пропала активная последняя в order работа → активна предыдущая (тест 12)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');
    const entryC = work('w-c', '/tmp/c');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [entryA, entryB, entryC], order: [keyA, keyB, keyC] } },
    );
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyA));

    useLayoutStore.getState().setActiveWork(keyC);
    rerender({ entries: [entryA, entryB], order: [keyA, keyB] });

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyB);
    expect(bridge.layoutRemovals).toEqual([keyC]);
  });

  // Раунд исправлений 1, Critical (A+B): активная работа и её единственный
  // выживший сосед по прежнему `order` пропадают ОДНИМ снимком — старая версия
  // цикла считала `neighborWork` по каждому пропавшему ключу отдельно и на
  // втором шаге принимала уже назначенного «преемника» за только что ставшего
  // активным, откатываясь обратно на первый (уже удалённый) ключ-призрак.
  it('активная работа и её сосед пропадают одним снимком → активна выжившая (раунд исправлений 1, Critical)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');
    const entryC = work('w-c', '/tmp/c');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [entryA, entryB, entryC], order: [keyA, keyB, keyC] } },
    );
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyA));

    useLayoutStore.getState().setActiveWork(keyB);
    // B и C пропадают разом — остаётся только A.
    rerender({ entries: [entryA], order: [keyA] });

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyA);
    expect(bridge.layoutRemovals.sort()).toEqual([keyB, keyC].sort());
  });

  it('исчезли все работы разом → activeWorkKey становится null, а не ключ-призрак (раунд исправлений 1, Critical)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [entryA, entryB], order: [keyA, keyB] } },
    );
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyA));

    rerender({ entries: [], order: [] });

    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(bridge.layoutRemovals.sort()).toEqual([keyA, keyB].sort());
  });

  // Кусок 2.7 (E2E `layout.spec.ts`): `order` у `AppShell` — новый массив на
  // каждый рендер. Повторный прогон эффекта до ответа `loadUi` отменял выбор
  // из `ui.json`, и активной после перезапуска становилась первая работа, а не
  // последняя активная (спека 5.6).
  it('перерисовка с тем же составом до ответа loadUi не сбивает последнюю активную работу из ui.json (кусок 2.7)', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ activeWorkKey: keyB });
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { rerender } = renderHook(
      ({ order }: { order: string[] }) => useLayoutPersistence({ bridge, works: [entryA, entryB], worksLoaded: true, order }),
      { initialProps: { order: [keyA, keyB] } },
    );
    rerender({ order: [keyA, keyB] });

    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyB));
  });

  it('старт без работ, потом снимок с двумя — активна первая, saveUi после 300 мс тишины (тест 16)', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { rerender } = renderHook(
      ({ entries, order }: { entries: WorkEntry[]; order: string[] }) =>
        useLayoutPersistence({ bridge, works: entries, worksLoaded: true, order }),
      { initialProps: { entries: [] as WorkEntry[], order: [] as string[] } },
    );

    expect(useLayoutStore.getState().activeWorkKey).toBeNull();

    vi.useFakeTimers();
    rerender({ entries: [entryA, entryB], order: [keyA, keyB] });

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyA);
    expect(saveUiSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(saveUiSpy).toHaveBeenCalledWith({ activeWorkKey: keyA });
  });

  // Раунд исправлений 1, Important B: закрытие окна = размонтирование этого
  // хука в реальном Electron — правка внутри тишины 500/300 мс не должна
  // тихо теряться, если он размонтируется раньше, чем таймер успел сработать.
  it('размонтирование до истечения тишины 500 мс всё равно сохраняет раскладку (раунд исправлений 1, Important B)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a', [session('s-01')]);

    const { unmount } = renderHook(() =>
      useLayoutPersistence({ bridge, works: [entryA], worksLoaded: true, order: [keyA] }),
    );
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));

    vi.useFakeTimers();
    const newTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' };
    useLayoutStore.getState().apply(keyA, (l) => openTab(l, newTab, 'active'));

    unmount();
    await vi.advanceTimersByTimeAsync(1000);

    const saved = bridge.layoutSaves.find((s) => s.workKey === keyA);
    expect(saved).toBeDefined();
    const ids = groups(saved?.layout as WorkLayout).flatMap((g) => g.tabs.map((t) => t.id));
    expect(ids).toContain(newTab.id);
  });

  it('размонтирование до истечения тишины 300 мс всё равно пишет activeWorkKey в ui.json (раунд исправлений 1, Important B)', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    const entryA = work('w-a', '/tmp/a');
    const entryB = work('w-b', '/tmp/b');

    const { unmount } = renderHook(() =>
      useLayoutPersistence({ bridge, works: [entryA, entryB], worksLoaded: true, order: [keyA, keyB] }),
    );
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(keyA));

    vi.useFakeTimers();
    useLayoutStore.getState().setActiveWork(keyB);

    unmount();
    await vi.advanceTimersByTimeAsync(1000);

    expect(saveUiSpy).toHaveBeenCalledWith({ activeWorkKey: keyB });
  });

  it('beforeunload флашит отложенное сохранение раскладки без ожидания тишины (раунд исправлений 1, Important B)', async () => {
    const bridge = createFakeBridge();
    const entryA = work('w-a', '/tmp/a', [session('s-01')]);

    renderHook(() => useLayoutPersistence({ bridge, works: [entryA], worksLoaded: true, order: [keyA] }));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyA]).toBe(true));

    vi.useFakeTimers();
    const newTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' };
    useLayoutStore.getState().apply(keyA, (l) => openTab(l, newTab, 'active'));

    window.dispatchEvent(new Event('beforeunload'));

    expect(bridge.layoutSaves.some((s) => s.workKey === keyA)).toBe(true);
  });
});
