import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LIMITS,
  ContextBudgetError,
  assertWithinBudget,
  boundResponse,
  contextBytes,
  inlineOrRef,
  markedExcerpt,
  textHash,
} from './context-budget.js';

describe('счёт размера', () => {
  it('UTF-8: кириллица — два байта на знак, эмодзи — четыре', () => {
    expect(contextBytes('abc')).toBe(3);
    expect(contextBytes('привет')).toBe(12);
    expect(contextBytes('😀')).toBe(4);
  });

  it('экранирование: кавычка, обратная косая и управляющий знак весят больше своих байтов', () => {
    expect(contextBytes('"')).toBe(2);
    expect(contextBytes('\\')).toBe(2);
    expect(contextBytes('\n')).toBe(2);
    // U+0001 в JSON — шесть байт: так он уйдёт строкой TOML в Codex.
    expect(contextBytes('\u0001')).toBe(6);
    expect(contextBytes('\u0001'.repeat(100))).toBe(600);
  });

  it('хеш — по полному тексту и короткий', () => {
    expect(textHash('a')).toMatch(/^[0-9a-f]{12}$/);
    expect(textHash('a')).not.toBe(textHash('b'));
    expect(textHash('a')).toBe(textHash('a'));
  });
});

describe('inlineOrRef', () => {
  it('в пределах — текст как есть, ровно на границе тоже', () => {
    expect(inlineOrRef('goal', 'short', 5, 'get_map')).toBe('short');
    expect(inlineOrRef('goal', 'short!', 5, 'get_map')).not.toBe('short!');
  });

  it('цель в 100 тыс. знаков одной строкой не обходит бюджет: вместо неё ссылка с размером и хешем', () => {
    const goal = 'x'.repeat(100_000);
    const out = inlineOrRef('goal', goal, CONTEXT_LIMITS.goal, 'get_map (work.goal)');
    expect(contextBytes(out)).toBeLessThan(300);
    expect(out).toContain('100000 bytes');
    expect(out).toContain(textHash(goal));
    expect(out).toContain('get_map (work.goal)');
    expect(out).not.toContain('xxxx');
  });

  it('многобайтовый и экранируемый текст считается байтами, а не знаками', () => {
    // 3000 кириллических букв — 6000 байт при 3000 знаках.
    expect(inlineOrRef('task', 'я'.repeat(3000), 4096, 'get_map')).toContain('6000 bytes');
    // 1000 управляющих знаков — 6000 байт после экранирования.
    expect(inlineOrRef('task', '\u0001'.repeat(1000), 4096, 'get_map')).toContain('6000 bytes');
  });
});

describe('markedExcerpt', () => {
  it('влезло — не тронуто; иначе начало по границе символа с пометкой и полным размером', () => {
    expect(markedExcerpt('short', 10)).toEqual({ text: 'short', cut: false });
    const out = markedExcerpt('я'.repeat(100), 21);
    expect(out.cut).toBe(true);
    expect(out.text.startsWith('я'.repeat(10))).toBe(true);
    expect(out.text).toMatch(/… \[cut: 200 bytes in full\]$/);
    // Суррогатная пара не разорвана.
    expect(markedExcerpt('😀'.repeat(10), 9).text.startsWith('😀😀')).toBe(true);
    expect(markedExcerpt('😀'.repeat(10), 9).text).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
  });
});

describe('отказ и ограниченный ответ', () => {
  it('assertWithinBudget: в пределах молчит, сверх — ошибка с блоком, размером и потолком', () => {
    expect(() => assertWithinBudget('brief', 'ok', 10)).not.toThrow();
    try {
      assertWithinBudget('brief', 'x'.repeat(11), 10);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContextBudgetError);
      expect(error).toMatchObject({ code: 'context-budget-exceeded', block: 'brief', bytes: 11, limit: 10 });
    }
  });

  it('boundResponse: влез — тот же текст, не влез — короткий ответ вместо обрезанного', () => {
    expect(boundResponse('abc', 10, () => 'fallback')).toBe('abc');
    const out = boundResponse('x'.repeat(50), 10, (bytes) => `too big: ${bytes}`);
    expect(out).toBe('too big: 50');
  });
});
