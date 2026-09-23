/**
 * Порядок сессий работы: дерево по `parent` и ключ работы (дизайн TUI v2, 2.1).
 *
 * Здесь нет ни файловой системы, ни Ink — только порядок и метрики, которые
 * сайдбар показывает под выбранной сессией.
 */

import {
  PROVIDERS,
  type ProviderInfo,
  type TokenTotals,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';

/**
 * Метрики, которые видны в списке. Пока сессия жива, карта их не хранит —
 * они считаются по логам провайдера; модель в карте не хранится никогда.
 */
export interface LiveMetrics {
  durationMs: number | null;
  tokens: TokenTotals | null;
  model: string | null;
  /**
   * Время последней записи в логе провайдера: от него ДЕТАЛИ считают «молчит Nм»
   * (дизайн 3). В карте его нет — только в индексе логов.
   */
  lastRecordAt: string | null;
}

/**
 * Набор провайдеров открыт: `providers.json` добавляет свои CLI, и подписи для
 * них в реестре нет — показываем сырой id, а не падаем.
 */
export const registryEntry = (provider: string): ProviderInfo | undefined =>
  (PROVIDERS as Record<string, ProviderInfo | undefined>)[provider];

export function providerMarkOf(provider: string): string {
  return registryEntry(provider)?.mark ?? provider;
}

/** Ключ работы: id уникален только внутри проекта. */
export function workKey(projectPath: string, workId: string): string {
  return `${projectPath} ${workId}`;
}

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

/**
 * Порядок сессий каждой работы: по нему ходят `j`/`k`, оверлей сайдбара и
 * починка выбора (дизайн TUI v2, 2.1 и 3.2).
 */
/** Все сессии сайдбара сверху вниз по работам: по ним ходят `prefix j`/`k` (3.2). */
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
