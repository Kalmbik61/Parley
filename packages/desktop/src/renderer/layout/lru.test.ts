import { describe, expect, it } from 'vitest';
import { createLru } from './lru.js';

describe('createLru — тест 1 куска 2.5', () => {
  it('четвёртый ключ вытесняет первый', () => {
    const lru = createLru<string>(3);
    expect(lru.touch('a')).toEqual([]);
    expect(lru.touch('b')).toEqual([]);
    expect(lru.touch('c')).toEqual([]);
    expect(lru.touch('d')).toEqual(['a']);
    expect(lru.has('a')).toBe(false);
    expect(lru.keys()).toEqual(['d', 'c', 'b']);
  });

  it('повторное касание обновляет порядок', () => {
    const lru = createLru<string>(3);
    lru.touch('a');
    lru.touch('b');
    lru.touch('c');
    expect(lru.touch('a')).toEqual([]);
    expect(lru.keys()).toEqual(['a', 'c', 'b']);
    expect(lru.touch('d')).toEqual(['b']);
    expect(lru.has('a')).toBe(true);
  });

  it('remove убирает ключ — has ложно, в keys() его нет', () => {
    const lru = createLru<string>(3);
    lru.touch('a');
    lru.touch('b');
    lru.remove('a');
    expect(lru.has('a')).toBe(false);
    expect(lru.keys()).toEqual(['b']);
    lru.remove('нет такого');
    expect(lru.keys()).toEqual(['b']);
  });
});
