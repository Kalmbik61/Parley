/** Тест 2 куска 3.3: относительное время в карточке и строке сессии (спека 6.3, en-US). */

import { describe, expect, it } from 'vitest';
import { relativeTime, relativeTimeAgo } from './relative-time.js';

// Местное время: «вчера» и «этот год» — календарные, в поясе окна.
const now = new Date(2026, 8, 27, 15, 0, 0);
const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('relativeTime', () => {
  it('30 с → now, 3 мин → 3m, 2 ч → 2h', () => {
    expect(relativeTime(ago(30_000), now)).toBe('now');
    expect(relativeTime(ago(3 * MIN), now)).toBe('3m');
    expect(relativeTime(ago(2 * HOUR), now)).toBe('2h');
  });

  it('вчерашняя дата → yesterday', () => {
    expect(relativeTime(new Date(2026, 8, 26, 9, 0, 0).toISOString(), now)).toBe('yesterday');
  });

  it('дата этого года → Sep 26 без года, прошлого — Sep 26, 2025', () => {
    expect(relativeTime(new Date(2026, 8, 20, 12, 0, 0).toISOString(), now)).toBe('Sep 20');
    expect(relativeTime(new Date(2025, 8, 26, 12, 0, 0).toISOString(), now)).toBe('Sep 26, 2025');
  });

  it('границы: 59 с — now, 59 мин — 59m, 23 ч — 23h, время из будущего — now', () => {
    expect(relativeTime(ago(59_000), now)).toBe('now');
    expect(relativeTime(ago(59 * MIN), now)).toBe('59m');
    expect(relativeTime(ago(60 * MIN), now)).toBe('1h');
    expect(relativeTime(ago(23 * HOUR), now)).toBe('23h');
    expect(relativeTime(new Date(now.getTime() + 5 * MIN).toISOString(), now)).toBe('now');
  });

  it('не-ISO строка — пусто, а не «Invalid Date»', () => {
    expect(relativeTime('w-9999', now)).toBe('');
  });
});

// Правки ревью куска 2: карточка неживой сессии (1.8) пишет `Claude Code · last event 3h ago`.
describe('relativeTimeAgo — для фразы «last event …»', () => {
  it('минуты и часы — с «ago»: 3m → 3m ago, 2h → 2h ago', () => {
    expect(relativeTimeAgo(ago(3 * MIN), now)).toBe('3m ago');
    expect(relativeTimeAgo(ago(2 * HOUR), now)).toBe('2h ago');
  });

  it('now, yesterday и дата — как в relativeTime, без «ago»', () => {
    expect(relativeTimeAgo(ago(30_000), now)).toBe('now');
    expect(relativeTimeAgo(new Date(2026, 8, 26, 9, 0, 0).toISOString(), now)).toBe('yesterday');
    expect(relativeTimeAgo(new Date(2026, 8, 20, 12, 0, 0).toISOString(), now)).toBe('Sep 20');
  });

  it('не-ISO строка — пусто', () => {
    expect(relativeTimeAgo('w-9999', now)).toBe('');
  });
});
