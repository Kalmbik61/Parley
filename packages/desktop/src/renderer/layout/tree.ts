/**
 * Раскладка работы как дерево сплитов из групп вкладок (спека 5.2, кусок 2.1).
 * Все операции — чистые функции: новая раскладка или (для отказов) та же
 * ссылка на прежнюю, без исключений на ожидаемых случаях («нет такой вкладки»,
 * «группа не помещается») — это не поломка, а обычный ответ пользователю.
 */

import type { FileRootSpec, GroupNode, LayoutNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { nodeId } from './ids.js';

export const LIMITS: {
  maxGroups: 8;
  minGroup: { width: 240; height: 160 };
  ratio: { min: 0.1; max: 0.9 };
  closedTabs: 10;
} = {
  maxGroups: 8,
  minGroup: { width: 240, height: 160 },
  ratio: { min: 0.1, max: 0.9 },
  closedTabs: 10,
};

export type GroupSizes = Record<string, { width: number; height: number }>;
export type OpError = 'too-many-groups' | 'too-small' | 'not-found';
export interface OpResult {
  layout: WorkLayout;
  error: OpError | null;
}
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Where = 'active' | { groupId: string; index?: number };
export type TabPatch = { url?: string };

// ---- обход и поиск в дереве ------------------------------------------------

function flattenGroups(node: LayoutNode): GroupNode[] {
  if (node.type === 'group') return [node];
  return [...flattenGroups(node.children[0]), ...flattenGroups(node.children[1])];
}

/** Группы в визуальном порядке: слева направо, сверху вниз. */
export function groups(layout: WorkLayout): GroupNode[] {
  return flattenGroups(layout.root);
}

/**
 * Id сессий, у которых уже открыт терминал в раскладке работы: палитра в режиме
 * разделения показывает такую сессию только вкладкой (спека 9.5, кусок 6.2).
 * `layout: undefined` (раскладка ещё не гидрирована) — пустой список, не бросок:
 * палитра берёт `layout` прямо из стора, где он до гидрации именно `undefined`,
 * а не отсутствующий аргумент.
 */
export function openTerminalSessionIds(layout: WorkLayout | undefined): string[] {
  if (layout === undefined) return [];
  return groups(layout).flatMap((group) => group.tabs.filter((tab) => tab.kind === 'terminal').map((tab) => tab.sessionId));
}

function findGroupById(node: LayoutNode, id: string): GroupNode | null {
  if (node.type === 'group') return node.id === id ? node : null;
  return findGroupById(node.children[0], id) ?? findGroupById(node.children[1], id);
}

export function findTab(layout: WorkLayout, tabId: string): { group: GroupNode; index: number } | null {
  for (const group of groups(layout)) {
    const index = group.tabs.findIndex((tab) => tab.id === tabId);
    if (index !== -1) return { group, index };
  }
  return null;
}

/**
 * Id всех узлов дерева (группы и сплиты вместе, а не порознь по типу): `replaceNode`
 * (ниже) ищет узел по `id` без учёта `type`, поэтому дубль id между группой и сплитом
 * (не только между двумя группами) портит дерево так же, как дубль id вкладки — один
 * общий инвариант для обоих типов узлов (раунд исправлений 1, Critical B).
 */
function allNodeIds(node: LayoutNode): string[] {
  if (node.type === 'group') return [node.id];
  return [node.id, ...allNodeIds(node.children[0]), ...allNodeIds(node.children[1])];
}

/** Первая группа поддерева в визуальном порядке (для «сосед — сплит» при закрытии). */
function firstGroupId(node: LayoutNode): string {
  return node.type === 'group' ? node.id : firstGroupId(node.children[0]);
}

/** Сосед узла `id` — другой ребёнок его родительского сплита, `null` — у узла нет родителя (корень). */
function findSibling(root: LayoutNode, id: string): LayoutNode | null {
  if (root.type === 'group') return null;
  const [a, b] = root.children;
  if (a.id === id) return b;
  if (b.id === id) return a;
  return findSibling(a, id) ?? findSibling(b, id);
}

// ---- построение нового дерева ----------------------------------------------

/** Заменяет узел `id` результатом `replacer` (получает сам найденный узел); не найден — то же дерево той же ссылкой. */
function replaceNode(root: LayoutNode, id: string, replacer: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (root.id === id) return replacer(root);
  if (root.type === 'group') return root;
  const [a, b] = root.children;
  const newA = replaceNode(a, id, replacer);
  const newB = replaceNode(b, id, replacer);
  if (newA === a && newB === b) return root;
  return { ...root, children: [newA, newB] };
}

/** Убирает группу `groupId`, её сосед занимает место родительского сплита. Требует не-корневую группу. */
function removeGroupAndPromoteSibling(root: LayoutNode, groupId: string): LayoutNode {
  if (root.type === 'group') return root;
  const [a, b] = root.children;
  if (a.id === groupId) return b;
  if (b.id === groupId) return a;
  const newA = removeGroupAndPromoteSibling(a, groupId);
  const newB = removeGroupAndPromoteSibling(b, groupId);
  if (newA === a && newB === b) return root;
  return { ...root, children: [newA, newB] };
}

/** Оборачивает узел `targetGroupId` в новый сплит с `newGroup` на стороне `edge`, ratio 0.5. */
function splitAtEdge(root: LayoutNode, targetGroupId: string, edge: Edge, newGroup: GroupNode): LayoutNode {
  const direction: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const newFirst = edge === 'left' || edge === 'top';
  return replaceNode(root, targetGroupId, (node) => ({
    type: 'split',
    id: nodeId('s'),
    direction,
    ratio: 0.5,
    children: newFirst ? [newGroup, node] : [node, newGroup],
  }));
}

function edgeOf(direction: 'row' | 'column'): Edge {
  return direction === 'row' ? 'right' : 'bottom';
}

function tooSmall(direction: 'row' | 'column', size: { width: number; height: number }): boolean {
  const value = direction === 'row' ? size.width : size.height;
  // Неизвестный размер (NaN/±Infinity) — как 0 у свёрнутого окна: считаем, что места
  // нет, а не пропускаем сплит с непроверенным размером (раунд исправлений 1, Important B —
  // `NaN < порог` иначе даёт `false`, и сплит проходит вслепую).
  if (!Number.isFinite(value)) return true;
  return value < (direction === 'row' ? LIMITS.minGroup.width : LIMITS.minGroup.height) * 2;
}

// ---- операции над вкладками группы -----------------------------------------

function insertAt(tabs: readonly TabSpec[], index: number, tab: TabSpec): TabSpec[] {
  const clamped = Math.max(0, Math.min(index, tabs.length));
  return [...tabs.slice(0, clamped), tab, ...tabs.slice(clamped)];
}

/** Сосед закрытой вкладки по исходному массиву (с ней самой) — справа, иначе слева. */
function neighborAfterRemoval(tabs: readonly TabSpec[], removedIndex: number): string | null {
  const right = tabs[removedIndex + 1];
  if (right !== undefined) return right.id;
  const left = tabs[removedIndex - 1];
  if (left !== undefined) return left.id;
  return null;
}

interface Removal {
  tabs: TabSpec[];
  removed: TabSpec;
  activeTabId: string | null;
}

/** Убирает вкладку из группы; `null` — такой вкладки в группе нет. */
function removeTabFromGroup(group: GroupNode, tabId: string): Removal | null {
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return null;
  const removed = group.tabs[index];
  if (removed === undefined) return null;
  const tabs = group.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId = group.activeTabId === tabId ? neighborAfterRemoval(group.tabs, index) : group.activeTabId;
  return { tabs, removed, activeTabId };
}

function pushClosed(closedTabs: readonly TabSpec[], tab: TabSpec): TabSpec[] {
  const withoutDup = closedTabs.filter((t) => t.id !== tab.id);
  return [tab, ...withoutDup].slice(0, LIMITS.closedTabs);
}

function focusTabInGroup(layout: WorkLayout, group: GroupNode, tabId: string): WorkLayout {
  if (group.activeTabId === tabId) {
    return layout.activeGroupId === group.id ? layout : { ...layout, activeGroupId: group.id };
  }
  const root = replaceNode(layout.root, group.id, () => ({ ...group, activeTabId: tabId }));
  return { ...layout, root, activeGroupId: group.id };
}

// ---- публичные операции -----------------------------------------------------

export function emptyLayout(random?: () => number): WorkLayout {
  const id = nodeId('g', random);
  const root: GroupNode = { type: 'group', id, tabs: [], activeTabId: null };
  return { root, activeGroupId: id, closedTabs: [] };
}

/**
 * `focus: false` (9.2b) — вкладка встаёт на место, `activeTabId` группы и `activeGroupId` прежние; в
 * пустой группе она — активная. Так `window.open` невидимой страницы не уводит человека. Уже открытую
 * вкладку `focus: false` не трогает.
 */
export function openTab(layout: WorkLayout, tab: TabSpec, where: Where = 'active', options: { focus?: boolean } = {}): WorkLayout {
  const focus = options.focus ?? true;
  const existing = findTab(layout, tab.id);
  if (existing !== null) return focus ? focusTabInGroup(layout, existing.group, tab.id) : layout;

  const groupId = where === 'active' ? layout.activeGroupId : where.groupId;
  const targetGroup = findGroupById(layout.root, groupId);
  if (targetGroup === null) return layout;

  const index = where === 'active' || where.index === undefined ? targetGroup.tabs.length : where.index;
  const activeTabId = focus || targetGroup.activeTabId === null ? tab.id : targetGroup.activeTabId;
  const newGroup: GroupNode = { ...targetGroup, tabs: insertAt(targetGroup.tabs, index, tab), activeTabId };
  const root = replaceNode(layout.root, targetGroup.id, () => newGroup);
  return { ...layout, root, activeGroupId: focus ? targetGroup.id : layout.activeGroupId };
}

/** Чистая операция дерева; человек закрывает вкладки только через `requestCloseTabs` стора (2.2). */
export function closeTab(layout: WorkLayout, tabId: string): WorkLayout {
  const found = findTab(layout, tabId);
  if (found === null) return layout;
  const removal = removeTabFromGroup(found.group, tabId);
  if (removal === null) return layout;

  const closedTabs = pushClosed(layout.closedTabs, removal.removed);

  if (removal.tabs.length > 0) {
    const newGroup: GroupNode = { ...found.group, tabs: removal.tabs, activeTabId: removal.activeTabId };
    const root = replaceNode(layout.root, found.group.id, () => newGroup);
    return { ...layout, root, closedTabs };
  }

  if (layout.root.type === 'group' && layout.root.id === found.group.id) {
    const emptyRoot: GroupNode = { ...found.group, tabs: [], activeTabId: null };
    return { ...layout, root: emptyRoot, activeGroupId: emptyRoot.id, closedTabs };
  }

  const sibling = findSibling(layout.root, found.group.id);
  const root = removeGroupAndPromoteSibling(layout.root, found.group.id);
  const activeGroupId =
    layout.activeGroupId === found.group.id && sibling !== null ? firstGroupId(sibling) : layout.activeGroupId;
  return { ...layout, root, activeGroupId, closedTabs };
}

/** Поля вкладки без kind и id; растёт по нужде. Пока одно — адрес вкладки браузера (9.2). */
export function updateTab(layout: WorkLayout, tabId: string, patch: TabPatch): WorkLayout {
  const found = findTab(layout, tabId);
  if (found === null) return layout;
  if (patch.url === undefined) return layout;

  const tab = found.group.tabs[found.index];
  if (tab === undefined || tab.kind !== 'browser') return layout;

  const url = patch.url;
  const newTabs = found.group.tabs.map((t, i) => (i === found.index ? { ...t, url } : t));
  const newGroup: GroupNode = { ...found.group, tabs: newTabs };
  const root = replaceNode(layout.root, found.group.id, () => newGroup);
  return { ...layout, root };
}

function moveToPosition(
  layout: WorkLayout,
  sourceGroup: GroupNode,
  tabId: string,
  targetGroup: GroupNode,
  index: number,
): OpResult {
  const tab = sourceGroup.tabs.find((t) => t.id === tabId);
  if (tab === undefined) return { layout, error: 'not-found' };

  if (sourceGroup.id === targetGroup.id) {
    const withoutTab = sourceGroup.tabs.filter((t) => t.id !== tabId);
    const newGroup: GroupNode = { ...sourceGroup, tabs: insertAt(withoutTab, index, tab), activeTabId: tabId };
    const root = replaceNode(layout.root, sourceGroup.id, () => newGroup);
    return { layout: { ...layout, root, activeGroupId: newGroup.id }, error: null };
  }

  const removal = removeTabFromGroup(sourceGroup, tabId);
  if (removal === null) return { layout, error: 'not-found' };

  const root =
    removal.tabs.length > 0
      ? replaceNode(layout.root, sourceGroup.id, () => ({
          ...sourceGroup,
          tabs: removal.tabs,
          activeTabId: removal.activeTabId,
        }))
      : removeGroupAndPromoteSibling(layout.root, sourceGroup.id);

  const targetWithTab: GroupNode = {
    ...targetGroup,
    tabs: insertAt(targetGroup.tabs, index, removal.removed),
    activeTabId: tabId,
  };
  const finalRoot = replaceNode(root, targetGroup.id, () => targetWithTab);
  return { layout: { ...layout, root: finalRoot, activeGroupId: targetGroup.id }, error: null };
}

function moveToEdge(
  layout: WorkLayout,
  sourceGroup: GroupNode,
  tabId: string,
  targetGroup: GroupNode,
  edge: Edge,
  sizes: GroupSizes | undefined,
): OpResult {
  const tab = sourceGroup.tabs.find((t) => t.id === tabId);
  if (tab === undefined) return { layout, error: 'not-found' };

  // Перенос единственной вкладки группы к краю этой же группы ничего не меняет.
  if (sourceGroup.id === targetGroup.id && sourceGroup.tabs.length === 1) {
    return { layout, error: null };
  }

  // Если исходная группа переносимой вкладки исчезает, число групп не растёт.
  const sourceWillBeRemoved = sourceGroup.id !== targetGroup.id && sourceGroup.tabs.length === 1;
  const newCount = groups(layout).length + (sourceWillBeRemoved ? 0 : 1);
  if (newCount > LIMITS.maxGroups) return { layout, error: 'too-many-groups' };

  const size = sizes?.[targetGroup.id];
  if (size !== undefined) {
    const direction: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column';
    if (tooSmall(direction, size)) return { layout, error: 'too-small' };
  }

  const removal = removeTabFromGroup(sourceGroup, tabId);
  if (removal === null) return { layout, error: 'not-found' };

  const tree =
    removal.tabs.length > 0
      ? replaceNode(layout.root, sourceGroup.id, () => ({
          ...sourceGroup,
          tabs: removal.tabs,
          activeTabId: removal.activeTabId,
        }))
      : removeGroupAndPromoteSibling(layout.root, sourceGroup.id);

  const newGroup: GroupNode = { type: 'group', id: nodeId('g'), tabs: [removal.removed], activeTabId: tabId };
  const finalRoot = splitAtEdge(tree, targetGroup.id, edge, newGroup);
  return { layout: { ...layout, root: finalRoot, activeGroupId: newGroup.id }, error: null };
}

export function moveTab(
  layout: WorkLayout,
  tabId: string,
  target: { groupId: string; index: number } | { groupId: string; edge: Edge },
  sizes?: GroupSizes,
): OpResult {
  const found = findTab(layout, tabId);
  if (found === null) return { layout, error: 'not-found' };
  const targetGroup = findGroupById(layout.root, target.groupId);
  if (targetGroup === null) return { layout, error: 'not-found' };

  if ('index' in target) return moveToPosition(layout, found.group, tabId, targetGroup, target.index);
  return moveToEdge(layout, found.group, tabId, targetGroup, target.edge, sizes);
}

export function splitGroup(
  layout: WorkLayout,
  groupId: string,
  direction: 'row' | 'column',
  tab: TabSpec,
  sizes?: GroupSizes,
): OpResult {
  const targetGroup = findGroupById(layout.root, groupId);
  if (targetGroup === null) return { layout, error: 'not-found' };

  const edge = edgeOf(direction);
  const existing = findTab(layout, tab.id);
  if (existing !== null) return moveToEdge(layout, existing.group, tab.id, targetGroup, edge, sizes);

  // Пустую группу (только у пустой работы, инвариант 2) расщеплять не на что —
  // вкладка просто встаёт в неё, без нового сплита.
  if (targetGroup.tabs.length === 0) return { layout: openTab(layout, tab, { groupId }), error: null };

  const newCount = groups(layout).length + 1;
  if (newCount > LIMITS.maxGroups) return { layout, error: 'too-many-groups' };

  const size = sizes?.[groupId];
  if (size !== undefined && tooSmall(direction, size)) return { layout, error: 'too-small' };

  const newGroup: GroupNode = { type: 'group', id: nodeId('g'), tabs: [tab], activeTabId: tab.id };
  const finalRoot = splitAtEdge(layout.root, groupId, edge, newGroup);
  return { layout: { ...layout, root: finalRoot, activeGroupId: newGroup.id }, error: null };
}

export function setRatio(layout: WorkLayout, splitId: string, ratio: number): WorkLayout {
  // `NaN`/`±Infinity` не ловятся клампом (Math.min/max с ними дают NaN) — отсекаем заранее,
  // как и в `normalizeUi` (`shared/ui-types.ts`, тот же раунд находок).
  if (!Number.isFinite(ratio)) return layout;
  const clamped = Math.min(Math.max(ratio, LIMITS.ratio.min), LIMITS.ratio.max);
  const root = replaceNode(layout.root, splitId, (node) =>
    node.type === 'split' ? { ...node, ratio: clamped } : node,
  );
  return root === layout.root ? layout : { ...layout, root };
}

export function focusGroup(layout: WorkLayout, groupId: string): WorkLayout {
  if (layout.activeGroupId === groupId) return layout;
  const group = findGroupById(layout.root, groupId);
  if (group === null) return layout;
  return { ...layout, activeGroupId: groupId };
}

export function focusTab(layout: WorkLayout, tabId: string): WorkLayout {
  const found = findTab(layout, tabId);
  if (found === null) return layout;
  return focusTabInGroup(layout, found.group, tabId);
}

export function reopenClosed(layout: WorkLayout): WorkLayout {
  const [tab, ...rest] = layout.closedTabs;
  if (tab === undefined) return layout;
  return openTab({ ...layout, closedTabs: rest }, tab, 'active');
}

function pruneNode(node: LayoutNode, alive: (tab: TabSpec) => boolean): LayoutNode | null {
  if (node.type === 'group') {
    const tabs = node.tabs.filter(alive);
    // Никто не умер — та же ссылка (раунд исправлений 1, Important A): иначе
    // `pruneLayout` пересобирает всё дерево заново на каждый вызов, даже когда
    // ни одна вкладка не пропала, а от этого зависят подписки zustand в 2.2.
    if (tabs.length === node.tabs.length) return node;
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : (tabs[0]?.id ?? null);
    return { ...node, tabs, activeTabId };
  }
  const a = pruneNode(node.children[0], alive);
  const b = pruneNode(node.children[1], alive);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

export function pruneLayout(layout: WorkLayout, alive: (tab: TabSpec) => boolean): WorkLayout {
  const prunedRoot = pruneNode(layout.root, alive);
  // `closedTabs` — тем же `alive` (раунд исправлений 1, Important B): иначе
  // `reopenClosed` может вернуть вкладку, которую `alive` только что объявил мёртвой.
  const filteredClosed = layout.closedTabs.filter(alive);
  const closedChanged = filteredClosed.length !== layout.closedTabs.length;
  if (prunedRoot === layout.root && !closedChanged) return layout;

  const rootIdHint = layout.root.type === 'group' ? layout.root.id : nodeId('g');
  const root: LayoutNode = prunedRoot ?? { type: 'group', id: rootIdHint, tabs: [], activeTabId: null };
  const survivors = flattenGroups(root);
  const activeGroupId = survivors.some((g) => g.id === layout.activeGroupId)
    ? layout.activeGroupId
    : (survivors[0]?.id ?? root.id);
  return { root, activeGroupId, closedTabs: closedChanged ? filteredClosed : layout.closedTabs };
}

// ---- проверка и разбор -------------------------------------------------------

/** Нарушения инвариантов 1–6 спеки 5.2, а также `activeTabId` не из своей группы (`null` — только у пустой). */
export function validateLayout(layout: WorkLayout): string[] {
  const errors: string[] = [];
  const allGroups = groups(layout);
  const isRoot = (id: string): boolean => layout.root.type === 'group' && layout.root.id === id;

  const tabCounts = new Map<string, number>();
  for (const group of allGroups) {
    for (const tab of group.tabs) tabCounts.set(tab.id, (tabCounts.get(tab.id) ?? 0) + 1);
  }
  for (const [id, count] of tabCounts) {
    if (count > 1) errors.push(`duplicate tab id: ${id}`);
  }

  // Дубль id УЗЛА (группы или сплита) — отдельный от дубля id вкладки инвариант:
  // `replaceNode` ищет по id без учёта `type`, поэтому дубль между группой и
  // сплитом-предком портит дерево так же тихо (раунд исправлений 1, Critical B).
  const nodeIdCounts = new Map<string, number>();
  for (const id of allNodeIds(layout.root)) nodeIdCounts.set(id, (nodeIdCounts.get(id) ?? 0) + 1);
  for (const [id, count] of nodeIdCounts) {
    if (count > 1) errors.push(`duplicate node id: ${id}`);
  }

  for (const group of allGroups) {
    if (group.tabs.length === 0 && !isRoot(group.id)) errors.push(`empty non-root group: ${group.id}`);
    if (group.tabs.length === 0) {
      if (group.activeTabId !== null) errors.push(`activeTabId of an empty group is not null: ${group.id}`);
    } else if (group.activeTabId === null || !group.tabs.some((t) => t.id === group.activeTabId)) {
      errors.push(`activeTabId not from its own group: ${group.id}`);
    }
  }

  const walkSplits = (node: LayoutNode): void => {
    if (node.type === 'group') return;
    if (node.ratio < LIMITS.ratio.min || node.ratio > LIMITS.ratio.max) errors.push(`ratio out of range: ${node.id}`);
    walkSplits(node.children[0]);
    walkSplits(node.children[1]);
  };
  walkSplits(layout.root);

  if (allGroups.length > LIMITS.maxGroups) errors.push(`more groups than the ${LIMITS.maxGroups} limit: ${allGroups.length}`);
  if (!allGroups.some((g) => g.id === layout.activeGroupId)) {
    errors.push(`activeGroupId does not exist: ${layout.activeGroupId}`);
  }

  return errors;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Разбор (не просто проверка) — каждая функция строит НОВЫЙ объект только из полей
 * своего типа, а не пропускает исходный `value` как есть: лишние поля с диска
 * (старый формат, чужая правка `layouts.json`) иначе тихо путешествовали бы туда-обратно,
 * раз 2.2 пишет результат `parseWorkLayout` обратно на диск (раунд исправлений 1, Minor B).
 */
function parseFileRootSpec(value: unknown): FileRootSpec | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'project') return { kind: 'project' };
  if (value.kind === 'worktree' && typeof value.sessionId === 'string') {
    return { kind: 'worktree', sessionId: value.sessionId };
  }
  return null;
}

function parseTabSpec(value: unknown): TabSpec | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const id = value.id;
  switch (value.kind) {
    case 'terminal':
      return typeof value.sessionId === 'string' ? { kind: 'terminal', id, sessionId: value.sessionId } : null;
    case 'mail':
      return id === 'mail' ? { kind: 'mail', id: 'mail' } : null;
    case 'room':
      return typeof value.roomId === 'string' ? { kind: 'room', id, roomId: value.roomId } : null;
    case 'diff': {
      if (typeof value.sessionId !== 'string') return null;
      const commit = value.commit;
      if (commit !== null && typeof commit !== 'string') return null;
      return { kind: 'diff', id, sessionId: value.sessionId, commit };
    }
    case 'file': {
      const root = parseFileRootSpec(value.root);
      if (root === null || typeof value.path !== 'string') return null;
      return { kind: 'file', id, root, path: value.path };
    }
    case 'browser':
      return typeof value.url === 'string' ? { kind: 'browser', id, url: value.url } : null;
    default:
      return null;
  }
}

