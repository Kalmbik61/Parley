import { describe, expect, it } from 'vitest';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import type { GroupNode, LayoutNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId } from './ids.js';
import {
  LIMITS,
  closeTab,
  emptyLayout,
  findTab,
  focusGroup,
  focusTab,
  groups,
  moveTab,
  openTab,
  openTerminalSessionIds,
  parseWorkLayout,
  pruneLayout,
  reopenClosed,
  setRatio,
  splitGroup,
  updateTab,
  validateLayout,
  type Edge,
  type GroupSizes,
} from './tree.js';

let tabCounter = 0;
/** Свежий терминальный таб с гарантированно новым id (счётчик один на файл — уникальности достаточно). */
function freshTab(): TabSpec {
  tabCounter += 1;
  const sessionId = `s-${tabCounter}`;
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

function browserTab(url: string): TabSpec {
  tabCounter += 1;
  return { kind: 'browser', id: tabId.browser(() => (tabCounter % 16) / 16), url };
}

function soleGroup(layout: WorkLayout): GroupNode {
  const [group, ...rest] = groups(layout);
  if (group === undefined || rest.length > 0) throw new Error('ожидалась ровно одна группа');
  return group;
}

function groupById(layout: WorkLayout, id: string): GroupNode {
  const found = groups(layout).find((g) => g.id === id);
  if (found === undefined) throw new Error(`группа не найдена: ${id}`);
  return found;
}

/** Строит раскладку с `n` группами: одна вкладка на группу, цепочкой `splitGroup`. */
function buildGroups(n: number): { layout: WorkLayout; groupIds: string[] } {
  let layout = openTab(emptyLayout(), freshTab(), 'active');
  const groupIds = [layout.activeGroupId];
  for (let i = 1; i < n; i += 1) {
    const result = splitGroup(layout, layout.activeGroupId, i % 2 === 0 ? 'column' : 'row', freshTab());
    if (result.error !== null) throw new Error(`splitGroup неожиданно отказал: ${result.error}`);
    layout = result.layout;
    groupIds.push(layout.activeGroupId);
  }
  return { layout, groupIds };
}

/**
 * Раунд исправлений 1, Critical B: три раскладки с дублирующимся id УЗЛА (группы или
 * сплита) вместо вкладки — их нельзя получить через публичный API (`nodeId` берёт
 * случайные 6 hex), но `parseWorkLayout` читает `layouts.json` с диска, куда раскладка
 * может попасть повреждённой в обход API. `twoSiblingGroups` — дубль id прямо у двух
 * групп; `groupInsideAncestorSplit` — самый показательный: id группы совпадает с id
 * сплита-предка, из-за чего `replaceNode` (ищет по id без учёта `type`) находит предка
 * раньше настоящей цели и стирает всё поддерево; `twoSplitsInDifferentBranches` — тот
 * же класс дефекта у двух сплитов.
 */
function duplicateNodeIdLayouts(): {
  twoSiblingGroups: WorkLayout;
  groupInsideAncestorSplit: WorkLayout;
  twoSplitsInDifferentBranches: WorkLayout;
} {
  const tabA = freshTab();
  const tabB = freshTab();
  const groupA: GroupNode = { type: 'group', id: 'g-DUP', tabs: [tabA], activeTabId: tabA.id };
  const groupB: GroupNode = { type: 'group', id: 'g-DUP', tabs: [tabB], activeTabId: tabB.id };
  const twoSiblingGroups: WorkLayout = {
    root: { type: 'split', id: 's-x', direction: 'row', ratio: 0.5, children: [groupA, groupB] },
    activeGroupId: 'g-DUP',
    closedTabs: [],
  };

  const tabC = freshTab();
  const tabD = freshTab();
  const tabE = freshTab();
  const groupC: GroupNode = { type: 'group', id: 'DUP', tabs: [tabC], activeTabId: tabC.id };
  const groupD: GroupNode = { type: 'group', id: 'g-d', tabs: [tabD], activeTabId: tabD.id };
  const groupE: GroupNode = { type: 'group', id: 'g-e', tabs: [tabE], activeTabId: tabE.id };
  const innerSplit: LayoutNode = {
    type: 'split',
    id: 's-inner',
    direction: 'row',
    ratio: 0.5,
    children: [groupC, groupD],
  };
  const groupInsideAncestorSplit: WorkLayout = {
    root: { type: 'split', id: 'DUP', direction: 'column', ratio: 0.5, children: [innerSplit, groupE] },
    activeGroupId: 'DUP',
    closedTabs: [],
  };

  const t1 = freshTab();
  const t2 = freshTab();
  const t3 = freshTab();
  const t4 = freshTab();
  const groupF: GroupNode = { type: 'group', id: 'g-f', tabs: [t1], activeTabId: t1.id };
  const groupG: GroupNode = { type: 'group', id: 'g-g', tabs: [t2], activeTabId: t2.id };
  const groupH: GroupNode = { type: 'group', id: 'g-h', tabs: [t3], activeTabId: t3.id };
  const groupI: GroupNode = { type: 'group', id: 'g-i', tabs: [t4], activeTabId: t4.id };
  const splitLeft: LayoutNode = {
    type: 'split',
    id: 's-SAME',
    direction: 'row',
    ratio: 0.5,
    children: [groupF, groupG],
  };
  const splitRight: LayoutNode = {
    type: 'split',
    id: 's-SAME',
    direction: 'row',
    ratio: 0.5,
    children: [groupH, groupI],
  };
  const twoSplitsInDifferentBranches: WorkLayout = {
    root: { type: 'split', id: 's-root', direction: 'column', ratio: 0.5, children: [splitLeft, splitRight] },
    activeGroupId: 'g-f',
    closedTabs: [],
  };

  return { twoSiblingGroups, groupInsideAncestorSplit, twoSplitsInDifferentBranches };
}

describe('openTab', () => {
  // Тест 6 куска 9.2b.
  it('{ focus: false }: вкладка на месте, activeTabId и activeGroupId прежние; в пустой группе — активная', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const g1 = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');
    const split = splitGroup(layout, g1, 'row', freshTab());
    layout = split.layout;
    const g2 = layout.activeGroupId;
    expect(g2).not.toBe(g1);

    const quiet = browserTab('http://localhost:5173/');
    const next = openTab(layout, quiet, { groupId: g1, index: 1 }, { focus: false });
    expect(groupById(next, g1).tabs.map((tab) => tab.id)).toEqual([t1.id, quiet.id, t2.id]);
    expect(groupById(next, g1).activeTabId).toBe(t2.id);
    expect(next.activeGroupId).toBe(g2);

    const empty = openTab(emptyLayout(), quiet, 'active', { focus: false });
    expect(soleGroup(empty).tabs.map((tab) => tab.id)).toEqual([quiet.id]);
    expect(soleGroup(empty).activeTabId).toBe(quiet.id);
  });

  it('{ focus: false } уже открытой вкладки — раскладка та же', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    const layout = openTab(openTab(emptyLayout(), t1, 'active'), t2, 'active');
    expect(openTab(layout, t1, 'active', { focus: false })).toBe(layout);
  });

  // Тест 1.
  it('уже открытой вкладки из другой группы: групп и вкладок столько же, фокус на ней', () => {
    const tab = freshTab();
    let layout = openTab(emptyLayout(), tab, 'active');
    const rootGroupId = layout.activeGroupId;
    const split = splitGroup(layout, rootGroupId, 'row', freshTab());
    expect(split.error).toBeNull();
    layout = split.layout;
    const otherGroupId = layout.activeGroupId; // новая группа сейчас активна.
    expect(otherGroupId).not.toBe(rootGroupId);

    const before = groups(layout);
    const totalTabsBefore = before.reduce((n, g) => n + g.tabs.length, 0);

    const refocused = openTab(layout, tab, { groupId: otherGroupId });

    expect(groups(refocused)).toHaveLength(before.length);
    const totalTabsAfter = groups(refocused).reduce((n, g) => n + g.tabs.length, 0);
    expect(totalTabsAfter).toBe(totalTabsBefore);
    expect(refocused.activeGroupId).toBe(rootGroupId);
    expect(groupById(refocused, rootGroupId).activeTabId).toBe(tab.id);
  });

  // Тест 2.
  it('в группу { groupId, index: 0 } ставит вкладку первой', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    const t3 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');

    layout = openTab(layout, t3, { groupId, index: 0 });

    expect(groupById(layout, groupId).tabs.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id]);
  });
});

