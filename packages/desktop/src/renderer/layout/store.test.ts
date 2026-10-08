/**
 * Тесты 2, 10, 11, 15 куска 2.2 плана каркаса (`layout/store.ts`). Стор —
 * модуль-синглтон zustand, поэтому состояние сбрасывается в `beforeEach`, как
 * и у соседних сторов рендерера (`store/ui.test.ts`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkEntry } from '@parley/core';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId } from './ids.js';
import { emptyLayout, focusTab, groups, openTab, splitGroup } from './tree.js';
import { EMPTY_HISTORY } from './history.js';
import { focusedSessionOf, selectedSessionOf, useLayoutStore } from './store.js';

function terminalTab(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

function activeTabOfWork(workKey: string): string | null {
  const layout = useLayoutStore.getState().layouts[workKey];
  if (layout === undefined) return null;
  const group = groups(layout).find((g) => g.id === layout.activeGroupId);
  return group?.activeTabId ?? null;
}

beforeEach(() => {
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
});

describe('apply — ошибка операции (тест 2)', () => {
  function layoutWith8Groups(): WorkLayout {
    let layout = openTab(emptyLayout(), terminalTab('s-00'), 'active');
    for (let i = 1; i < 8; i += 1) {
      const result = splitGroup(layout, layout.activeGroupId, 'row', terminalTab(`s-0${i}`));
      layout = result.layout;
    }
    return layout;
  }

  it('too-many-groups возвращается, а layouts — прежний объект', () => {
    const layout = layoutWith8Groups();
    useLayoutStore.getState().hydrate('w1', layout);
    const layoutsBefore = useLayoutStore.getState().layouts;

    const error = useLayoutStore
      .getState()
      .apply('w1', (l) => splitGroup(l, l.activeGroupId, 'row', terminalTab('s-99')));

    expect(error).toBe('too-many-groups');
    expect(useLayoutStore.getState().layouts).toBe(layoutsBefore);
    expect(useLayoutStore.getState().layouts.w1).toBe(layout);
  });
});

describe('apply/hydrate до и после гидрации (тест 10)', () => {
  it('apply на негидрированной работе отвечает null и не трогает layouts; hydrate применяет очередь', () => {
    const openedTab = terminalTab('s-new');
    const result = useLayoutStore.getState().apply('w1', (l) => openTab(l, openedTab, 'active'));

    expect(result).toBeNull();
    expect(useLayoutStore.getState().layouts.w1).toBeUndefined();

    const savedTab = terminalTab('s-saved');
    const saved = openTab(emptyLayout(), savedTab, 'active');
    useLayoutStore.getState().hydrate('w1', saved);

    const hydrated = useLayoutStore.getState().layouts.w1;
    expect(hydrated).toBeDefined();
    const ids = groups(hydrated as WorkLayout).flatMap((g) => g.tabs.map((t) => t.id));
    expect(ids).toContain(savedTab.id);
    expect(ids).toContain(openedTab.id);
  });

  it('hydrate активной работы дописывает tabId в последнюю запись истории, а не делает новую', () => {
    useLayoutStore.getState().setActiveWork('w1');
    expect(useLayoutStore.getState().entries()).toHaveLength(1);
    expect(useLayoutStore.getState().entries()[0]?.tabId).toBeNull();

    const tab1 = terminalTab('s-01');
    const layout = openTab(emptyLayout(), tab1, 'active');
    useLayoutStore.getState().hydrate('w1', layout);

    const entries = useLayoutStore.getState().entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe(tab1.id);
  });
});

describe('первая вкладка гидрированной пустой работы (раунд lane-r3)', () => {
  it('клик по сессии работы с пустой раскладкой — одна запись истории; «назад» ведёт в прежнюю работу', () => {
    // Порядок «раскладка уже гидрирована → setActiveWork → openTab» — когда хост отвечает
    // быстро; при медленном хосте гидрация приходила позже и дописывала запись (`hydrate`).
    const a1 = terminalTab('a1');
    useLayoutStore.getState().hydrate('w1', openTab(emptyLayout(), a1, 'active'));
    useLayoutStore.getState().setActiveWork('w1');
    useLayoutStore.getState().hydrate('w2', emptyLayout());

    const b1 = terminalTab('b1');
    useLayoutStore.getState().setActiveWork('w2');
    useLayoutStore.getState().apply('w2', (l) => openTab(l, b1, 'active'));

    expect(useLayoutStore.getState().entries().map((e) => [e.workKey, e.tabId])).toEqual([
      ['w1', a1.id],
      ['w2', b1.id],
    ]);
    useLayoutStore.getState().back();
    expect(useLayoutStore.getState().activeWorkKey).toBe('w1');
  });
});

describe('back()/forward() (тест 11)', () => {
  it('ходят по истории вкладок и не плодят новые записи', () => {
    const tab1 = terminalTab('s-01');
    const tab2 = terminalTab('s-02');
    let layout = openTab(emptyLayout(), tab1, 'active');
    layout = openTab(layout, tab2, 'active');
    layout = focusTab(layout, tab1.id);

    useLayoutStore.getState().hydrate('w1', layout);
    useLayoutStore.getState().setActiveWork('w1');
    useLayoutStore.getState().apply('w1', (l) => focusTab(l, tab2.id));

    expect(useLayoutStore.getState().entries()).toHaveLength(2);
    expect(useLayoutStore.getState().canBack()).toBe(true);

    useLayoutStore.getState().back();
    expect(activeTabOfWork('w1')).toBe(tab1.id);
    expect(useLayoutStore.getState().entries()).toHaveLength(2);

    expect(useLayoutStore.getState().canForward()).toBe(true);
    useLayoutStore.getState().forward();
    expect(activeTabOfWork('w1')).toBe(tab2.id);
  });
});

describe('requestCloseTabs (тест 15)', () => {
  function twoTabLayout(): { layout: WorkLayout; tab1: TabSpec; tab2: TabSpec } {
    const tab1 = terminalTab('s-01');
    const tab2 = terminalTab('s-02');
    let layout = openTab(emptyLayout(), tab1, 'active');
    layout = openTab(layout, tab2, 'active');
    return { layout, tab1, tab2 };
  }

  it('без guard закрывает сразу, ответ true', async () => {
    const { layout, tab1, tab2 } = twoTabLayout();
    useLayoutStore.getState().hydrate('w1', layout);

    const result = await useLayoutStore.getState().requestCloseTabs('w1', [tab1.id, tab2.id]);

    expect(result).toBe(true);
    const finalLayout = useLayoutStore.getState().layouts.w1 as WorkLayout;
    expect(groups(finalLayout).flatMap((g) => g.tabs.map((t) => t.id))).toEqual([]);
  });

  it('guard отвечает false — раскладка прежняя, ответ false', async () => {
    const { layout, tab1, tab2 } = twoTabLayout();
    useLayoutStore.getState().hydrate('w1', layout);
    const seen: Array<{ workKey: string; tabIds: string[] }> = [];
    useLayoutStore.getState().setCloseGuard(async (workKey, tabIds) => {
      seen.push({ workKey, tabIds });
      return false;
    });

    const result = await useLayoutStore.getState().requestCloseTabs('w1', [tab1.id, tab2.id]);

    expect(result).toBe(false);
    expect(seen).toEqual([{ workKey: 'w1', tabIds: [tab1.id, tab2.id] }]);
    expect(useLayoutStore.getState().layouts.w1).toBe(layout);
  });

  it('guard отвечает true — закрывает обе вкладки из списка', async () => {
    const { layout, tab1, tab2 } = twoTabLayout();
    useLayoutStore.getState().hydrate('w1', layout);
    useLayoutStore.getState().setCloseGuard(async () => true);

    const result = await useLayoutStore.getState().requestCloseTabs('w1', [tab1.id, tab2.id]);

    expect(result).toBe(true);
    const finalLayout = useLayoutStore.getState().layouts.w1 as WorkLayout;
    expect(groups(finalLayout).flatMap((g) => g.tabs.map((t) => t.id))).toEqual([]);
  });
});

describe('selectedSessionOf (тест 5 куска 2.7)', () => {
  // Сессии в карте работы `selectedSessionOf` не проверяет — ей нужны только
  // путь проекта и id работы, чтобы собрать `SessionRef`.
  const works: WorkEntry[] = [
    {
      projectPath: '/tmp/p',
      map: {
        schemaVersion: 2,
        rooms: [],
        work: { id: 'w-01', title: 'A', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        sessions: [],
        messages: [],
      },
    },
  ];
  const key = '/tmp/p w-01';

  it('активная вкладка-терминал активной работы → её сессия', () => {
    const layout = openTab(openTab(emptyLayout(), { kind: 'mail', id: tabId.mail() }), terminalTab('s-02'));
    const state = { activeWorkKey: key, layouts: { [key]: layout } };
    expect(selectedSessionOf(state, works)).toEqual({
      workKey: key,
      ref: { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' },
    });
  });

  it('активна вкладка почты → null', () => {
    const layout = openTab(openTab(emptyLayout(), terminalTab('s-02')), { kind: 'mail', id: tabId.mail() });
    expect(selectedSessionOf({ activeWorkKey: key, layouts: { [key]: layout } }, works)).toBeNull();
  });

  it('активной работы нет → null', () => {
    const layout = openTab(emptyLayout(), terminalTab('s-02'));
    expect(selectedSessionOf({ activeWorkKey: null, layouts: { [key]: layout } }, works)).toBeNull();
  });
});

describe('focusedSessionOf (тест 2 куска 7.2)', () => {
  const key = '/tmp/p w-01';
  const fileTab: TabSpec = { kind: 'file', id: tabId.file({ kind: 'project' }, 'src/a.ts'), root: { kind: 'project' }, path: 'src/a.ts' };
  const diffTab: TabSpec = { kind: 'diff', id: tabId.diff('s-03', null), sessionId: 's-03', commit: null };

  function state(layout: WorkLayout, tabIds: Array<string | null>): Parameters<typeof focusedSessionOf>[0] {
    const history = tabIds.map((tabId, index) => ({ workKey: key, tabId, at: index }));
    return { layouts: { [key]: layout }, entries: () => history };
  }

  it('активна вкладка терминала S02 → s-02', () => {
    const layout = openTab(openTab(emptyLayout(), fileTab), terminalTab('s-02'));
    expect(focusedSessionOf(state(layout, [fileTab.id, tabId.terminal('s-02')]), key)).toBe('s-02');
  });

  it('активна вкладка файла, последней в истории была вкладка диффа S03 → s-03', () => {
    const layout = openTab(openTab(openTab(emptyLayout(), terminalTab('s-02')), diffTab), fileTab);
    const history = [tabId.terminal('s-02'), diffTab.id, fileTab.id];
    // Запись другой работы в истории не в счёт, даже если она свежее.
    const withForeign = { ...state(layout, history), entries: () => [...state(layout, history).entries(), { workKey: 'other', tabId: tabId.terminal('s-09'), at: 9 }] };
    expect(focusedSessionOf(withForeign, key)).toBe('s-03');
  });

  it('вкладка S03 закрыта — берётся запись раньше', () => {
    const layout = openTab(openTab(emptyLayout(), terminalTab('s-02')), fileTab);
    expect(focusedSessionOf(state(layout, [tabId.terminal('s-02'), diffTab.id, fileTab.id]), key)).toBe('s-02');
  });

  it('фокус ушёл на вкладку комнаты — сессия панели прежняя (терминал s-02), а не null', () => {
    const roomTab: TabSpec = { kind: 'room', id: tabId.room('r-01'), roomId: 'r-01' };
    const layout = openTab(openTab(emptyLayout(), terminalTab('s-02')), roomTab);
    expect(focusedSessionOf(state(layout, [tabId.terminal('s-02'), roomTab.id]), key)).toBe('s-02');
  });

  it('вкладок сессий нет → null; раскладки нет → null', () => {
    const layout = openTab(openTab(emptyLayout(), { kind: 'mail', id: tabId.mail() }), fileTab);
    expect(focusedSessionOf(state(layout, [tabId.mail(), fileTab.id, null]), key)).toBeNull();
    expect(focusedSessionOf({ layouts: {}, entries: () => [] }, key)).toBeNull();
  });
});
