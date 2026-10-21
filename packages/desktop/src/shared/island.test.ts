import { METHODS } from '@parley/protocol';
import { describe, expect, it } from 'vitest';
import { ISLAND_EVENTS, ISLAND_MARK_SEEN_LIMIT, ISLAND_METHODS, markSeenBatches } from './island.js';

describe('остров: белый список методов хоста', () => {
  it('каждое имя из ISLAND_METHODS — метод протокола (опечатка не оставит остров без данных молча)', () => {
    const known = new Set<string>(Object.keys(METHODS));
    for (const method of ISLAND_METHODS) expect(known.has(method), method).toBe(true);
  });

  it('согласия на папку: остров вызывает consents.list / consents.decide и получает consents.changed', () => {
    expect(ISLAND_METHODS.has('consents.list')).toBe(true);
    expect(ISLAND_METHODS.has('consents.decide')).toBe(true);
    expect(ISLAND_EVENTS.has('consents.changed')).toBe(true);
  });
});

describe('markSeenBatches: длинный Clear уходит порциями (2026-10-15)', () => {
  const refs = (count: number) => Array.from({ length: count }, (_, at) => ({ projectPath: '/p', workId: 'w-1', sessionId: `s-${at}` }));

  it('пусто — ни одной порции', () => {
    expect(markSeenBatches([])).toEqual([]);
  });

  it('до предела — одна порция, больше — по ISLAND_MARK_SEEN_LIMIT, ничего не теряется', () => {
    expect(markSeenBatches(refs(ISLAND_MARK_SEEN_LIMIT))).toHaveLength(1);
    const batches = markSeenBatches(refs(ISLAND_MARK_SEEN_LIMIT * 2 + 1));
    expect(batches.map((batch) => batch.length)).toEqual([ISLAND_MARK_SEEN_LIMIT, ISLAND_MARK_SEEN_LIMIT, 1]);
    expect(batches.flat()).toEqual(refs(ISLAND_MARK_SEEN_LIMIT * 2 + 1));
  });
});