describe('closeTab', () => {
  // Тест 3.
  it('последней вкладки некорневой группы: группа удалена, сплит заменён соседом; сосед-сплит → activeGroupId его первая группа', () => {
    const tabA = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;

    const splitAB = splitGroup(layout, groupA, 'row', freshTab());
    expect(splitAB.error).toBeNull();
    layout = splitAB.layout;
    const groupB = layout.activeGroupId;

    const splitBC = splitGroup(layout, groupB, 'column', freshTab());
    expect(splitBC.error).toBeNull();
    layout = splitBC.layout;
    const groupC = layout.activeGroupId;

    // groupA — лист верхнего сплита, его сосед — под-сплит {groupB, groupC}.
    layout = focusGroup(layout, groupA);
    expect(layout.activeGroupId).toBe(groupA);

    layout = closeTab(layout, tabA.id);

    const remaining = groups(layout);
    expect(remaining.map((g) => g.id).sort()).toEqual([groupB, groupC].sort());
    expect(validateLayout(layout)).toEqual([]);
    // Первая группа поддерева-соседа в визуальном порядке — groupB (создан раньше groupC внутри под-сплита).
    expect(layout.activeGroupId).toBe(groupB);
  });

  // Тест 4.
  it('последней вкладки корня: корень — пустая группа, activeTabId: null', () => {
    const tab = freshTab();
    let layout = openTab(emptyLayout(), tab, 'active');
    const rootId = layout.activeGroupId;

    layout = closeTab(layout, tab.id);

    expect(groups(layout)).toHaveLength(1);
    const root = soleGroup(layout);
    expect(root.id).toBe(rootId);
    expect(root.tabs).toEqual([]);
    expect(root.activeTabId).toBeNull();
    expect(layout.activeGroupId).toBe(rootId);
    expect(layout.closedTabs.map((t) => t.id)).toEqual([tab.id]);
  });

  // Тест 5.
  it('closedTabs: 12 закрытий подряд оставляют 10 последних; повторное закрытие той же вкладки не дублирует её', () => {
    const tabs = Array.from({ length: 13 }, () => freshTab());
    let layout = emptyLayout();
    for (const tab of tabs) layout = openTab(layout, tab, 'active');

    for (let i = 0; i < 12; i += 1) layout = closeTab(layout, tabs[i]!.id);

    expect(layout.closedTabs).toHaveLength(10);
    // Последние 10 закрытых, самое недавнее — первым: t12..t3 (t1,t2 вытеснены).
    expect(layout.closedTabs.map((t) => t.id)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((i) => tabs[i]!.id),
    );

    // Открыть заново последний закрытый (t12, индекс 11) и закрыть его снова — без дубля.
    layout = openTab(layout, tabs[11]!, 'active');
    layout = closeTab(layout, tabs[11]!.id);
    const occurrences = layout.closedTabs.filter((t) => t.id === tabs[11]!.id);
    expect(occurrences).toHaveLength(1);
    expect(layout.closedTabs[0]!.id).toBe(tabs[11]!.id);
    expect(layout.closedTabs.length).toBeLessThanOrEqual(LIMITS.closedTabs);
  });
});

