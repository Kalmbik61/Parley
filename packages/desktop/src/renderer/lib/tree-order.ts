/**
 * Порядок сессий работы: дерево по `parent`, в порядке создания. Перенесено из
 * ушедшего `tui/src/work-rows.ts` (`treeOrder`, `sessionSequence`) дословно
 * (дизайн TUI v2, 2.1).
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import { workKey } from '../../shared/work-keys.js';

// Формат ключа один на main и рендерер (кусок 5.2): прежние импорты отсюда остаются.
export { workKey };

/** Сессии деревом: корни по порядку создания, дети сразу под родителем. */
export function treeOrder(
  sessions: readonly WorkSession[],
): Array<{ session: WorkSession; depth: number }> {
  const children = new Map<string, WorkSession[]>();
  const known = new Set(sessions.map((session) => session.id));
  const roots: WorkSession[] = [];

  for (const session of sessions) {
    // Порождённая сессия, чьего родителя в карте нет, — всё равно корень: иначе
    // она пропала бы из списка.
    if (session.parent !== null && known.has(session.parent)) {
      const list = children.get(session.parent);
      if (list === undefined) children.set(session.parent, [session]);
      else list.push(session);
    } else {
      roots.push(session);
    }
  }

  const out: Array<{ session: WorkSession; depth: number }> = [];
  const walk = (session: WorkSession, depth: number): void => {
    out.push({ session, depth });
    for (const child of children.get(session.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** Все сессии сайдбара одной работы сверху вниз, по дереву `treeOrder`. */
export function sessionSequence(
  workKeys: readonly string[],
  orders: ReadonlyMap<string, readonly string[]>,
): { work: string; session: string }[] {
  return workKeys.flatMap((work) => (orders.get(work) ?? []).map((session) => ({ work, session })));
}

export function sessionOrders(entries: readonly WorkEntry[]): Map<string, string[]> {
  return new Map(
    entries.map((entry) => [
      workKey(entry.projectPath, entry.map.work.id),
      treeOrder(entry.map.sessions).map((item) => item.session.id),
    ]),
  );
}
