import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, openTab } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import type { SidebarSection } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { workAttention, type WorkAttention } from './derive.js';
import { nextAttentionTarget, openNextAttention } from './next.js';

const keyOf = (entry: WorkEntry): string => workKey(entry.projectPath, entry.map.work.id);
const refOf = (entry: WorkEntry, sessionId: string): SessionRef => ({
  projectPath: entry.projectPath,
  workId: entry.map.work.id,
  sessionId,
});

function section(key: string, works: WorkEntry[], collapsed = false): SidebarSection {
  return { kind: 'project', key, title: key, projectPath: key, works, collapsed };
}

function byWorkOf(entries: WorkEntry[], activity: Record<string, ActivityEntry>): Record<string, WorkAttention> {
  return Object.fromEntries(entries.map((entry) => [keyOf(entry), workAttention(entry, activity)]));
}

const sessions = (...ids: string[]): WorkSession[] => ids.map((id) => makeSession(id, id));

describe('nextAttentionTarget (тест 5)', () => {
  const w1 = makeWork('w-01', { projectPath: '/tmp/a', sessions: sessions('s-01', 's-02') });
  const w2 = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01') });

  it('сначала needs-you по порядку сайдбара, по кругу после current', () => {
    const activity = activityMap([
      makeActivity(refOf(w1, 's-01'), 'unseen'),
      makeActivity(refOf(w1, 's-02'), 'blocked'),
      makeActivity(refOf(w2, 's-01'), 'blocked'),
    ]);
    const sections = [section('/tmp/a', [w1]), section('/tmp/b', [w2])];
    const byWork = byWorkOf([w1, w2], activity);
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(refOf(w1, 's-02'));
    expect(nextAttentionTarget(sections, byWork, activity, refOf(w1, 's-02'))).toEqual(refOf(w2, 's-01'));
    // По кругу: после последней — снова первая.
    expect(nextAttentionTarget(sections, byWork, activity, refOf(w2, 's-01'))).toEqual(refOf(w1, 's-02'));
    // current не из списка needs-you — ближайшая после него.
    expect(nextAttentionTarget(sections, byWork, activity, refOf(w1, 's-01'))).toEqual(refOf(w1, 's-02'));
  });

  it('нет needs-you — первая unseen; нет обеих — null', () => {
    const activity = activityMap([makeActivity(refOf(w1, 's-02'), 'working'), makeActivity(refOf(w2, 's-01'), 'unseen')]);
    const sections = [section('/tmp/a', [w1]), section('/tmp/b', [w2])];
    expect(nextAttentionTarget(sections, byWorkOf([w1, w2], activity), activity, null)).toEqual(refOf(w2, 's-01'));

    const calm = activityMap([makeActivity(refOf(w1, 's-01'), 'working')]);
    expect(nextAttentionTarget(sections, byWorkOf([w1, w2], calm), calm, null)).toBeNull();
  });

  it('сессия свёрнутого проекта находится, скрытой done — нет, архивной в секциях — нет', () => {
    const folded = makeWork('w-03', { projectPath: '/tmp/c', sessions: sessions('s-01') });
    const hiddenDone = makeWork('w-04', { projectPath: '/tmp/a', status: 'done', sessions: sessions('s-01') });
    const archived = makeWork('w-05', { projectPath: '/tmp/a', status: 'archived', sessions: sessions('s-01') });
    const activity = activityMap([
      makeActivity(refOf(archived, 's-01'), 'blocked'),
      makeActivity(refOf(hiddenDone, 's-01'), 'blocked'),
      makeActivity(refOf(folded, 's-01'), 'blocked'),
    ]);
    // Скрытой done в секциях нет; архивная лежит (как при показе архивных 6.3) — выше свёрнутой.
    const sections = [section('/tmp/a', [archived]), section('/tmp/c', [folded], true)];
    const byWork = byWorkOf([folded, hiddenDone, archived], activity);
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(refOf(folded, 's-01'));
    expect(nextAttentionTarget(sections, byWork, activity, refOf(folded, 's-01'))).toEqual(refOf(folded, 's-01'));
  });
});

describe('openNextAttention (тест 15)', () => {
  const w1 = makeWork('w-01', { projectPath: '/tmp/a', sessions: sessions('s-01') });
  const w2 = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01') });

  function setup(activity: Record<string, ActivityEntry>): void {
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    useActivityStore.setState({ byRef: activity });
    useSidebarSectionsStore.setState({
      sections: [section('/tmp/a', [w1]), section('/tmp/b', [w2])],
      attention: byWorkOf([w1, w2], activity),
      entries: [w1, w2],
    });
  }

  beforeEach(() => {
    const key1 = keyOf(w1);
    const layout = openTab(emptyLayout(), { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' });
    useLayoutStore.setState({
      activeWorkKey: key1,
      layouts: { [key1]: layout },
      hydrated: { [key1]: true },
      pending: {},
      history: EMPTY_HISTORY,
      mru: {},
      navigating: false,
    });
  });

  it('выбрана первая needs-you — переход ко второй; работа не гидрирована — вкладка из очереди после hydrate', () => {
    setup(activityMap([makeActivity(refOf(w1, 's-01'), 'blocked'), makeActivity(refOf(w2, 's-01'), 'blocked')]));
    expect(selectedSessionOf(useLayoutStore.getState(), [w1, w2])?.ref).toEqual(refOf(w1, 's-01'));

    expect(openNextAttention()).toEqual(refOf(w2, 's-01'));
    const key2 = keyOf(w2);
    expect(useLayoutStore.getState().activeWorkKey).toBe(key2);
    expect(useLayoutStore.getState().layouts[key2]).toBeUndefined();

    useLayoutStore.getState().hydrate(key2, null);
    const layout = useLayoutStore.getState().layouts[key2];
    expect(layout).toBeDefined();
    const active = groups(layout!).find((group) => group.id === layout!.activeGroupId);
    expect(active?.activeTabId).toBe(tabId.terminal('s-01'));
    expect(selectedSessionOf(useLayoutStore.getState(), [w1, w2])?.ref).toEqual(refOf(w2, 's-01'));
  });

  it('гидрированная работа — вкладка открыта сразу', () => {
    const key2 = keyOf(w2);
    useLayoutStore.setState((state) => ({ layouts: { ...state.layouts, [key2]: emptyLayout() }, hydrated: { ...state.hydrated, [key2]: true } }));
    setup(activityMap([makeActivity(refOf(w2, 's-01'), 'unseen')]));
    expect(openNextAttention()).toEqual(refOf(w2, 's-01'));
    expect(selectedSessionOf(useLayoutStore.getState(), [w1, w2])?.ref).toEqual(refOf(w2, 's-01'));
  });

  it('идти некуда — null, активная работа прежняя', () => {
    setup(activityMap([makeActivity(refOf(w2, 's-01'), 'working')]));
    expect(openNextAttention()).toBeNull();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf(w1));
  });
});