describe('moveTab', () => {
  // Тест 6, часть А.
  it('внутри строки меняет порядок', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    const t3 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');
    layout = openTab(layout, t3, 'active');

    const result = moveTab(layout, t1.id, { groupId, index: 2 });

    expect(result.error).toBeNull();
    expect(groupById(result.layout, groupId).tabs.map((t) => t.id)).toEqual([t2.id, t3.id, t1.id]);
    expect(groupById(result.layout, groupId).activeTabId).toBe(t1.id);
    expect(result.layout.activeGroupId).toBe(groupId);
  });

  // Тест 6, часть Б.
  it('в другую группу переносит вкладку, пустая исходная удаляется', () => {
    const tabA = freshTab();
    const tabB = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', tabB);
    expect(split.error).toBeNull();
    layout = split.layout;
    const groupB = layout.activeGroupId;

    const result = moveTab(layout, tabA.id, { groupId: groupB, index: 0 });

    expect(result.error).toBeNull();
    expect(groups(result.layout)).toHaveLength(1);
    const only = soleGroup(result.layout);
    expect(only.id).toBe(groupB);
    expect(only.tabs.map((t) => t.id)).toEqual([tabA.id, tabB.id]);
    expect(only.activeTabId).toBe(tabA.id);
    expect(result.layout.activeGroupId).toBe(groupB);
    expect(validateLayout(result.layout)).toEqual([]);
  });

  // Тест 7.
  it.each([
    ['left', 'row', true] as const,
    ['right', 'row', false] as const,
    ['top', 'column', true] as const,
    ['bottom', 'column', false] as const,
  ])('к краю %s даёт direction=%s и новую группу %s ребёнком', (edge, direction, newFirst) => {
    const t1 = freshTab();
    const t2 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');

    const result = moveTab(layout, t2.id, { groupId, edge: edge as Edge });

    expect(result.error).toBeNull();
    const root = result.layout.root;
    if (root.type !== 'split') throw new Error('ожидался сплит');
    expect(root.direction).toBe(direction);
    const [a, b] = root.children;
    const newGroupNode = newFirst ? a : b;
    const oldGroupNode = newFirst ? b : a;
    if (newGroupNode.type !== 'group' || oldGroupNode.type !== 'group') throw new Error('ожидались группы');
    expect(newGroupNode.tabs.map((t) => t.id)).toEqual([t2.id]);
    expect(oldGroupNode.tabs.map((t) => t.id)).toEqual([t1.id]);
    expect(result.layout.activeGroupId).toBe(newGroupNode.id);
    expect(validateLayout(result.layout)).toEqual([]);
  });

  // Перенос единственной вкладки к краю своей же группы ничего не меняет.
  it('единственной вкладки к краю своей же группы ничего не меняет', () => {
    const tab = freshTab();
    const layout = openTab(emptyLayout(), tab, 'active');
    const groupId = layout.activeGroupId;

    const result = moveTab(layout, tab.id, { groupId, edge: 'right' });

    expect(result.error).toBeNull();
    expect(result.layout).toBe(layout);
  });

  // Тест 17.
  it('при 8 группах перенос единственной вкладки группы к краю другой разрешён, второй вкладки — нет', () => {
    const { layout: base, groupIds } = buildGroups(8);
    const [group1, group2] = groupIds;
    if (group1 === undefined || group2 === undefined) throw new Error('нужно хотя бы 2 группы');
    // group2 получает вторую вкладку — теперь при переносе одной из них исходная группа не опустеет.
    const extra = freshTab();
    const layout = openTab(base, extra, { groupId: group2 });
    expect(groups(layout)).toHaveLength(8);

    const singleTabGroup = groupById(layout, group1);
    expect(singleTabGroup.tabs).toHaveLength(1);
    const soleTabId = singleTabGroup.tabs[0]!.id;
    const targetId = groupIds.find((id) => id !== group1 && id !== group2);
    if (targetId === undefined) throw new Error('нужна третья группа как цель');

    const allowed = moveTab(layout, soleTabId, { groupId: targetId, edge: 'right' });
    expect(allowed.error).toBeNull();
    expect(groups(allowed.layout)).toHaveLength(8);
    expect(validateLayout(allowed.layout)).toEqual([]);

    const rejected = moveTab(layout, extra.id, { groupId: targetId, edge: 'right' });
    expect(rejected.error).toBe('too-many-groups');
    expect(rejected.layout).toBe(layout);
  });

  it('not-found для несуществующей вкладки или группы', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const missingTab = moveTab(layout, 'нет-такой', { groupId: layout.activeGroupId, index: 0 });
    expect(missingTab.error).toBe('not-found');
    expect(missingTab.layout).toBe(layout);

    const tab = soleGroup(layout).tabs[0]!;
    const missingGroup = moveTab(layout, tab.id, { groupId: 'нет-такой', index: 0 });
    expect(missingGroup.error).toBe('not-found');
    expect(missingGroup.layout).toBe(layout);
  });
});

describe('splitGroup', () => {
  // Тест 8.
  it('девятая группа → too-many-groups, раскладка — та же ссылка', () => {
    const { layout } = buildGroups(8);
    const result = splitGroup(layout, layout.activeGroupId, 'row', freshTab());
    expect(result.error).toBe('too-many-groups');
    expect(result.layout).toBe(layout);
  });

  // Тест 9.
  it('при ширине группы 400px (row) → too-small, при 600px — сплит', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const sizesSmall: GroupSizes = { [groupId]: { width: 400, height: 999 } };
    const tooSmall = splitGroup(layout, groupId, 'row', freshTab(), sizesSmall);
    expect(tooSmall.error).toBe('too-small');
    expect(tooSmall.layout).toBe(layout);

    const sizesOk: GroupSizes = { [groupId]: { width: 600, height: 999 } };
    const ok = splitGroup(layout, groupId, 'row', freshTab(), sizesOk);
    expect(ok.error).toBeNull();
    expect(groups(ok.layout)).toHaveLength(2);
  });

  // Тест 16.
  it('вкладкой, уже открытой в другой группе: вкладка одна на раскладку, стоит в новой группе; опустевшая исходная удалена', () => {
    const tabX = freshTab();
    let layout = openTab(emptyLayout(), tabX, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', freshTab());
    expect(split.error).toBeNull();
    layout = split.layout;
    const groupB = layout.activeGroupId;

    const result = splitGroup(layout, groupB, 'row', tabX);

    expect(result.error).toBeNull();
    const allTabIds = groups(result.layout).flatMap((g) => g.tabs.map((t) => t.id));
    expect(allTabIds.filter((id) => id === tabX.id)).toHaveLength(1);
    expect(groups(result.layout).some((g) => g.id === groupA)).toBe(false);
    expect(validateLayout(result.layout)).toEqual([]);
  });

  // Единственная вкладка самой groupId, уже открытая — раскладка без изменений.
  it('вкладкой, уже единственной в самой groupId — раскладка без изменений', () => {
    const tab = freshTab();
    const layout = openTab(emptyLayout(), tab, 'active');
    const result = splitGroup(layout, layout.activeGroupId, 'row', tab);
    expect(result.error).toBeNull();
    expect(result.layout).toBe(layout);
  });

  it('not-found для несуществующей группы', () => {
    const layout = emptyLayout();
    const result = splitGroup(layout, 'нет-такой', 'row', freshTab());
    expect(result.error).toBe('not-found');
    expect(result.layout).toBe(layout);
  });
});

