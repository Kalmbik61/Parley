/**
 * Тесты 9 и 17 куска 3.3: общий источник секций и внимания сайдбара.
 * Писатель один (`useSidebarSectionsSync`, в окне — `AppShell`), читатели видят один
 * и тот же порядок; пока указатель над списком, порядок держится.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { workKey } from '../lib/tree-order.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useSidebarAttention, useSidebarSections, useSidebarSectionsStore, useSidebarSectionsSync } from './use-sidebar-sections.js';

const a = makeWork('w-a', { projectPath: '/p/one', createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'a')] });
const b = makeWork('w-b', { projectPath: '/p/one', createdAt: '2026-09-27T08:01:00.000Z', sessions: [makeSession('s-01', 'b')] });
const keyA = workKey(a.projectPath, a.map.work.id);
const keyB = workKey(b.projectPath, b.map.work.id);

const orderOf = (sections: ReturnType<typeof useSidebarSections>): string[] =>
  sections.flatMap((section) => section.works.map((entry) => workKey(entry.projectPath, entry.map.work.id)));

/** Без внимания свежее выше: b создана позже и стоит первой. Вопрос в a поднимает её. */
function blockA(): void {
  const ref = { projectPath: a.projectPath, workId: a.map.work.id, sessionId: 's-01' };
  useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'blocked')]) });
}

