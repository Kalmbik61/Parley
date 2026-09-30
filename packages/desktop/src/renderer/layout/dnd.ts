/**
 * Перетаскивание вкладок, строк сессий и файлов «Файлов» (куски 2.6, 7.2, спека 5.4) — чистая часть:
 * зона броска по точке, операция над раскладкой, разбор `onDragEnd` и
 * `collisionDetection` для единственного `DndContext` в `AppShell.tsx`.
 *
 * Компоненты раскладки только объявляют droppable и sortable с `data` вида
 * `DropTargetData`, а тащимые — `DragSourceData`; что куда бросили, решает
 * этот модуль.
 *
 * Кусок 7 плана «Organic» (спека окна 2026-09-29, 2.5): строки сайдбара тоже цели броска — сессию бросают на другую
 * сессию (диалог 1.6) или на строку комнаты (`rooms.addMember`). Такой бросок разбирает `sidebarDropFromDragEnd`,
 * а что он значит для карты работы и можно ли его сделать — `dnd-sidebar.ts`; в раскладку он не попадает
 * (`dropFromDragEnd` для него `null`).
 */

import type {
  ClientRect,
  CollisionDetection,
  DragEndEvent,
  DroppableContainer,
  Modifier,
} from '@dnd-kit/core';
import type { FileRoot } from '../../shared/files-types.js';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId as tabIdOf } from './ids.js';
import {
  findTab,
  focusGroup,
  focusTab,
  groups,
  moveTab,
  openTab,
  type Edge,
  type GroupSizes,
  type OpResult,
} from './tree.js';

export type DragItem =
  | { kind: 'tab'; tabId: string }
  | { kind: 'session'; sessionId: string }
  // Файл дерева «Файлов» (7.2): path относительный, от корня root.
  | { kind: 'file'; root: FileRoot; path: string };
export type DropZone =
  | { kind: 'strip'; groupId: string; index: number }
  | { kind: 'center'; groupId: string }
  | { kind: 'edge'; groupId: string; edge: Edge }
  | { kind: 'terminal'; sessionId: string }; // поверхность терминала: путь в поле ввода (7.2)
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `data` тащимого: вкладки (у sortable она же и `DropTargetData`) и строки сессии. */
export interface DragSourceData {
  item: DragItem;
}

/** Строка сайдбара, на которую можно бросить сессию (2.5): строка сессии вне комнат или строка комнаты. */
export type SidebarTarget = { kind: 'session-row'; sessionId: string } | { kind: 'room-row'; roomId: string };

/** `data` каждого droppable и sortable раскладки и сайдбара; `workKey` — работа-владелец. */
export type DropTargetData = { workKey: string } & (
  | { kind: 'strip'; groupId: string; index: number } // вкладка строки или хвост строки
  | { kind: 'body'; groupId: string } // центр или край — по zoneForPoint
  | { kind: 'terminal'; sessionId: string } // поверхность терминала
  | SidebarTarget // строка сессии или комнаты в сайдбаре
);

/**
 * Id для @dnd-kit — с ключом работы: у трёх работ LRU droppable смонтированы
 * разом, а id вкладок уникальны только внутри работы (`mail` есть у каждой).
 * Совпавший id @dnd-kit молча перезаписал бы чужой контейнер.
 */
export const dndId = {
  tab: (workKey: string, tabId: string): string => `tab\u0000${workKey}\u0000${tabId}`,
  strip: (workKey: string, groupId: string): string => `strip\u0000${workKey}\u0000${groupId}`,
  body: (workKey: string, groupId: string): string => `body\u0000${workKey}\u0000${groupId}`,
  terminal: (workKey: string, tabId: string): string => `terminal\u0000${workKey}\u0000${tabId}`,
  session: (workKey: string, sessionId: string): string =>
    `session\u0000${workKey}\u0000${sessionId}`,
  // Цели броска в сайдбаре (2.5): тот же ключ работы — `s-01` есть у каждой работы.
  sessionRow: (workKey: string, sessionId: string): string =>
    `session-row\u0000${workKey}\u0000${sessionId}`,
  roomRow: (workKey: string, roomId: string): string => `room-row\u0000${workKey}\u0000${roomId}`,
  // Ключ корня, а не работы: у проекта и worktree сессий одни и те же относительные пути.
  file: (rootKey: string, path: string): string => `file\u0000${rootKey}\u0000${path}`,
};

/** Доля ширины или высоты тела, которую занимает зона края (спека 5.4). */
const EDGE_SHARE = 0.25;

