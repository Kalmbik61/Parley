/**
 * Строка сайдбара как цель броска сессии (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5): строка сессии вне
 * комнат и строка комнаты. Droppable включён, только пока тащат сессию и бросок на эту строку возможен
 * (`layout/dnd-sidebar.ts#resolveSidebarDrop`): на себя, в свою комнату, закрытую сессию, в другую работу — выключен,
 * поэтому `layoutCollision` его не видит, а строка не подсвечивается. `over` — цель подсвечивается: фон `accent 14%` и
 * inset-рамка 1.5px (цвета — `DROP_TARGET_FILL` ниже).
 *
 * Возможность считает селектор стора работ: он возвращает булево и перерисовывает строку, только когда оно сменилось
 * (в покое, без броска, он не считает ничего). Хост без нужного метода целей не даёт: комната из двух сессий — `rooms.create`,
 * ввод в комнату — `rooms.addMember` (окно прячет функцию, если метода нет, спека Orca-UI 3.2).
 */

import { useMemo } from 'react';
import { useDndContext, useDroppable } from '@dnd-kit/core';
import { boardProjects, findBacklogCard, type BoardCard } from '../board/board-model.js';
import { useBoardStore } from '../board/board-store.js';
import { dndId, dragItemOf, type CardDropTarget, type ComposerTarget, type DropTargetData, type FeedTarget, type SidebarTarget } from '../layout/dnd.js';
import { resolveCardDrop, resolveSidebarDrop } from '../layout/dnd-sidebar.js';
import { useDragStore } from '../layout/drag-store.js';
import { useLayoutStore } from '../layout/store.js';
import { useHostSupports } from '../lib/capabilities.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';

/**
 * Карточка Backlog в руке: `dragging` — тащат именно карточку, `card` — она же, найденная в сторе доски (`null` — без
 * карточки в руке или она пропала).
 *
 * Предмет берётся из стора жеста (`layout/drag-store.ts`), а не из `useDndContext()`: тот меняется на каждое движение
 * указателя и перерисовывал бы ленты и терминалы на любое перетаскивание. Селектор отдаёт только карточку: вкладка,
 * сессия и файл в руке читателя не будят.
 *
 * Снимки доски читаются, только пока тащат карточку: без неё селекторы отдают стабильное `null`, и обновление бэклога
 * не перерисовывает ни ленты, ни терминалы, ни строки.
 */
function useDraggedCard(): { dragging: boolean; card: BoardCard | null } {
  const dragged = useDragStore((state) => {
    const item = state.item;
    return item?.kind === 'card' ? item : null;
  });
  const slots = useBoardStore((state) => (dragged === null ? null : state.slots));
  const inboxPath = useBoardStore((state) => (dragged === null ? null : state.inboxPath));
  const card = useMemo(
    () => (dragged === null || slots === null ? null : findBacklogCard(boardProjects(slots, inboxPath), dragged.projectPath, dragged.id, dragged.index, dragged.title)),
    [dragged, slots, inboxPath],
  );
  return { dragging: dragged !== null, card };
}

/**
 * Можно ли бросить на `target` карточку Backlog, которую тащат сейчас (карточка ищется в сторе доски, цель — среди
 * живых целей её проекта). Без карточки в руке — `false`; считает селектор, перерисовка только при смене булева.
 */
function useCardDropPossible(workKey: string, target: CardDropTarget, enabled: boolean): boolean {
  const { card } = useDraggedCard();
  return useWorksStore((state) => enabled && card !== null && resolveCardDrop(card, target, workKey, state.entries) !== null);
}

/**
 * Тащат карточку Backlog, а в терминал этой сессии её не отправить (другой проект, закрытая сессия): терминал тогда
 * выключен. Иначе он выиграл бы коллизию у других целей (`layoutCollision`), и бросок пропал бы молча. Файл, вкладка
 * и сессия в руке — `false`: для них терминал работает как раньше.
 */
export function useCardBlocksTerminal(workKey: string, sessionId: string): boolean {
  const { dragging, card } = useDraggedCard();
  return useWorksStore(
    (state) => dragging && (card === null || resolveCardDrop(card, { kind: 'terminal', sessionId }, workKey, state.entries) === null),
  );
}

