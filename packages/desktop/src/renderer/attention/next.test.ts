import { beforeEach, describe, expect, it } from 'vitest';
import type { Proposal, Room, WorkEntry, WorkSession } from '@harnas/core';
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
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { workAttention, type WorkAttention } from './derive.js';
import { nextAttentionTarget, openNextAttention, type AttentionTarget } from './next.js';

const keyOf = (entry: WorkEntry): string => workKey(entry.projectPath, entry.map.work.id);
const refOf = (entry: WorkEntry, sessionId: string): SessionRef => ({
  projectPath: entry.projectPath,
  workId: entry.map.work.id,
  sessionId,
});
/** Цель-сессия и цель-комната в той форме, что отдаёт «следующая, где нужен ты» (как `FocusTarget` уведомлений). */
const session = (entry: WorkEntry, sessionId: string): AttentionTarget => ({ kind: 'session', ref: refOf(entry, sessionId) });
const roomOf = (entry: WorkEntry, roomId: string): AttentionTarget => ({
  kind: 'room',
  projectPath: entry.projectPath,
  workId: entry.map.work.id,
  roomId,
});

function section(key: string, works: WorkEntry[], collapsed = false): SidebarSection {
  return { kind: 'project', key, title: key, projectPath: key, works, collapsed };
}

function byWorkOf(entries: WorkEntry[], activity: Record<string, ActivityEntry>): Record<string, WorkAttention> {
  return Object.fromEntries(entries.map((entry) => [keyOf(entry), workAttention(entry, activity)]));
}

const sessions = (...ids: string[]): WorkSession[] => ids.map((id) => makeSession(id, id));
const proposal: Proposal = { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' };
const room = (id: string, members: string[], patch: Partial<Room> = {}): Room => ({ ...makeRoom(id, id), members, lead: members[0] ?? null, ...patch });

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
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(session(w1, 's-02'));
    expect(nextAttentionTarget(sections, byWork, activity, session(w1, 's-02'))).toEqual(session(w2, 's-01'));
    // Единый список blocked → unseen: после последней blocked — unseen (она не пропадает, пока blocked есть),
    // после неё по кругу — снова первая blocked.
    expect(nextAttentionTarget(sections, byWork, activity, session(w2, 's-01'))).toEqual(session(w1, 's-01'));
    expect(nextAttentionTarget(sections, byWork, activity, session(w1, 's-01'))).toEqual(session(w1, 's-02'));
  });

  it('нет needs-you — первая unseen; нет обеих — null', () => {
    const activity = activityMap([makeActivity(refOf(w1, 's-02'), 'working'), makeActivity(refOf(w2, 's-01'), 'unseen')]);
    const sections = [section('/tmp/a', [w1]), section('/tmp/b', [w2])];
    expect(nextAttentionTarget(sections, byWorkOf([w1, w2], activity), activity, null)).toEqual(session(w2, 's-01'));

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
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(session(folded, 's-01'));
    expect(nextAttentionTarget(sections, byWork, activity, session(folded, 's-01'))).toEqual(session(folded, 's-01'));
  });
});