/** Центр или край: край — 25% ширины или высоты; в углу побеждает ближайшая сторона. */
export function zoneForPoint(
  point: { x: number; y: number },
  body: RectLike,
  groupId: string,
): Exclude<DropZone, { kind: 'terminal' }> {
  const fx = body.width > 0 ? (point.x - body.left) / body.width : 0.5;
  const fy = body.height > 0 ? (point.y - body.top) / body.height : 0.5;
  // Кандидаты — края, в чью полосу попала точка; из них — ближайший в пикселях,
  // а не в долях: у широкого тела 5% высоты ближе, чем 5% ширины.
  const candidates: { edge: Edge; px: number }[] = [];
  if (fx < EDGE_SHARE) candidates.push({ edge: 'left', px: point.x - body.left });
  if (fx > 1 - EDGE_SHARE) candidates.push({ edge: 'right', px: body.left + body.width - point.x });
  if (fy < EDGE_SHARE) candidates.push({ edge: 'top', px: point.y - body.top });
  if (fy > 1 - EDGE_SHARE)
    candidates.push({ edge: 'bottom', px: body.top + body.height - point.y });
  let best: { edge: Edge; px: number } | null = null;
  for (const candidate of candidates) if (best === null || candidate.px < best.px) best = candidate;
  return best === null ? { kind: 'center', groupId } : { kind: 'edge', groupId, edge: best.edge };
}

/**
 * Принимает ли терминал предмет: только файл (7.2) — путь уходит агенту в поле ввода. Хост без
 * `pty.send` отсекает `AppShell`: `layoutCollision(activeWorkKey, accepts)`.
 */
export function acceptsTerminal(item: DragItem): boolean {
  switch (item.kind) {
    case 'tab':
    case 'session':
      return false;
    case 'file':
      return true;
  }
}

function isFileRoot(value: unknown): value is FileRoot {
  if (typeof value !== 'object' || value === null) return false;
  const { workKey, spec } = value as { workKey?: unknown; spec?: unknown };
  if (typeof workKey !== 'string' || typeof spec !== 'object' || spec === null) return false;
  const { kind, sessionId } = spec as { kind?: unknown; sessionId?: unknown };
  return kind === 'project' || (kind === 'worktree' && typeof sessionId === 'string');
}

function isDragItem(value: unknown): value is DragItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { kind?: unknown; root?: unknown; path?: unknown };
  if (item.kind === 'file') return isFileRoot(item.root) && typeof item.path === 'string';
  return item.kind === 'tab' || item.kind === 'session';
}

/** Предмет из `active.data.current`; у чужих тащимых его нет. */
export function dragItemOf(data: unknown): DragItem | null {
  if (typeof data !== 'object' || data === null) return null;
  const item = (data as { item?: unknown }).item;
  return isDragItem(item) ? item : null;
}

function isDropTarget(data: unknown): data is DropTargetData {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as { workKey?: unknown; kind?: unknown };
  return (
    typeof value.workKey === 'string' &&
    (value.kind === 'strip' ||
      value.kind === 'body' ||
      value.kind === 'terminal' ||
      value.kind === 'session-row' ||
      value.kind === 'room-row')
  );
}

function contains(rect: ClientRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

/**
 * collisionDetection DndContext. Контейнеры с чужим `data.workKey` отбрасываются: тела
 * скрытых работ LRU лежат на месте тела активной. Терминал под указателем и
 * accepts(active) — зона терминала важнее центра и краёв тела группы; иначе
 * droppable терминалов пропускаются.
 *
 * `accepts` — `AppShell` сужает `acceptsTerminal` хостом без `pty.send` (7.2): иначе старый хост
 * ответил бы `unknown_method`, а файл без зоны терминала падает в тело группы вкладкой.
 */
export function layoutCollision(
  activeWorkKey: string | null,
  accepts: (item: DragItem) => boolean = acceptsTerminal,
): CollisionDetection {
  return ({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates }) => {
    if (activeWorkKey === null) return [];
    const point = pointerCoordinates ?? {
      x: collisionRect.left + collisionRect.width / 2,
      y: collisionRect.top + collisionRect.height / 2,
    };
    // Предмет читается без проверки формы: решать, берёт ли его терминал, — дело `accepts`.
    const raw: unknown = (active.data.current as { item?: unknown } | undefined)?.item;
    const item =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { kind?: unknown }).kind === 'string'
        ? (raw as DragItem)
        : null;
    const takesTerminal = item !== null && accepts(item);
    // Строки сайдбара (2.5) берут только сессию: вкладка и файл на сессию или комнату не значат ничего.
    const takesSidebar = item?.kind === 'session';

    const hits: { container: DroppableContainer; data: DropTargetData; area: number }[] = [];
    for (const container of droppableContainers) {
      if (container.disabled) continue;
      const data: unknown = container.data.current;
      if (!isDropTarget(data) || data.workKey !== activeWorkKey) continue;
      if (data.kind === 'terminal' && !takesTerminal) continue;
      if ((data.kind === 'session-row' || data.kind === 'room-row') && !takesSidebar) continue;
      const rect = droppableRects.get(container.id);
      if (rect === undefined || !contains(rect, point)) continue;
      hits.push({ container, data, area: rect.width * rect.height });
    }

    // Поверхность лежит ровно на теле своей группы — по прямоугольнику их не
    // различить, поэтому терминал берёт верх явно.
    const terminal = hits.find((hit) => hit.data.kind === 'terminal');
    if (terminal !== undefined)
      return [
        { id: terminal.container.id, data: { droppableContainer: terminal.container, value: 0 } },
      ];
    // Вкладка лежит внутри хвоста своей строки: меньший прямоугольник точнее.
    hits.sort((a, b) => a.area - b.area);
    return hits.map((hit) => ({
      id: hit.container.id,
      data: { droppableContainer: hit.container, value: hit.area },
    }));
  };
}