/** Лента открытой комнаты или Chat как цель броска карточки доски; подсвечена, только пока бросок на неё возможен. */
export function useFeedDropTarget(workKey: string, owner: { roomId: string } | { sessionId: string }): { setNodeRef: (node: HTMLElement | null) => void; over: boolean } {
  const target: FeedTarget = 'roomId' in owner ? { kind: 'feed', roomId: owner.roomId } : { kind: 'feed', sessionId: owner.sessionId };
  const possible = useCardDropPossible(workKey, target, true);
  const data: DropTargetData = { workKey, ...target };
  const { setNodeRef, isOver } = useDroppable({ id: dndId.feed(workKey, 'roomId' in owner ? owner.roomId : owner.sessionId), data, disabled: !possible });
  return { setNodeRef, over: possible && isOver };
}

/**
 * Поле ввода комнаты или Chat как цель броска карточки доски: карточка становится в нём черновиком. Включено, только
 * пока бросок возможен (тот же `resolveCardDrop`, что у ленты). `owner` — `null`, когда владельца поля не определить:
 * цель выключена. Нативный drop текста и файлов в поле не затронут.
 */
export function useComposerDropTarget(
  workKey: string,
  owner: { roomId: string } | { sessionId: string } | null,
): { setNodeRef: (node: HTMLElement | null) => void; over: boolean } {
  const target: ComposerTarget | null = owner === null ? null : 'roomId' in owner ? { kind: 'composer', roomId: owner.roomId } : { kind: 'composer', sessionId: owner.sessionId };
  const possible = useCardDropPossible(workKey, target ?? { kind: 'composer', roomId: '' }, target !== null);
  const ownerId = owner === null ? '' : 'roomId' in owner ? owner.roomId : owner.sessionId;
  const data: DropTargetData = { workKey, ...(target ?? { kind: 'composer', roomId: '' }) };
  const { setNodeRef, isOver } = useDroppable({ id: dndId.composer(workKey, ownerId), data, disabled: !possible });
  return { setNodeRef, over: possible && isOver };
}

export function useSidebarDropTarget(
  workKey: string,
  target: SidebarTarget,
  /** `false` — строка не цель вовсе (строка участника комнаты: её принимает строка комнаты целиком). */
  enabled = true,
): { setNodeRef: (node: HTMLElement | null) => void; over: boolean } {
  const { active } = useDndContext();
  const item = dragItemOf(active?.data.current);
  const dragged = item?.kind === 'session' ? item.sessionId : null;
  // Строки других карточек сессию не принимают: тащить можно только строки активной работы, а id сессий у работ одни и те же.
  const inActiveWork = useLayoutStore((state) => state.activeWorkKey === workKey);
  const hostAllows = useHostSupports(target.kind === 'room-row' ? 'rooms.addMember' : 'rooms.create');
  const cardPossible = useCardDropPossible(workKey, target, enabled);
  const sessionPossible = useWorksStore((state) => {
    if (!enabled || dragged === null || !inActiveWork || !hostAllows) return false;
    const entry = state.entries.find((candidate) => workKeyOf(candidate.projectPath, candidate.map.work.id) === workKey);
    return entry !== undefined && resolveSidebarDrop(entry.map, dragged, target) !== null;
  });
  const possible = sessionPossible || cardPossible;
  const data: DropTargetData = { workKey, ...target };
  const id = target.kind === 'room-row' ? dndId.roomRow(workKey, target.roomId) : dndId.sessionRow(workKey, target.sessionId);
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled: !possible });
  return { setNodeRef, over: possible && isOver };
}

/**
 * Подсветка цели (2.5): фон `accent 14 %` и inset-рамка 1.5px. Рамка — `--primary`, а не чистый `accent`: в светлой
 * теме он к фону неактивной карточки 2.69:1, ниже порога 3:1 для признака состояния, а `--primary` там accent-700
 * (5.09:1 к карточке, 4.3:1 к заливке цели); в тёмной `--primary` и есть `accent`, как в спеке (`styles/tokens.test.ts`).
 */
export const DROP_TARGET_FILL =
  'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] shadow-[inset_0_0_0_1.5px_var(--primary)]';

/**
 * Текст на подсвеченной цели — основной цвет: указатель во время броска над щитом окна, `hover` строки не действует, а
 * вторичный цвет на заливке `accent 14 %` ниже 4.5:1.
 */
export const DROP_TARGET_INK = '[--work-sidebar-foreground:var(--color-text)] [--work-sidebar-muted-foreground:var(--color-text)]';
