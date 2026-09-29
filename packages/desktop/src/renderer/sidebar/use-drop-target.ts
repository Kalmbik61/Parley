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

import { useDndContext, useDroppable } from '@dnd-kit/core';
import { dndId, dragItemOf, type DropTargetData, type SidebarTarget } from '../layout/dnd.js';
import { resolveSidebarDrop } from '../layout/dnd-sidebar.js';
import { useLayoutStore } from '../layout/store.js';
import { useHostSupports } from '../lib/capabilities.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';

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
  const possible = useWorksStore((state) => {
    if (!enabled || dragged === null || !inActiveWork || !hostAllows) return false;
    const entry = state.entries.find((candidate) => workKeyOf(candidate.projectPath, candidate.map.work.id) === workKey);
    return entry !== undefined && resolveSidebarDrop(entry.map, dragged, target) !== null;
  });
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