describe('sizes нечисловые (раунд исправлений 1, Important B)', () => {
  // Неизвестный/неконечный размер целевой группы — как 0 у свёрнутого окна:
  // трактуется как «места нет», а не как «места достаточно».
  it('NaN в width (row) → too-small, раскладка та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const result = splitGroup(layout, groupId, 'row', freshTab(), { [groupId]: { width: NaN, height: 999 } });
    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });

  it('NaN в height (column) → too-small', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const result = splitGroup(layout, groupId, 'column', freshTab(), { [groupId]: { width: 999, height: NaN } });
    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });

  it('Infinity в width (row) → too-small', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const result = splitGroup(layout, groupId, 'row', freshTab(), { [groupId]: { width: Infinity, height: 999 } });
    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });

  it('-Infinity в width (row) → too-small', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const result = splitGroup(layout, groupId, 'row', freshTab(), { [groupId]: { width: -Infinity, height: 999 } });
    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });

  it('конечный нормальный размер по-прежнему проходит (контроль)', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupId = layout.activeGroupId;
    const result = splitGroup(layout, groupId, 'row', freshTab(), { [groupId]: { width: 600, height: 999 } });
    expect(result.error).toBeNull();
  });

  it('то же для moveTab с edge', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');

    const result = moveTab(layout, t2.id, { groupId, edge: 'right' }, { [groupId]: { width: NaN, height: 999 } });

    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });
});

describe('setRatio', () => {
  // Тест 10.
  it('приводит долю к 0.1–0.9, NaN и Infinity не меняют раскладку', () => {
    const tabA = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', freshTab());
    expect(split.error).toBeNull();
    layout = split.layout;
    const root = layout.root;
    if (root.type !== 'split') throw new Error('ожидался сплит');
    const splitId = root.id;

    const low = setRatio(layout, splitId, 0.05);
    const lowRoot = low.root;
    if (lowRoot.type !== 'split') throw new Error('ожидался сплит');
    expect(lowRoot.ratio).toBe(0.1);

    const high = setRatio(layout, splitId, 0.95);
    const highRoot = high.root;
    if (highRoot.type !== 'split') throw new Error('ожидался сплит');
    expect(highRoot.ratio).toBe(0.9);

    expect(setRatio(layout, splitId, NaN)).toBe(layout);
    expect(setRatio(layout, splitId, Infinity)).toBe(layout);
    expect(setRatio(layout, splitId, -Infinity)).toBe(layout);
  });

  it('неизвестный splitId — та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    expect(setRatio(layout, 'нет-такой', 0.5)).toBe(layout);
  });
});

describe('reopenClosed', () => {
  // Тест 11.
  it('возвращает последнюю закрытую в активную группу и снимает её со стека', () => {
    const t1 = freshTab();
    const t2 = freshTab();
    let layout = openTab(emptyLayout(), t1, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, t2, 'active');
    layout = closeTab(layout, t2.id);
    expect(layout.closedTabs.map((t) => t.id)).toEqual([t2.id]);

    layout = reopenClosed(layout);

    expect(layout.closedTabs).toEqual([]);
    expect(groupById(layout, groupId).tabs.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(groupById(layout, groupId).activeTabId).toBe(t2.id);
  });

  it('на пустом стеке — та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    expect(reopenClosed(layout)).toBe(layout);
  });
});

describe('pruneLayout', () => {
  // Тест 12.
  it('с «мёртвой» сессией: вкладка убрана, группа схлопнута', () => {
    const deadTab = freshTab();
    const aliveTab = freshTab();
    let layout = openTab(emptyLayout(), deadTab, 'active');
    const groupDead = layout.activeGroupId;
    const split = splitGroup(layout, groupDead, 'row', aliveTab);
    expect(split.error).toBeNull();
    layout = split.layout;

    const pruned = pruneLayout(layout, (tab) => tab.id !== deadTab.id);

    expect(groups(pruned)).toHaveLength(1);
    expect(soleGroup(pruned).tabs.map((t) => t.id)).toEqual([aliveTab.id]);
    expect(validateLayout(pruned)).toEqual([]);
  });

  it('пустой корень остаётся пустой группой', () => {
    const layout = emptyLayout();
    const pruned = pruneLayout(layout, () => false);
    expect(groups(pruned)).toHaveLength(1);
    expect(soleGroup(pruned).tabs).toEqual([]);
    expect(validateLayout(pruned)).toEqual([]);
  });

  // Раунд исправлений 1, Important A: no-op (все живы) — та же ссылка на раскладку
  // (от этого зависят подписки zustand в 2.2).
  it('no-op (все вкладки живы) — та же ссылка на раскладку', () => {
    const tabA = freshTab();
    const tabB = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', tabB);
    expect(split.error).toBeNull();
    layout = split.layout;

    const pruned = pruneLayout(layout, () => true);

    expect(pruned).toBe(layout);
  });

  // Раунд исправлений 1, Important B: pruneLayout чистит и closedTabs тем же alive —
  // reopenClosed не должен возвращать вкладку, которую alive() только что объявил мёртвой.
  it('чистит closedTabs тем же alive', () => {
    const tabA = freshTab();
    const tabB = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    layout = openTab(layout, tabB, 'active');
    layout = closeTab(layout, tabB.id);
    expect(layout.closedTabs.map((t) => t.id)).toEqual([tabB.id]);

    // alive объявляет мёртвыми обе — и открытую A, и уже закрытую B.
    const pruned = pruneLayout(layout, (tab) => tab.id !== tabA.id && tab.id !== tabB.id);

    expect(pruned.closedTabs).toEqual([]);
    // Пустой стек — reopenClosed не находит, что открывать, отдаёт ту же ссылку.
    expect(reopenClosed(pruned)).toBe(pruned);
  });

  it('closedTabs без изменений (все живы) — та же ссылка на массив', () => {
    const tabA = freshTab();
    const tabB = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    layout = openTab(layout, tabB, 'active');
    layout = closeTab(layout, tabB.id);

    const pruned = pruneLayout(layout, () => true);

    expect(pruned).toBe(layout);
    expect(pruned.closedTabs).toBe(layout.closedTabs);
  });
});