/** Вкладка, которую открывает брошенная строка сессии или файл. */
function tabOfItem(item: Exclude<DragItem, { kind: 'tab' }>): TabSpec {
  if (item.kind === 'session') return { kind: 'terminal', id: tabIdOf.terminal(item.sessionId), sessionId: item.sessionId };
  return { kind: 'file', id: tabIdOf.file(item.root.spec, item.path), root: item.root.spec, path: item.path };
}

/** Перенос открытой вкладки; `strip.index` — место вставки в строке ДО переноса. */
function moveOpenTab(
  layout: WorkLayout,
  tabId: string,
  zone: Exclude<DropZone, { kind: 'terminal' }>,
  sizes: GroupSizes,
): OpResult {
  const target = groups(layout).find((group) => group.id === zone.groupId);
  if (target === undefined) return { layout, error: 'not-found' };
  switch (zone.kind) {
    case 'strip': {
      // Линия вставки стоит между вкладками исходной строки, а `moveTab` берёт
      // итоговый индекс: вправо в своей же группе место сдвигается на одну.
      const from = target.tabs.findIndex((tab) => tab.id === tabId);
      const index = from !== -1 && from < zone.index ? zone.index - 1 : zone.index;
      return moveTab(layout, tabId, { groupId: zone.groupId, index }, sizes);
    }
    case 'center': {
      const from = target.tabs.findIndex((tab) => tab.id === tabId);
      const index = from === -1 ? target.tabs.length : target.tabs.length - 1;
      return moveTab(layout, tabId, { groupId: zone.groupId, index }, sizes);
    }
    case 'edge':
      return moveTab(layout, tabId, { groupId: zone.groupId, edge: zone.edge }, sizes);
  }
}

export function applyDrop(
  layout: WorkLayout,
  item: DragItem,
  zone: Exclude<DropZone, { kind: 'terminal' }>,
  sizes: GroupSizes,
): OpResult {
  if (item.kind === 'tab') return moveOpenTab(layout, item.tabId, zone, sizes);

  const tab = tabOfItem(item);
  // Уже открытая сессия или файл — тот же перенос, что и у вкладки.
  if (findTab(layout, tab.id) !== null) return moveOpenTab(layout, tab.id, zone, sizes);

  const target = groups(layout).find((group) => group.id === zone.groupId);
  if (target === undefined) return { layout, error: 'not-found' };
  switch (zone.kind) {
    case 'strip':
      return {
        layout: openTab(layout, tab, { groupId: zone.groupId, index: zone.index }),
        error: null,
      };
    case 'center':
      return { layout: openTab(layout, tab, { groupId: zone.groupId }), error: null };
    case 'edge': {
      // `splitGroup` режет только вправо и вниз, а `moveTab` берёт лишь открытую
      // вкладку: сначала открыть в цели, затем перенести к краю — одной
      // операцией, чтобы отказ второй шага вернул прежнюю раскладку целиком.
      const opened = openTab(layout, tab, { groupId: zone.groupId });
      const moved = moveTab(opened, tab.id, { groupId: zone.groupId, edge: zone.edge }, sizes);
      if (moved.error !== null) return { layout, error: moved.error };
      // `openTab` сделал новую вкладку активной в цели, а после её ухода
      // активным стал бы сосед — вернуть цели её прежнюю вкладку, фокус же
      // оставить на новой группе.
      if (target.activeTabId === null || moved.layout.activeGroupId === zone.groupId) return moved;
      const newGroupId = moved.layout.activeGroupId;
      return {
        layout: focusGroup(focusTab(moved.layout, target.activeTabId), newGroupId),
        error: null,
      };
    }
  }
}

