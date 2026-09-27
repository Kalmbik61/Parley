/**
 * Ранжирование палитры ⌘J (кусок 6.2, спека 9.2): очки токена по полю, документа по
 * токенам и корзина свежести. Заменяет прежний `lib/fuzzy.ts`.
 *
 * Границы слов и смену регистра видно только в исходном поле, а сравнивать надо после
 * `normalize`. Поэтому `normalize` сохраняет длину строки (по кодовой единице): индексы
 * исходного поля и нормализованного совпадают.
 */

import type { PaletteDoc } from './documents.js';

/** Одна кодовая единица: нижний регистр, `ё` как `е`. Удлиняющую замену (`İ` → `i̇`) не берём — индексы разъехались бы. */
function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase();
  if (lower.length !== 1) return unit;
  return lower === 'ё' ? 'е' : lower; // cyrillic-ok: ё = е (спека 9.2)
}

/** Нижний регистр, `ё` → `е`; длина та же, что у исходной строки. */
export function normalize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) out += normalizeUnit(text.charAt(i));
  return out;
}

const BOUNDARY_CHARS = new Set(['/', '-', '_', '.']);

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isLower(char: string): boolean {
  return char !== char.toUpperCase() && char === char.toLowerCase();
}

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

/** Позиция `index` исходного поля — граница: после разделителя или на смене регистра `aB`. */
function isBoundary(field: string, index: number): boolean {
  const prev = field.charAt(index - 1);
  return BOUNDARY_CHARS.has(prev) || (isLower(prev) && isUpper(field.charAt(index)));
}

/** Нечёткое совпадение: символы токена по порядку; 10 минус 1 за каждый разрыв, не ниже 1; 0 — не нашлось. */
function fuzzyScore(token: string, field: string): number {
  let position = -1;
  let gaps = 0;
  for (const char of token) {
    const found = field.indexOf(char, position + 1);
    if (found === -1) return 0;
    if (position !== -1 && found > position + 1) gaps += 1;
    position = found;
  }
  return Math.max(1, 10 - gaps);
}

/** field — исходный текст поля: границы слов и смену регистра видно только до normalize; сравнение — после. */
export function scoreToken(token: string, field: string): number {
  const t = normalize(token);
  const f = normalize(field);
  if (t === '' || f === '') return 0;
  if (f === t) return 100;
  if (f.startsWith(t)) return 80;

  let best = 0;
  for (let index = f.indexOf(t, 1); index !== -1; index = f.indexOf(t, index + 1)) {
    if (isWhitespace(field.charAt(index - 1))) return 60;
    best = Math.max(best, isBoundary(field, index) ? 40 : 20);
  }
  if (best > 0) return best;
  return fuzzyScore(t, f);
}

/** Вес поля «название» (спека 9.2, п. 4). */
const TITLE_WEIGHT = 1.5;

/** Сумма очков токенов: у каждого — лучшее поле, название × 1.5; `null` — какой-то токен не совпал. */
export function scoreDocument(tokens: string[], doc: Pick<PaletteDoc, 'title' | 'fields'>): number | null {
  let total = 0;
  for (const token of tokens) {
    let best = scoreToken(token, doc.title) * TITLE_WEIGHT;
    for (const field of doc.fields) best = Math.max(best, scoreToken(token, field));
    if (best === 0) return null;
    total += best;
  }
  return total;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Корзины свежести: < 1 ч, < 1 сут, < 1 нед, старше или нет данных. */
export function recencyBucket(ageMs: number | null): 0 | 1 | 2 | 3 {
  if (ageMs === null) return 3;
  if (ageMs < HOUR_MS) return 0;
  if (ageMs < DAY_MS) return 1;
  if (ageMs < WEEK_MS) return 2;
  return 3;
}