describe('focusGroup', () => {
  // Раунд исправлений 1, Minor A.
  it('несуществующий groupId — та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    expect(focusGroup(layout, 'нет-такой')).toBe(layout);
  });

  it('уже активная группа — та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    expect(focusGroup(layout, layout.activeGroupId)).toBe(layout);
  });

  it('переключает на существующую неактивную группу', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', freshTab());
    expect(split.error).toBeNull();
    const withB = split.layout; // activeGroupId сейчас — B (только что созданная).
    expect(withB.activeGroupId).not.toBe(groupA);

    const focused = focusGroup(withB, groupA);

    expect(focused.activeGroupId).toBe(groupA);
  });
});

describe('focusTab', () => {
  // Раунд исправлений 1, Important A.
  it('фокусирует вкладку в неактивной группе — group.activeTabId и layout.activeGroupId меняются', () => {
    const tabA = freshTab();
    const tabB = freshTab();
    let layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', tabB);
    expect(split.error).toBeNull();
    layout = split.layout; // activeGroupId сейчас — группа B.
    expect(layout.activeGroupId).not.toBe(groupA);

    const focused = focusTab(layout, tabA.id);

    expect(focused.activeGroupId).toBe(groupA);
    expect(groupById(focused, groupA).activeTabId).toBe(tabA.id);
  });

  it('несуществующий id — та же ссылка', () => {
    const layout = openTab(emptyLayout(), freshTab(), 'active');
    expect(focusTab(layout, 'нет-такой')).toBe(layout);
  });

  it('уже сфокусированная вкладка в уже активной группе — та же ссылка', () => {
    const tab = freshTab();
    const layout = openTab(emptyLayout(), tab, 'active');
    expect(focusTab(layout, tab.id)).toBe(layout);
  });
});

describe('updateTab', () => {
  // Тест 18.
  it('вкладки браузера меняет url, id/группа/индекс те же; неизвестный id и url у терминала — та же ссылка', () => {
    const before = freshTab();
    const target = browserTab('http://localhost:5173/old');
    const after = freshTab();
    let layout = openTab(emptyLayout(), before, 'active');
    const groupId = layout.activeGroupId;
    layout = openTab(layout, target, 'active');
    layout = openTab(layout, after, 'active');

    const updated = updateTab(layout, target.id, { url: 'http://localhost:5173/a' });

    const group = groupById(updated, groupId);
    expect(group.tabs.map((t) => t.id)).toEqual([before.id, target.id, after.id]);
    const updatedTab = group.tabs[1]!;
    if (updatedTab.kind !== 'browser') throw new Error('ожидалась вкладка браузера');
    expect(updatedTab.url).toBe('http://localhost:5173/a');
    expect(validateLayout(updated)).toEqual([]);

    expect(updateTab(layout, 'нет-такой', { url: 'x' })).toBe(layout);
    expect(updateTab(layout, before.id, { url: 'x' })).toBe(layout);
  });

  // План 2026-10-01, решение 6: вид вкладки сессии.
  it('вкладке терминала ставит view; view у браузера — та же ссылка', () => {
    const term = freshTab();
    const page = browserTab('http://localhost:5173/');
    let layout = openTab(emptyLayout(), term, 'active');
    layout = openTab(layout, page, 'active');

    const toTerminal = updateTab(layout, term.id, { view: 'terminal' });
    expect(groups(toTerminal)[0]?.tabs[0]).toEqual({ ...term, view: 'terminal' });
    expect(groups(updateTab(toTerminal, term.id, { view: 'chat' }))[0]?.tabs[0]).toEqual({ ...term, view: 'chat' });
    expect(validateLayout(toTerminal)).toEqual([]);
    expect(updateTab(layout, page.id, { view: 'chat' })).toBe(layout);
  });
});

describe('validateLayout — дубль id узла, не только вкладки (раунд исправлений 1, Critical B)', () => {
  it('двух групп-сиблингов', () => {
    const { twoSiblingGroups } = duplicateNodeIdLayouts();
    expect(validateLayout(twoSiblingGroups)).not.toEqual([]);
  });

  it('группы и сплита-предка (порча при replaceNode: предок находится раньше цели)', () => {
    const { groupInsideAncestorSplit } = duplicateNodeIdLayouts();
    expect(validateLayout(groupInsideAncestorSplit)).not.toEqual([]);
  });

  it('двух сплитов в разных ветках', () => {
    const { twoSplitsInDifferentBranches } = duplicateNodeIdLayouts();
    expect(validateLayout(twoSplitsInDifferentBranches)).not.toEqual([]);
  });
});