/** Точка указателя на момент события: старт плюс сдвиг, иначе центр перетаскиваемого. */
function pointerOf(
  event: Pick<DragEndEvent, 'activatorEvent' | 'delta' | 'active'>,
): { x: number; y: number } | null {
  const start = event.activatorEvent as (Event & { clientX?: unknown; clientY?: unknown }) | null;
  if (start !== null && typeof start.clientX === 'number' && typeof start.clientY === 'number') {
    return { x: start.clientX + event.delta.x, y: start.clientY + event.delta.y };
  }
  const rect = event.active.rect.current.translated;
  return rect === null ? null : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Модификатор `DragOverlay`: центр оверлея — под указателем (по образцу
 * `snapCenterToCursor` из `@dnd-kit/modifiers`, без новой зависимости). Иначе
 * @dnd-kit ставит оверлей на прямоугольник источника и сдвигает на дельту
 * указателя, и ярлык отстаёт от курсора на расстояние от точки хвата до угла
 * источника (ревью B: ~97 px у строки сессии, ~56 px у вкладки).
 *
 * Берётся `activeNodeRect`, а не `draggingNodeRect`: обёртка оверлея стоит
 * ровно на прямоугольнике источника, а `draggingNodeRect` @dnd-kit меряет
 * у уже сдвинутой обёртки — на порог активации (4 px) и мимо.
 */
export const centerOverlayOnCursor: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
  const start = activatorEvent as (Event & { clientX?: unknown; clientY?: unknown }) | null;
  if (activeNodeRect === null || start === null) return transform;
  if (typeof start.clientX !== 'number' || typeof start.clientY !== 'number') return transform;
  return {
    ...transform,
    x: transform.x + start.clientX - activeNodeRect.left - activeNodeRect.width / 2,
    y: transform.y + start.clientY - activeNodeRect.top - activeNodeRect.height / 2,
  };
};

/** onDragEnd @dnd-kit → что бросили (`active.data`) и куда (`over.data` — DropTargetData, + zoneForPoint); null — мимо зон. */
export function dropFromDragEnd(event: DragEndEvent): { item: DragItem; zone: DropZone } | null {
  const item = dragItemOf(event.active.data.current);
  const over = event.over;
  if (item === null || over === null) return null;
  const data: unknown = over.data.current;
  if (!isDropTarget(data)) return null;
  const point = pointerOf(event);
  switch (data.kind) {
    case 'session-row':
    case 'room-row':
      // Бросок в сайдбар — не в раскладку: его разбирает `sidebarDropFromDragEnd`.
      return null;
    case 'terminal':
      return { item, zone: { kind: 'terminal', sessionId: data.sessionId } };
    case 'body':
      return {
        item,
        zone:
          point === null
            ? { kind: 'center', groupId: data.groupId }
            : zoneForPoint(point, over.rect, data.groupId),
      };
    case 'strip': {
      // Над вкладкой (у неё в `data` свой предмет) правая половина — место
      // после неё; хвост строки несёт готовый индекс.
      const overTab = dragItemOf(data) !== null;
      const after = overTab && point !== null && point.x > over.rect.left + over.rect.width / 2;
      return {
        item,
        zone: { kind: 'strip', groupId: data.groupId, index: data.index + (after ? 1 : 0) },
      };
    }
  }
}

/**
 * Бросок сессии на строку сайдбара (2.5): какая сессия, на какую строку и в какой работе (`workKey` строки-цели).
 * `null` — бросок не сессии или не на строку сайдбара. Можно ли такой бросок и что он значит, решает
 * `resolveSidebarDrop` (`dnd-sidebar.ts`): здесь только разбор события.
 */
export function sidebarDropFromDragEnd(
  event: DragEndEvent,
): { workKey: string; sessionId: string; target: SidebarTarget } | null {
  const item = dragItemOf(event.active.data.current);
  const over: unknown = event.over?.data.current;
  if (item?.kind !== 'session' || !isDropTarget(over)) return null;
  switch (over.kind) {
    case 'session-row':
      return { workKey: over.workKey, sessionId: item.sessionId, target: { kind: 'session-row', sessionId: over.sessionId } };
    case 'room-row':
      return { workKey: over.workKey, sessionId: item.sessionId, target: { kind: 'room-row', roomId: over.roomId } };
    default:
      return null;
  }
}
