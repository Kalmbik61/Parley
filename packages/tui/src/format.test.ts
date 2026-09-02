import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRelative,
  formatTokenPair,
  formatTokens,
  truncate,
  visibleWindow,
} from './format.js';

describe('formatDuration', () => {
  it('масштабирует единицы', () => {
    expect(formatDuration(45_000)).toBe('45с');
    expect(formatDuration(12 * 60_000)).toBe('12м');
    expect(formatDuration(64 * 60_000)).toBe('1ч 4м');
    expect(formatDuration(2 * 3_600_000)).toBe('2ч');
    expect(formatDuration(3 * 86_400_000)).toBe('3д');
    expect(formatDuration(3 * 86_400_000 + 2 * 3_600_000)).toBe('3д 2ч');
  });

  it('нет данных — прочерк', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('форма зависит от давности', () => {
    expect(formatRelative(ago(10_000), now)).toBe('сейчас');
    expect(formatRelative(ago(17 * 60_000), now)).toBe('17м');
    expect(formatRelative(ago(5 * 3_600_000), now)).toBe('5ч');
    expect(formatRelative(ago(30 * 3_600_000), now)).toBe('вчера');
    expect(formatRelative(ago(3 * 86_400_000), now)).toBe('3д');
  });

  it('мусор и пустота дают прочерк', () => {
    expect(formatRelative(null, now)).toBe('—');
    expect(formatRelative('не дата', now)).toBe('—');
  });
});

describe('truncate', () => {
  it('режет только то, что не влезает', () => {
    expect(truncate('коротко', 20)).toBe('коротко');
    expect(truncate('это довольно длинная строка', 10)).toBe('это довол…');
    expect(truncate('что угодно', 0)).toBe('');
  });
});

describe('visibleWindow', () => {
  it('держит выбранную строку в середине окна', () => {
    expect(visibleWindow(100, 50, 10)).toEqual({ start: 45, end: 55 });
  });

  it('не выходит за начало и конец списка', () => {
    expect(visibleWindow(100, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(100, 99, 10)).toEqual({ start: 90, end: 100 });
  });

  it('список короче окна показывается целиком', () => {
    expect(visibleWindow(3, 1, 10)).toEqual({ start: 0, end: 3 });
  });

  it('пустой список и нулевая высота', () => {
    expect(visibleWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(10, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('formatTokens', () => {
  it('до тысячи — как есть, дальше к и М (дизайн 6.3)', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(845)).toBe('845');
    expect(formatTokens(1_200)).toBe('1.2к');
    expect(formatTokens(45_000)).toBe('45к');
    expect(formatTokens(1_100_000)).toBe('1.1М');
    expect(formatTokens(12_400_000)).toBe('12М');
  });

  it('на границе тысячи «к» не превращается в 1000к', () => {
    expect(formatTokens(999_600)).toBe('1.0М');
  });
});

describe('formatTokenPair', () => {
  it('вход/выход без глифов, кэш не показывается', () => {
    expect(
      formatTokenPair({ input: 1_200, output: 845, cacheRead: 500_000, cacheWrite: 3_000 }),
    ).toBe('1.2к/845');
  });

  it('токенов нет — прочерк', () => {
    expect(formatTokenPair(null)).toBe('—');
  });
});