describe('parseWorkLayout', () => {
  function validLayout(): WorkLayout {
    const tabA = freshTab();
    const layout = openTab(emptyLayout(), tabA, 'active');
    const groupA = layout.activeGroupId;
    const split = splitGroup(layout, groupA, 'row', freshTab());
    if (split.error !== null) throw new Error('setup');
    return split.layout;
  }

  // Тест 13.
  it('отвергает неизвестный вид вкладки', () => {
    const layout = validLayout();
    const raw = JSON.parse(JSON.stringify(layout)) as { root: { children: [{ tabs: unknown[] }, unknown] } };
    raw.root.children[0].tabs[0] = { kind: 'unknown-kind', id: 'x' };
    expect(parseWorkLayout(raw)).toBeNull();
  });

  it('отвергает сплит с одним ребёнком', () => {
    const layout = validLayout();
    const raw = JSON.parse(JSON.stringify(layout)) as { root: { children?: unknown[] } };
    if (Array.isArray(raw.root.children)) raw.root.children = [raw.root.children[0]];
    expect(parseWorkLayout(raw)).toBeNull();
  });

  it("отвергает ratio: 'x'", () => {
    const layout = validLayout();
    const raw = JSON.parse(JSON.stringify(layout)) as { root: { ratio?: unknown } };
    raw.root.ratio = 'x';
    expect(parseWorkLayout(raw)).toBeNull();
  });

  it('отвергает дубль id вкладки при верной форме', () => {
    const layout = validLayout();
    const root = layout.root;
    if (root.type !== 'split') throw new Error('setup');
    const a = root.children[0];
    const b = root.children[1];
    if (a.type !== 'group' || b.type !== 'group') throw new Error('setup');
    const dupTab = a.tabs[0]!;
    const withDup: WorkLayout = {
      ...layout,
      root: { ...root, children: [a, { ...b, tabs: [dupTab], activeTabId: dupTab.id }] },
    };
    expect(parseWorkLayout(JSON.parse(JSON.stringify(withDup)))).toBeNull();
  });

  it('отвергает больше 8 групп', () => {
    // API не даёт создать девятую группу (проверено тестом 8) — 9 групп собираем
    // вручную, минуя операции, только для проверки самого `parseWorkLayout`.
    const { layout } = buildGroups(8);
    const root = layout.root;
    if (root.type !== 'split') throw new Error('setup');
    const a = root.children[0];
    if (a.type !== 'group') throw new Error('setup');
    const extraTab = freshTab();
    const extraGroup: GroupNode = { type: 'group', id: 'g-extra', tabs: [extraTab], activeTabId: extraTab.id };
    const wrapped: WorkLayout['root'] = {
      type: 'split',
      id: 's-extra',
      direction: 'row',
      ratio: 0.5,
      children: [a, extraGroup],
    };
    const nineGroups: WorkLayout = { ...layout, root: { ...root, children: [wrapped, root.children[1]] } };
    expect(groups(nineGroups)).toHaveLength(9);
    expect(parseWorkLayout(JSON.parse(JSON.stringify(nineGroups)))).toBeNull();
  });

  it('отвергает пустую некорневую группу', () => {
    const layout = validLayout();
    const root = layout.root;
    if (root.type !== 'split') throw new Error('setup');
    const a = root.children[0];
    if (a.type !== 'group') throw new Error('setup');
    const withEmpty: WorkLayout = { ...layout, root: { ...root, children: [{ ...a, tabs: [], activeTabId: null }, root.children[1]] } };
    expect(parseWorkLayout(JSON.parse(JSON.stringify(withEmpty)))).toBeNull();
  });

  it('отвергает activeTabId не из своей группы', () => {
    const layout = validLayout();
    const root = layout.root;
    if (root.type !== 'split') throw new Error('setup');
    const a = root.children[0];
    const b = root.children[1];
    if (a.type !== 'group' || b.type !== 'group') throw new Error('setup');
    const bogus: WorkLayout = { ...layout, root: { ...root, children: [{ ...a, activeTabId: b.tabs[0]!.id }, b] } };
    expect(parseWorkLayout(JSON.parse(JSON.stringify(bogus)))).toBeNull();
  });

  it('чинит битый activeGroupId вместо отказа', () => {
    const layout = validLayout();
    const raw = { ...layout, activeGroupId: 'нет-такой-группы' };
    const parsed = parseWorkLayout(JSON.parse(JSON.stringify(raw)));
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('unreachable');
    expect(groups(parsed).some((g) => g.id === parsed.activeGroupId)).toBe(true);
    expect(validateLayout(parsed)).toEqual([]);
  });

  it('принимает результат JSON.parse(JSON.stringify(layout))', () => {
    const layout = validLayout();
    const roundTripped = JSON.parse(JSON.stringify(layout));
    expect(parseWorkLayout(roundTripped)).toEqual(layout);
  });

  it('мусор на входе — null', () => {
    expect(parseWorkLayout(null)).toBeNull();
    expect(parseWorkLayout(42)).toBeNull();
    expect(parseWorkLayout({})).toBeNull();
    expect(parseWorkLayout({ root: {}, activeGroupId: 'x', closedTabs: [] })).toBeNull();
  });

  // Раунд исправлений 1, Critical B: то же самое, но через диск (JSON.parse/stringify),
  // как реально попадает в parseWorkLayout из layouts.json.
  it('отвергает дубль id узла с диска — двух групп-сиблингов', () => {
    const { twoSiblingGroups } = duplicateNodeIdLayouts();
    expect(parseWorkLayout(JSON.parse(JSON.stringify(twoSiblingGroups)))).toBeNull();
  });

  it('отвергает дубль id узла с диска — группы и сплита-предка', () => {
    const { groupInsideAncestorSplit } = duplicateNodeIdLayouts();
    expect(parseWorkLayout(JSON.parse(JSON.stringify(groupInsideAncestorSplit)))).toBeNull();
  });

  it('отвергает дубль id узла с диска — двух сплитов в разных ветках', () => {
    const { twoSplitsInDifferentBranches } = duplicateNodeIdLayouts();
    expect(parseWorkLayout(JSON.parse(JSON.stringify(twoSplitsInDifferentBranches)))).toBeNull();
  });

  // Раунд исправлений 1, Minor B: лишние поля узлов/вкладок/раскладки отсекаются —
  // 2.2 пишет результат `parseWorkLayout` обратно на диск, лишнее не должно путешествовать.
  it('отсекает лишние поля узлов, вкладок и раскладки верхнего уровня', () => {
    const layout = validLayout();
    const raw = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
    raw.extraTop = 'внешнее';
    const root = raw.root as Record<string, unknown>;
    root.extraNode = 'на узле';
    const children = root.children as Record<string, unknown>[];
    const firstGroup = children[0] as Record<string, unknown>;
    firstGroup.extraGroup = 'на группе';
    const tabs = firstGroup.tabs as Record<string, unknown>[];
    (tabs[0] as Record<string, unknown>).extraTab = 'на вкладке';

    expect(parseWorkLayout(raw)).toEqual(layout);
  });

  // План 2026-10-01, решение 6: view вкладки сессии переживает перезапуск; старая раскладка без поля — норма.
  it('view вкладки терминала переживает разбор; без поля — без поля; мусор — раскладка невалидна', () => {
    const tab = freshTab();
    const base = openTab(emptyLayout(), tab, 'active');
    const withView = updateTab(base, tab.id, { view: 'terminal' });
    expect(parseWorkLayout(JSON.parse(JSON.stringify(withView)))).toEqual(withView);

    const old = parseWorkLayout(JSON.parse(JSON.stringify(base)));
    expect(old).toEqual(base);
    expect(old === null ? null : 'view' in (groups(old)[0]?.tabs[0] ?? {})).toBe(false);

    const raw = JSON.parse(JSON.stringify(withView)) as { root: { tabs: Array<Record<string, unknown>> } };
    raw.root.tabs[0]!.view = 'grid';
    expect(parseWorkLayout(raw)).toBeNull();
    raw.root.tabs[0]!.view = null;
    expect(parseWorkLayout(raw)).toBeNull();
  });
});