function parseTabSpecArray(value: unknown): TabSpec[] | null {
  if (!Array.isArray(value)) return null;
  const tabs: TabSpec[] = [];
  for (const item of value) {
    const tab = parseTabSpec(item);
    if (tab === null) return null;
    tabs.push(tab);
  }
  return tabs;
}

function parseLayoutNode(value: unknown): LayoutNode | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const id = value.id;
  if (value.type === 'group') {
    const tabs = parseTabSpecArray(value.tabs);
    if (tabs === null) return null;
    const activeTabId = value.activeTabId;
    if (activeTabId !== null && typeof activeTabId !== 'string') return null;
    return { type: 'group', id, tabs, activeTabId };
  }
  if (value.type === 'split') {
    const direction = value.direction;
    if (direction !== 'row' && direction !== 'column') return null;
    const ratio = value.ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    if (!Array.isArray(value.children) || value.children.length !== 2) return null;
    const a = parseLayoutNode(value.children[0]);
    const b = parseLayoutNode(value.children[1]);
    if (a === null || b === null) return null;
    return { type: 'split', id, direction, ratio, children: [a, b] };
  }
  return null;
}

/** Разбор с диска: мусор или нарушенный инвариант → `null`; битый `activeGroupId` — чинится. */
export function parseWorkLayout(raw: unknown): WorkLayout | null {
  if (!isRecord(raw)) return null;
  const root = parseLayoutNode(raw.root);
  if (root === null) return null;
  if (typeof raw.activeGroupId !== 'string') return null;
  const closedTabs = parseTabSpecArray(raw.closedTabs);
  if (closedTabs === null) return null;

  const allGroups = flattenGroups(root);
  const activeGroupId = allGroups.some((g) => g.id === raw.activeGroupId)
    ? raw.activeGroupId
    : (allGroups[0]?.id ?? raw.activeGroupId);

  const repaired: WorkLayout = { root, activeGroupId, closedTabs };
  return validateLayout(repaired).length === 0 ? repaired : null;
}
