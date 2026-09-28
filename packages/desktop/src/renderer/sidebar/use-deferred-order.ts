/**
 * Отложенная пересортировка сайдбара (спека 6.2): карточка не должна уезжать из-под
 * курсора. Хук держит только порядок ключей, данные карточек всегда свежие.
 */

import { useEffect, useRef, useState } from 'react';
import type { SidebarSection } from './sort.js';
import { workKey } from '../lib/tree-order.js';

/** Порядок: ключи секций и ключи работ в каждой секции. */
interface Order {
  sections: string[];
  works: Record<string, string[]>;
}

function orderOf(sections: SidebarSection[]): Order {
  const works: Record<string, string[]> = {};
  for (const section of sections) {
    works[section.key] = section.works.map((entry) => workKey(entry.projectPath, entry.map.work.id));
  }
  return { sections: sections.map((section) => section.key), works };
}

/** Элементы в прежнем порядке; новых там не было — они в конец, в свежем порядке. */
function arrange<T>(items: T[], keyOfItem: (item: T) => string, held: string[] | undefined): T[] {
  if (held === undefined) return items;
  const position = new Map(held.map((key, index) => [key, index]));
  const known = items.filter((item) => position.has(keyOfItem(item)));
  known.sort((a, b) => position.get(keyOfItem(a))! - position.get(keyOfItem(b))!);
  return [...known, ...items.filter((item) => !position.has(keyOfItem(item)))];
}

/**
 * Пока указатель над списком, отдаёт свежие секции в прежнем порядке ключей: секций (`key`) и
 * работ в них (`workKey`). Новый порядок — после ухода указателя или через maxDeferMs.
 */
export function useDeferredOrder(sections: SidebarSection[], hovering: boolean, maxDeferMs = 3000): SidebarSection[] {
  const [held, setHeld] = useState<Order>(() => orderOf(sections));
  const freshSignature = JSON.stringify(orderOf(sections));
  const same = freshSignature === JSON.stringify(held);
  // Таймер срабатывает позже рендера, который его завёл: к тому времени порядок мог смениться ещё раз.
  const latest = useRef(freshSignature);
  latest.current = freshSignature;

  useEffect(() => {
    if (same) return;
    // Без указателя прежний порядок догоняет свежий сразу: следующее наведение держит то, что на экране.
    if (!hovering) {
      setHeld(JSON.parse(latest.current) as Order);
      return;
    }
    // Таймер идёт от первого расхождения: новые изменения под указателем его не продлевают,
    // потому что `same` остаётся false и эффект не перезапускается.
    const timer = setTimeout(() => setHeld(JSON.parse(latest.current) as Order), maxDeferMs);
    return () => clearTimeout(timer);
  }, [hovering, same, maxDeferMs]);

  if (!hovering || same) return sections;
  return arrange(sections, (section) => section.key, held.sections).map((section) => ({
    ...section,
    works: arrange(
      section.works,
      (entry) => workKey(entry.projectPath, entry.map.work.id),
      held.works[section.key],
    ),
  }));
}