describe('findTab', () => {
  it('находит группу и индекс, иначе null', () => {
    const tab = freshTab();
    const layout = openTab(emptyLayout(), tab, 'active');
    const found = findTab(layout, tab.id);
    expect(found).not.toBeNull();
    expect(found?.group.id).toBe(layout.activeGroupId);
    expect(found?.index).toBe(0);
    expect(findTab(layout, 'нет-такой')).toBeNull();
  });
});

describe('groups', () => {
  it('визуальный порядок: слева направо, сверху вниз', () => {
    const { layout, groupIds } = buildGroups(3);
    // Порядок обхода определяется тем, что новая группа всегда становится вторым
    // ребёнком (row-сплит кладёт её справа) — глубокий обход даёт тот же порядок,
    // что и порядок создания.
    expect(groups(layout).map((g) => g.id)).toEqual(groupIds);
  });
});

describe('openTerminalSessionIds (раунд исправлений 1, Minor №6: единый экспорт вместо копий в AppShell.tsx/TabStrip.tsx)', () => {
  it('собирает id сессий терминальных вкладок по ВСЕЙ раскладке, не только активной группы', () => {
    const first = freshTab();
    const second = freshTab();
    const room: TabSpec = { kind: 'room', id: tabId.room('r-1'), roomId: 'r-1' };
    let layout = openTab(emptyLayout(), first, 'active');
    const group = soleGroup(layout);
    layout = splitGroup(layout, group.id, 'row', second, { [group.id]: { width: 800, height: 600 } }).layout;
    layout = openTab(layout, room, 'active');

    expect(openTerminalSessionIds(layout).sort()).toEqual([first.sessionId, second.sessionId].sort());
  });

  it('раскладка не гидрирована (undefined) — пустой список, не бросок', () => {
    expect(openTerminalSessionIds(undefined)).toEqual([]);
  });
});

