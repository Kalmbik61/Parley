import { describe, expect, it } from 'vitest';
import { fuzzyScore } from './fuzzy.js';

describe('fuzzyScore (тест 1)', () => {
  it('находит «s03» в «S03 бэкенд» без учёта регистра', () => {
    expect(fuzzyScore('s03', 'S03 бэкенд')).not.toBeNull();
  });

  it('находит подпоследовательность внутри другого слова — «плат» в работе «Платежи»', () => {
    expect(fuzzyScore('плат', 'Платежи')).not.toBeNull();
  });

  it('сплошное совпадение оценивается выше разрывного', () => {
    const contiguous = fuzzyScore('ab', 'xx ab yy');
    const broken = fuzzyScore('ab', 'xx a-b yy');

    expect(contiguous).not.toBeNull();
    expect(broken).not.toBeNull();
    expect(contiguous as number).toBeGreaterThan(broken as number);
  });

  it('запрос длиннее текста или без подпоследовательности — null', () => {
    expect(fuzzyScore('abcdef', 'ab')).toBeNull();
    expect(fuzzyScore('xyz', 'abc')).toBeNull();
  });

  it('пустой запрос совпадает всегда, с нулевой оценкой', () => {
    expect(fuzzyScore('', 'что угодно')).toBe(0);
  });
});
