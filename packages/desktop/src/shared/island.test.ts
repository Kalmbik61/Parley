import { METHODS } from '@parley/protocol';
import { describe, expect, it } from 'vitest';
import { ISLAND_METHODS } from './island.js';

describe('остров: белый список методов хоста', () => {
  it('каждое имя из ISLAND_METHODS — метод протокола (опечатка не оставит остров без данных молча)', () => {
    const known = new Set<string>(Object.keys(METHODS));
    for (const method of ISLAND_METHODS) expect(known.has(method), method).toBe(true);
  });
});