describe('тест 14: инвариант по диапазону (500 случайных операций с зерном)', () => {
  /** mulberry32 — маленький детерминированный PRNG, без Math.random (план, правило проверки). */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('после каждой из 500 операций раскладка валидна и групп не больше 8', () => {
    const seed = 20260927;
    const random = mulberry32(seed);
    let layout = emptyLayout(random);
    let counter = 0;
    let step = 0;

    const pick = <T,>(arr: readonly T[]): T | undefined =>
      arr.length === 0 ? undefined : arr[Math.floor(random() * arr.length)];

    const allTabs = (): TabSpec[] => groups(layout).flatMap((g) => g.tabs);

    const allSplitIds = (): string[] => {
      const ids: string[] = [];
      const walk = (node: WorkLayout['root']): void => {
        if (node.type !== 'split') return;
        ids.push(node.id);
        walk(node.children[0]);
        walk(node.children[1]);
      };
      walk(layout.root);
      return ids;
    };

    // Раунд исправлений 1, Critical B: независимая от `validateLayout` проверка
    // уникальности id УЗЛОВ (групп и сплитов вместе) — своя реализация в тесте,
    // а не вызов внутренней логики `tree.ts`, чтобы дефект в самой `validateLayout`
    // не остался незамеченным за счёт того же кода, что и проверяемый.
    const allNodeIds = (node: WorkLayout['root']): string[] =>
      node.type === 'group' ? [node.id] : [node.id, ...allNodeIds(node.children[0]), ...allNodeIds(node.children[1])];

    const nextFreshTab = (): TabSpec => {
      counter += 1;
      const kind = Math.floor(random() * 3);
      if (kind === 0) return { kind: 'terminal', id: tabId.terminal(`f-${counter}`), sessionId: `f-${counter}` };
      if (kind === 1) return { kind: 'room', id: tabId.room(`f-${counter}`), roomId: `f-${counter}` };
      return { kind: 'browser', id: tabId.browser(random), url: `https://x/${counter}` };
    };

    const randomSize = (): GroupSizes[string] => ({
      width: Math.floor(random() * 700),
      height: Math.floor(random() * 500),
    });

    const specialRatios = [NaN, Infinity, -Infinity];
    const edges: Edge[] = ['left', 'right', 'top', 'bottom'];

    try {
      for (step = 0; step < 500; step += 1) {
        const op = Math.floor(random() * 8);
        const existingTabs = allTabs();
        const groupIds = groups(layout).map((g) => g.id);
        const targetGroupId = pick(groupIds);
        const sourceTab = pick(existingTabs);

        if (op === 0) {
          // open: новая вкладка или повторное открытие уже открытой (фокус).
          const tab = sourceTab !== undefined && random() < 0.3 ? sourceTab : nextFreshTab();
          const where =
            targetGroupId === undefined || random() < 0.5
              ? ('active' as const)
              : { groupId: targetGroupId, index: Math.floor(random() * 5) };
          layout = openTab(layout, tab, where);
        } else if (op === 1) {
          // close
          if (sourceTab !== undefined) layout = closeTab(layout, sourceTab.id);
        } else if (op === 2) {
          // move — в строку или к краю.
          if (sourceTab !== undefined && targetGroupId !== undefined) {
            if (random() < 0.5) {
              const { layout: next } = moveTab(layout, sourceTab.id, {
                groupId: targetGroupId,
                index: Math.floor(random() * 5),
              });
              layout = next;
            } else {
              const edge = pick(edges) ?? 'right';
              const sizes: GroupSizes | undefined =
                random() < 0.5 ? { [targetGroupId]: randomSize() } : undefined;
              const { layout: next } = moveTab(layout, sourceTab.id, { groupId: targetGroupId, edge }, sizes);
              layout = next;
            }
          }
        } else if (op === 3) {
          // split
          if (targetGroupId !== undefined) {
            const direction = random() < 0.5 ? 'row' : 'column';
            const tab = sourceTab !== undefined && random() < 0.3 ? sourceTab : nextFreshTab();
            const sizes: GroupSizes | undefined =
              random() < 0.5 ? { [targetGroupId]: randomSize() } : undefined;
            const { layout: next } = splitGroup(layout, targetGroupId, direction, tab, sizes);
            layout = next;
          }
        } else if (op === 4) {
          // setRatio, включая NaN/±Infinity.
          const splitId = pick(allSplitIds());
          if (splitId !== undefined) {
            const ratio = random() < 0.2 ? (pick(specialRatios) ?? NaN) : random();
            layout = setRatio(layout, splitId, ratio);
          }
        } else if (op === 5) {
          // reopen
          layout = reopenClosed(layout);
        } else if (op === 6) {
          // prune — топит один случайный таб (или никого, если табов нет).
          const dead = pick(existingTabs);
          layout = pruneLayout(layout, (tab) => dead === undefined || tab.id !== dead.id);
        } else {
          // update
          if (sourceTab !== undefined) layout = updateTab(layout, sourceTab.id, { url: `https://y/${step}` });
        }

        const errors = validateLayout(layout);
        if (errors.length > 0) throw new Error(`нарушены инварианты: ${JSON.stringify(errors)}`);
        if (groups(layout).length > LIMITS.maxGroups) {
          throw new Error(`групп больше ${LIMITS.maxGroups}: ${groups(layout).length}`);
        }
        const nodeIds = allNodeIds(layout.root);
        if (new Set(nodeIds).size !== nodeIds.length) {
          throw new Error(`дубль id узла: ${JSON.stringify(nodeIds)}`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`seed=${seed} step=${step}: ${reason}`);
    }
  });
});

describe('размер вкладки браузера (спека 2026-10-07, 4.2)', () => {
  const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };

  it('updateTab: viewport ставится и снимается (null — Fit, поля нет); адрес не трогает размер', () => {
    const page = browserTab('http://localhost:5173/');
    const layout = openTab(emptyLayout(), page, 'active');
    const sized = updateTab(layout, page.id, { viewport: MOBILE_M });
    expect(groups(sized)[0]?.tabs[0]).toEqual({ ...page, viewport: MOBILE_M });
    const moved = updateTab(sized, page.id, { url: 'http://localhost:5173/a' });
    expect(groups(moved)[0]?.tabs[0]).toEqual({ ...page, url: 'http://localhost:5173/a', viewport: MOBILE_M });
    const fit = updateTab(sized, page.id, { viewport: null });
    expect(groups(fit)[0]?.tabs[0]).toEqual(page);
    expect(Object.keys(groups(fit)[0]?.tabs[0] ?? {})).not.toContain('viewport');
    expect(validateLayout(sized)).toEqual([]);
  });

  function withBrowserTab(tab: Record<string, unknown>): unknown {
    return { root: { type: 'group', id: 'g1', tabs: [tab], activeTabId: tab.id }, activeGroupId: 'g1', closedTabs: [] };
  }

  it('parseWorkLayout: пресет и свой размер читаются, лишние поля размера выкинуты', () => {
    const preset = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: { ...MOBILE_M, extra: 1 } }));
    expect(preset === null ? null : groups(preset)[0]?.tabs[0]).toEqual({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: MOBILE_M });
    const custom = { width: 1024, height: 700, mobile: false, dpr: 1 };
    const own = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: custom }));
    expect(own === null ? null : groups(own)[0]?.tabs[0]).toEqual({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: custom });
  });

  it('parseWorkLayout: мусор в размере — вкладка без размера (Fit), раскладка цела', () => {
    for (const viewport of [{ preset: 'phone', rotated: false, dpr: 2 }, { width: 10, height: 10, mobile: false, dpr: 1 }, 'mobile-m', null]) {
      const layout = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport }));
      expect(layout === null ? null : groups(layout)[0]?.tabs[0], JSON.stringify(viewport)).toEqual({
        kind: 'browser',
        id: 'browser:0000c1',
        url: 'http://localhost:5173/',
      });
    }
  });
});
