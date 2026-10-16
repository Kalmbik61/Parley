/**
 * История поля ввода Chat (спека 2026-10-16, 3.2): свои сообщения сессии, новые первыми, одинаковые подряд — одно.
 * Источник — промпты ленты (переживают перезапуск: лента приходит из журнала), за ними — ещё не пришедшие в ленту
 * (серые «Queued» и очередь окна). Отдельно ничего не хранится.
 */

import type { FeedItem } from '@parley/core';

export function promptHistory(items: readonly FeedItem[], later: readonly string[]): string[] {
  const all = [...items.flatMap((item) => (item.kind === 'prompt' ? [item.text] : [])), ...later]
    .map((text) => text.trim())
    .filter((text) => text !== '');
  const newestFirst: string[] = [];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const text = all[index] as string;
    if (newestFirst.at(-1) !== text) newestFirst.push(text);
  }
  return newestFirst;
}
