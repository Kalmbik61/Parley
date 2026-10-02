/**
 * Идёт ли ход — вывод из одних элементов ленты. Нужен и окну (Stop, Queue, «Working…»), и хосту: журнал,
 * оборванный посреди хода, после сева иначе оставлял бы ленту «в ходе» навсегда.
 */

import type { FeedItem } from './types.js';

/**
 * Ход идёт: после последнего `turn`/`error` есть промпт, вызов в работе или текст, который ещё пишется.
 * Карточки субагентов в счёт не идут: фоновый агент живёт и после конца хода родителя (решение 13).
 *
 * Промпт-слеш-команда (`/exit`, `/clear`, `/model`), после которой нет ничего, кроме `notice` и `turn`,
 * хода не открывает: локальная команда CLI не шлёт `Stop`, и без этого простаивающая сессия навсегда
 * осталась бы «в ходе» (Stop и Queue). Слеш-команда, за которой пошёл ответ (`/review`), — обычный ход.
 */
export function turnActive(items: readonly FeedItem[]): boolean {
  /** После текущей позиции — только `notice`. */
  let quiet = true;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (item.kind === 'turn' || item.kind === 'error') return false;
    if (item.kind === 'prompt') {
      if (quiet && item.text.trim().startsWith('/')) continue;
      return true;
    }
    if (item.kind !== 'notice') quiet = false;
    if (item.kind === 'tool' && item.status === 'running') return true;
    if (item.kind === 'text' && item.streaming) return true;
  }
  return false;
}
