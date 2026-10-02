/**
 * Предел вложенности цитат Markdown (Parley 0.3.0): текст глубже `QUOTE_DEPTH_MAX` не разбирается как Markdown —
 * лента, почта, выдержка цитаты и поиск `@human` читают его сырым.
 */

import { describe, expect, it } from 'vitest';
import { QUOTE_DEPTH_MAX, markdownTooDeep } from './markdown-depth.js';

describe('markdownTooDeep — вложенность цитат', () => {
  it('предел — 100: ровно 100 «>» ещё Markdown, 101 — уже нет', () => {
    expect(QUOTE_DEPTH_MAX).toBe(100);
    expect(markdownTooDeep(`${'>'.repeat(100)} текст`)).toBe(false);
    expect(markdownTooDeep(`${'>'.repeat(101)} текст`)).toBe(true);
  });

  it('«>» через пробелы и после отступа — та же вложенность', () => {
    expect(markdownTooDeep(`  ${'> '.repeat(101)}текст`)).toBe(true);
    expect(markdownTooDeep(`\t${'> '.repeat(100)}текст`)).toBe(false);
  });

  it('глубокая строка где угодно в тексте — весь текст не Markdown', () => {
    expect(markdownTooDeep(`обычная строка\n\n${'>'.repeat(150)} глубоко\nещё строка`)).toBe(true);
    expect(markdownTooDeep(`первая\r\n${'>'.repeat(150)}`)).toBe(true);
  });

  it('«>» не в начале строки и обычные тексты — не вложенность', () => {
    for (const text of ['', 'a > b', `x ${'>'.repeat(300)}`, '> цитата\n>> вложенная', '`>>>`']) {
      expect(markdownTooDeep(text), text).toBe(false);
    }
  });
});