beforeEach(() => {
  useWorksStore.setState({ entries: [a, b], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useUiStore.setState({ ui: DEFAULT_UI, sidebarHovering: false });
  useSidebarSectionsStore.setState({ sections: [], attention: {}, entries: null });
});

afterEach(cleanup);

/** Как в окне: писатель вверху, два читателя ниже; второй можно спрятать (свёрнутый сайдбар). */
let seen: Record<string, string[]> = {};
let setReadersShown: (shown: boolean) => void = () => {};

function Reader({ name }: { name: string }): null {
  seen[name] = orderOf(useSidebarSections());
  return null;
}

function Shell(): JSX.Element {
  useSidebarSectionsSync();
  const [shown, setShown] = useState(true);
  setReadersShown = setShown;
  return shown ? (
    <>
      <Reader name="sidebar" />
      <Reader name="status" />
    </>
  ) : (
    <></>
  );
}

describe('useSidebarSections (тест 9)', () => {
  it('два читателя видят один порядок; под указателем оба держат прежний, после ухода — новый', () => {
    seen = {};
    render(<Shell />);
    expect(seen.sidebar).toEqual([keyB, keyA]);
    expect(seen.status).toEqual(seen.sidebar);

    act(() => useUiStore.getState().setSidebarHovering(true));
    act(() => blockA());
    expect(seen.sidebar).toEqual([keyB, keyA]);
    expect(seen.status).toEqual([keyB, keyA]);

    act(() => useUiStore.getState().setSidebarHovering(false));
    expect(seen.sidebar).toEqual([keyA, keyB]);
    expect(seen.status).toEqual([keyA, keyB]);
  });

  it('при свёрнутом сайдбаре (читателей нет) секции в сторе по-прежнему обновляются', () => {
    render(<Shell />);
    act(() => setReadersShown(false));
    act(() => blockA());
    expect(orderOf(useSidebarSectionsStore.getState().sections)).toEqual([keyA, keyB]);
    const { result } = renderHook(() => useSidebarSections());
    expect(orderOf(result.current)).toEqual([keyA, keyB]);
  });
});

describe('useSidebarSectionsSync и useSidebarAttention (тест 17)', () => {
  it('возврат — секции своего рендера: в рендере первого снимка в нём уже его работы', () => {
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    const { result } = renderHook(() => useSidebarSectionsSync());
    expect(result.current).toEqual([]);

    act(() => useWorksStore.setState({ entries: [a, b], loading: false }));
    expect(orderOf(result.current)).toEqual([keyB, keyA]);
  });

  it('внимание — по работам секций, ключ workKey; blocked даёт needs-you', () => {
    blockA();
    renderHook(() => useSidebarSectionsSync());
    const { result } = renderHook(() => useSidebarAttention());
    expect(Object.keys(result.current).sort()).toEqual([keyA, keyB].sort());
    expect(result.current[keyA]?.level).toBe('needs-you');
    expect(result.current[keyA]?.needsYou).toBe(1);
    expect(result.current[keyB]?.level).toBe('idle');
  });
});

describe('структурное разделение и снимок (раунд исправлений 1 куска 3.3)', () => {
  it('событие работы A оставляет прежним объект внимания B; стор помнит снимок, по которому считал', () => {
    renderHook(() => useSidebarSectionsSync());
    const first = useSidebarSectionsStore.getState();
    expect(first.entries).toBe(useWorksStore.getState().entries);

    act(() => blockA());
    const second = useSidebarSectionsStore.getState();
    expect(second.attention[keyB]).toBe(first.attention[keyB]);
    expect(second.attention[keyA]).not.toBe(first.attention[keyA]);

    // Та же запись активности новым объектом, поля те же — вся карта внимания прежняя.
    act(() => blockA());
    expect(useSidebarSectionsStore.getState().attention).toBe(second.attention);

    const next = [a, b, makeWork('w-c', { projectPath: '/p/two' })];
    act(() => useWorksStore.setState({ entries: next }));
    expect(useSidebarSectionsStore.getState().entries).toBe(next);
  });
});

// Спека архива комнат и проектов, 6.1 и 6.3: убранные из списка проекты и раскрытая ссылка «N archived».
describe('hiddenProjects и ссылка «N archived» (спека архива, 6.1, 6.3)', () => {
  const gone = '/p/gone';
  const archivedOnly = makeWork('w-arch', { projectPath: gone, status: 'archived' });
  const keysIn = (sections: ReturnType<typeof useSidebarSections>): string[] => sections.map((section) => section.key);

  beforeEach(() => {
    useWorksStore.setState({ entries: [a, b, archivedOnly], branches: {}, loading: false, error: null });
    useUiStore.setState({ ui: { ...DEFAULT_UI, hiddenProjects: [gone] }, showArchived: false, archivedShownProjects: [] });
  });

  it('убранный проект из одних архивных не попадает в секции, его путь остаётся в ui', () => {
    const { result } = renderHook(() => useSidebarSectionsSync());
    expect(keysIn(result.current)).toEqual(['/p/one']);
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([gone]);
  });

  it('общий показ архивных («Show archived workspaces») показывает и убранный проект, путь остаётся', () => {
    const { result } = renderHook(() => useSidebarSectionsSync());
    act(() => useUiStore.getState().toggleShowArchived());
    expect(keysIn(result.current)).toEqual(['/p/one', gone]);
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([gone]);
  });

  it('в убранном проекте появилась неархивная работа (от агента или CLI) — путь снимается из hiddenProjects, проект возвращается', () => {
    const { result } = renderHook(() => useSidebarSectionsSync());
    act(() => useWorksStore.setState({ entries: [a, b, archivedOnly, makeWork('w-new', { projectPath: gone })] }));
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([]);
    expect(keysIn(result.current)).toContain(gone);
  });

  it('Reopen архивной работы и работа в статусе done тоже возвращают проект', () => {
    renderHook(() => useSidebarSectionsSync());
    act(() => useWorksStore.setState({ entries: [a, b, makeWork('w-arch', { projectPath: gone, status: 'done' })] }));
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([]);
  });

  it('новая архивная работа проект не возвращает, а чужие убранные пути остаются', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, hiddenProjects: [gone, '/p/other'] } });
    const { result } = renderHook(() => useSidebarSectionsSync());
    act(() => useWorksStore.setState({ entries: [a, b, archivedOnly, makeWork('w-arch2', { projectPath: gone, status: 'archived' })] }));
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([gone, '/p/other']);
    expect(keysIn(result.current)).toEqual(['/p/one']);

    // Вернулся только /p/gone, а /p/other без работ остаётся убранным.
    act(() => useWorksStore.setState({ entries: [a, b, archivedOnly, makeWork('w-live', { projectPath: gone })] }));
    expect(useUiStore.getState().ui.hiddenProjects).toEqual(['/p/other']);
  });

  it('пока работы не загрузились, путь не снимается', () => {
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    renderHook(() => useSidebarSectionsSync());
    expect(useUiStore.getState().ui.hiddenProjects).toEqual([gone]);
  });

  it('раскрытая ссылка проекта вносит его архивные работы в секцию, спрятанная — убирает', () => {
    useUiStore.setState({ ui: DEFAULT_UI });
    const { result } = renderHook(() => useSidebarSectionsSync());
    const section = () => result.current.find((item) => item.key === gone);
    expect(section()?.works).toEqual([]);
    expect(section()?.archived).toEqual({ count: 1, shown: false });

    act(() => useUiStore.getState().setProjectArchivedShown(gone, true));
    expect(section()?.works.map((entry) => entry.map.work.id)).toEqual(['w-arch']);
    expect(section()?.archived).toEqual({ count: 1, shown: true });

    act(() => useUiStore.getState().setProjectArchivedShown(gone, false));
    expect(section()?.works).toEqual([]);
  });
});
