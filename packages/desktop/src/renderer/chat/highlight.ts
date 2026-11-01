/**
 * Подсветка совпадений поиска в ленте (план 2026-11-01, задача 9) через CSS Custom Highlight API: текст не
 * разбивается на `<mark>`, разметка элементов ленты не трогается. Цвета — `::highlight(chat-find)` в `styles.css`.
 *
 * Подсвечивается то, что сейчас в DOM: виртуальный список держит только видимые строки. Номер текущего совпадения
 * в строке — по порядку отрисованного текста; счётчик панели считает по модели (`find.ts`), поэтому у Markdown
 * (`**x**` в исходнике, `x` на экране) номера могут разойтись — тогда берётся последнее найденное вхождение строки.
 * Не считаются и не подсвечиваются свёрнутая тень группы (`hidden`), сводка вызова (она повторена во входе), дифф
 * (заплатки не ищутся) и подписи-обвязка (`data-find-label`: «Arguments», «Result», «Changes»: в модели поиска их нет). Без API (jsdom, старый Chromium) функции ничего не делают.
 */

import { normalizeQuery } from './find.js';

const MATCH = 'chat-find';
const ACTIVE = 'chat-find-active';
/** Текст, который не подсвечивается и не считается (см. шапку). */
const SKIP = '[hidden], [data-tool-summary], [data-testid="chat-diff"], [data-find-label]';

interface Api {
  registry: Map<string, unknown>;
  make: (ranges: Range[]) => unknown;
}

function api(): Api | null {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (css?.highlights === undefined || ctor === undefined) return null;
  return { registry: css.highlights, make: (ranges) => new ctor(...ranges) };
}

export function clearFindHighlights(): void {
  const found = api();
  found?.registry.delete(MATCH);
  found?.registry.delete(ACTIVE);
}

/** Подсветить все вхождения `query` в строках ленты под `root`; `active` — вхождение, которое сейчас выбрано. */
export function applyFindHighlights(root: HTMLElement, query: string, active: { itemId: string; nth: number } | null): void {
  const found = api();
  if (found === null) return;
  const needle = normalizeQuery(query);
  if (needle === '') {
    clearFindHighlights();
    return;
  }
  const all: Range[] = [];
  let current: Range | null = null;
  for (const row of root.querySelectorAll<HTMLElement>('[data-feed-id]')) {
    const own: Range[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) {
      const node = next as Text;
      if (node.parentElement?.closest(SKIP) != null) continue;
      const haystack = node.data.toLowerCase();
      // Строчные буквы иной длины (İ) сдвинули бы смещения.
      if (haystack.length !== node.data.length) continue;
      for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        own.push(range);
      }
    }
    all.push(...own);
    if (active !== null && row.getAttribute('data-feed-id') === active.itemId && own.length > 0) {
      current = own[Math.min(active.nth, own.length - 1)] ?? null;
    }
  }
  if (all.length === 0) {
    clearFindHighlights();
    return;
  }
  found.registry.set(MATCH, found.make(all));
  if (current === null) found.registry.delete(ACTIVE);
  else found.registry.set(ACTIVE, found.make([current]));
}