// Спека окна 2026-09-29, 2.7: сначала сессии `blocked`, потом комнаты с ждущим решением, потом `unseen` — в порядке
// сайдбара, по кругу от текущей вкладки (сессия или комната).
describe('nextAttentionTarget — комнаты с решением (2.7, кусок 5)', () => {
  // Сессии s-01…s-04; комната r-01 {s-02, s-03} стоит на месте s-02: порядок карточки — s-01, r-01, s-02, s-03, s-04.
  const withRoom = (id: string, projectPath: string, patch: Partial<Room> = {}): WorkEntry =>
    makeWork(id, { projectPath, sessions: sessions('s-01', 's-02', 's-03', 's-04'), rooms: [room('r-01', ['s-02', 's-03'], patch)] });
  const sectionsOf = (...works: WorkEntry[]): SidebarSection[] => works.map((entry) => section(entry.projectPath, [entry]));

  it('порядок ярусов: blocked бьёт комнату с решением, комната — unseen, даже когда они раньше в порядке сайдбара', () => {
    const decision = withRoom('w-01', '/tmp/a', { proposal });
    const blocked = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01') });
    const unseen = makeWork('w-00', { projectPath: '/tmp/0', sessions: sessions('s-01') });
    const activity = activityMap([makeActivity(refOf(blocked, 's-01'), 'blocked'), makeActivity(refOf(unseen, 's-01'), 'unseen')]);
    const all = [unseen, decision, blocked];
    const sections = sectionsOf(...all);
    const byWork = byWorkOf(all, activity);
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(session(blocked, 's-01'));
    // Без blocked — комната с решением, а не unseen из работы выше по списку.
    const noBlocked = activityMap([makeActivity(refOf(unseen, 's-01'), 'unseen')]);
    expect(nextAttentionTarget(sections, byWorkOf(all, noBlocked), noBlocked, null)).toEqual(roomOf(decision, 'r-01'));
    // Без решений и blocked — unseen.
    const onlyUnseen = withRoom('w-01', '/tmp/a');
    expect(nextAttentionTarget(sectionsOf(unseen, onlyUnseen), byWorkOf([unseen, onlyUnseen], noBlocked), noBlocked, null)).toEqual(session(unseen, 's-01'));
  });

  it('комнаты с решением — по порядку сайдбара и по кругу от текущей вкладки: комната, сессия комнаты или любая другая сессия', () => {
    const first = withRoom('w-01', '/tmp/a', { proposal });
    const second = withRoom('w-02', '/tmp/b', { proposal });
    const sections = sectionsOf(first, second);
    const byWork = byWorkOf([first, second], {});
    expect(nextAttentionTarget(sections, byWork, {}, null)).toEqual(roomOf(first, 'r-01'));
    expect(nextAttentionTarget(sections, byWork, {}, roomOf(first, 'r-01'))).toEqual(roomOf(second, 'r-01'));
    expect(nextAttentionTarget(sections, byWork, {}, roomOf(second, 'r-01'))).toEqual(roomOf(first, 'r-01'));
    // Терминал участника комнаты стоит в порядке после самой строки комнаты — следующая вторая комната; до строки — она сама.
    expect(nextAttentionTarget(sections, byWork, {}, session(first, 's-03'))).toEqual(roomOf(second, 'r-01'));
    expect(nextAttentionTarget(sections, byWork, {}, session(first, 's-01'))).toEqual(roomOf(first, 'r-01'));
    expect(nextAttentionTarget(sections, byWork, {}, session(second, 's-04'))).toEqual(roomOf(first, 'r-01'));
  });

  it('позиция участника комнаты — там, где стоит строка комнаты, а не по номеру сессии: s-04 после комнаты, s-01 до неё', () => {
    const one = withRoom('w-01', '/tmp/a', { proposal });
    const other = withRoom('w-02', '/tmp/b', { proposal });
    const sections = sectionsOf(one, other);
    const byWork = byWorkOf([one, other], {});
    // Порядок первой работы: s-01, r-01, s-02, s-03, s-04. Текущая — s-02 (внутри комнаты), значит следующая комната — во второй работе.
    expect(nextAttentionTarget(sections, byWork, {}, session(one, 's-02'))).toEqual(roomOf(other, 'r-01'));
  });

  it('комната старой карты без proposal и комната с proposal: null не цели', () => {
    const quiet = withRoom('w-01', '/tmp/a');
    const old = makeWork('w-02', {
      projectPath: '/tmp/b',
      sessions: sessions('s-01'),
      rooms: [{ id: 'r-01', title: 'Старая', creator: 'human', members: ['s-01'], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room],
    });
    expect(nextAttentionTarget(sectionsOf(quiet, old), byWorkOf([quiet, old], {}), {}, null)).toBeNull();
  });

  it('свёрнутый проект входит, скрытая done — нет (её нет в секциях), архивная в секциях — нет', () => {
    const folded = withRoom('w-01', '/tmp/a', { proposal });
    const archived = makeWork('w-02', { projectPath: '/tmp/b', status: 'archived', sessions: sessions('s-01'), rooms: [room('r-01', ['s-01'], { proposal })] });
    const sections = [section('/tmp/b', [archived]), section('/tmp/a', [folded], true)];
    const byWork = byWorkOf([folded, archived], {});
    expect(nextAttentionTarget(sections, byWork, {}, null)).toEqual(roomOf(folded, 'r-01'));
    expect(nextAttentionTarget([section('/tmp/b', [archived])], byWork, {}, null)).toBeNull();
  });

  // Цели сходятся в один список — blocked, комнаты с решением, unseen — и «следующая» берёт элемент после текущей
  // вкладки по кругу (`nextAttention()` прототипа handoff): ярус не выбирается по наличию целей, иначе пока в
  // работах есть хоть одна blocked-сессия, до комнаты с решением клик по счётчику не доходил бы никогда.
  it('решение и blocked-сессия одной работы (сцена dark-04): blocked → комната → снова blocked, счётчик «2 need you» проходит обе цели', () => {
    const entry = withRoom('w-01', '/tmp/a', { proposal });
    const activity = activityMap([makeActivity(refOf(entry, 's-04'), 'blocked')]);
    const sections = sectionsOf(entry);
    const byWork = byWorkOf([entry], activity);
    expect(byWork[keyOf(entry)]?.needsYou).toBe(2);
    expect(nextAttentionTarget(sections, byWork, activity, null)).toEqual(session(entry, 's-04'));
    expect(nextAttentionTarget(sections, byWork, activity, session(entry, 's-04'))).toEqual(roomOf(entry, 'r-01'));
    expect(nextAttentionTarget(sections, byWork, activity, roomOf(entry, 'r-01'))).toEqual(session(entry, 's-04'));
  });

  it('три яруса по кругу: blocked → комната с решением → unseen → снова blocked', () => {
    // Порядок карточки: s-01, r-01 {s-02, s-03}, s-02, s-03, s-04. Цели: s-04 (blocked), r-01 (решение), s-01 (unseen).
    const entry = withRoom('w-01', '/tmp/a', { proposal });
    const activity = activityMap([makeActivity(refOf(entry, 's-04'), 'blocked'), makeActivity(refOf(entry, 's-01'), 'unseen')]);
    const sections = sectionsOf(entry);
    const byWork = byWorkOf([entry], activity);
    const next = (current: AttentionTarget | null): AttentionTarget | null => nextAttentionTarget(sections, byWork, activity, current);
    expect(next(null)).toEqual(session(entry, 's-04'));
    expect(next(session(entry, 's-04'))).toEqual(roomOf(entry, 'r-01'));
    expect(next(roomOf(entry, 'r-01'))).toEqual(session(entry, 's-01'));
    expect(next(session(entry, 's-01'))).toEqual(session(entry, 's-04'));
  });

  it('несколько работ: круг проходит все blocked, потом все комнаты с решением, потом unseen — и возвращается к первой blocked', () => {
    const a = withRoom('w-01', '/tmp/a', { proposal });
    const b = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01', 's-02') });
    const c = withRoom('w-03', '/tmp/c', { proposal });
    const activity = activityMap([
      makeActivity(refOf(a, 's-04'), 'blocked'),
      makeActivity(refOf(b, 's-02'), 'blocked'),
      makeActivity(refOf(c, 's-01'), 'unseen'),
    ]);
    const sections = sectionsOf(a, b, c);
    const byWork = byWorkOf([a, b, c], activity);
    const visited: AttentionTarget[] = [];
    let current: AttentionTarget | null = null;
    for (let step = 0; step < 6; step += 1) {
      current = nextAttentionTarget(sections, byWork, activity, current);
      if (current !== null) visited.push(current);
    }
    expect(visited).toEqual([
      session(a, 's-04'),
      session(b, 's-02'),
      roomOf(a, 'r-01'),
      roomOf(c, 'r-01'),
      session(c, 's-01'),
      // Круг замкнулся.
      session(a, 's-04'),
    ]);
  });

  it('текущая вкладка — не цель: ближайшая после неё по порядку сайдбара в первом непустом ярусе (blocked, даже если комната ближе)', () => {
    const entry = withRoom('w-01', '/tmp/a', { proposal });
    const activity = activityMap([makeActivity(refOf(entry, 's-04'), 'blocked')]);
    const sections = sectionsOf(entry);
    const byWork = byWorkOf([entry], activity);
    // s-01 стоит выше строки комнаты и s-04, s-02 — внутри комнаты; ни одна не цель: первым идёт ярус blocked.
    expect(nextAttentionTarget(sections, byWork, activity, session(entry, 's-01'))).toEqual(session(entry, 's-04'));
    expect(nextAttentionTarget(sections, byWork, activity, session(entry, 's-02'))).toEqual(session(entry, 's-04'));
    // Ярус blocked пуст — ярус комнат: после текущей по порядку, по кругу внутри яруса.
    const calm = byWorkOf([entry], {});
    expect(nextAttentionTarget(sections, calm, {}, session(entry, 's-04'))).toEqual(roomOf(entry, 'r-01'));
  });
});

describe('openNextAttention (тест 15)', () => {
  const w1 = makeWork('w-01', { projectPath: '/tmp/a', sessions: sessions('s-01') });
  const w2 = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01') });

  function setup(activity: Record<string, ActivityEntry>, entries: WorkEntry[] = [w1, w2]): void {
    useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
    useActivityStore.setState({ byRef: activity });
    useSidebarSectionsStore.setState({
      sections: entries.map((entry) => section(entry.projectPath, [entry])),
      attention: byWorkOf(entries, activity),
      entries,
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

    expect(openNextAttention()).toEqual(session(w2, 's-01'));
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
    expect(openNextAttention()).toEqual(session(w2, 's-01'));
    expect(selectedSessionOf(useLayoutStore.getState(), [w1, w2])?.ref).toEqual(refOf(w2, 's-01'));
  });

  it('идти некуда — null, активная работа прежняя', () => {
    setup(activityMap([makeActivity(refOf(w2, 's-01'), 'working')]));
    expect(openNextAttention()).toBeNull();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf(w1));
  });

  describe('комната с решением — цель (кусок 5)', () => {
    const decision = makeWork('w-02', { projectPath: '/tmp/b', sessions: sessions('s-01', 's-02'), rooms: [room('r-01', ['s-01', 's-02'], { proposal })] });
    const activeTab = (key: string): string | null => {
      const layout = useLayoutStore.getState().layouts[key];
      return layout === undefined ? null : (groups(layout).find((group) => group.id === layout.activeGroupId)?.activeTabId ?? null);
    };

    it('открывает вкладку комнаты в её работе и делает работу активной; возвращает цель-комнату', () => {
      const key2 = keyOf(decision);
      setup({}, [w1, decision]);
      useLayoutStore.setState((state) => ({ layouts: { ...state.layouts, [key2]: emptyLayout() }, hydrated: { ...state.hydrated, [key2]: true } }));
      expect(openNextAttention()).toEqual(roomOf(decision, 'r-01'));
      expect(useLayoutStore.getState().activeWorkKey).toBe(key2);
      expect(activeTab(key2)).toBe(tabId.room('r-01'));
    });

    it('работа не гидрирована — вкладка комнаты из очереди после hydrate', () => {
      setup({}, [w1, decision]);
      expect(openNextAttention()).toEqual(roomOf(decision, 'r-01'));
      const key2 = keyOf(decision);
      expect(useLayoutStore.getState().layouts[key2]).toBeUndefined();
      useLayoutStore.getState().hydrate(key2, null);
      expect(activeTab(key2)).toBe(tabId.room('r-01'));
    });

    it('текущая вкладка — комната: следующая после неё по кругу; единственная комната — она же', () => {
      const other = makeWork('w-03', { projectPath: '/tmp/c', sessions: sessions('s-01'), rooms: [room('r-01', ['s-01'], { proposal })] });
      const key2 = keyOf(decision);
      setup({}, [w1, decision, other]);
      const layout2 = openTab(emptyLayout(), { kind: 'room', id: tabId.room('r-01'), roomId: 'r-01' });
      useLayoutStore.setState((state) => ({
        activeWorkKey: key2,
        layouts: { ...state.layouts, [key2]: layout2, [keyOf(other)]: emptyLayout() },
        hydrated: { ...state.hydrated, [key2]: true, [keyOf(other)]: true },
      }));
      expect(openNextAttention()).toEqual(roomOf(other, 'r-01'));
      expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf(other));
      // Теперь активна комната третьей работы — следующая по кругу снова вторая.
      expect(openNextAttention()).toEqual(roomOf(decision, 'r-01'));
      expect(useLayoutStore.getState().activeWorkKey).toBe(key2);
    });

    it('выбрана blocked-сессия, а комната с решением есть: следующая — комната, а не снова та же сессия (ярусы идут по кругу)', () => {
      setup(activityMap([makeActivity(refOf(w1, 's-01'), 'blocked')]), [w1, decision]);
      // Выбрана blocked-сессия w1/s-01 (единственная в ярусе blocked): после неё в едином списке — комната с решением.
      expect(selectedSessionOf(useLayoutStore.getState(), [w1, decision])?.ref).toEqual(refOf(w1, 's-01'));
      expect(openNextAttention()).toEqual(roomOf(decision, 'r-01'));
    });

    it('blocked-сессия и комната с решением в одной работе: два клика по счётчику доходят до комнаты, третий возвращает к blocked', () => {
      const both = makeWork('w-02', {
        projectPath: '/tmp/b',
        sessions: sessions('s-01', 's-02', 's-03'),
        rooms: [room('r-01', ['s-01', 's-02'], { proposal })],
      });
      const key2 = keyOf(both);
      setup(activityMap([makeActivity(refOf(both, 's-03'), 'blocked')]), [w1, both]);
      useLayoutStore.setState((state) => ({ layouts: { ...state.layouts, [key2]: emptyLayout() }, hydrated: { ...state.hydrated, [key2]: true } }));
      // Активна работа w1 с терминалом s-01: он не цель — первым идёт ярус blocked.
      expect(openNextAttention()).toEqual(session(both, 's-03'));
      expect(activeTab(key2)).toBe(tabId.terminal('s-03'));
      expect(openNextAttention()).toEqual(roomOf(both, 'r-01'));
      expect(activeTab(key2)).toBe(tabId.room('r-01'));
      expect(openNextAttention()).toEqual(session(both, 's-03'));
      expect(activeTab(key2)).toBe(tabId.terminal('s-03'));
    });
  });
});
