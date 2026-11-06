import { describe, expect, it } from 'vitest';
import { createLevelSource } from './level-source.js';

describe('createLevelSource', () => {
  it('держит значение и будит подписчиков только при смене', () => {
    const source = createLevelSource();
    const seen: number[] = [];
    const off = source.subscribe((level) => seen.push(level));
    expect(source.get()).toBe(0);
    source.set(0.4);
    source.set(0.4);
    source.set(0);
    expect(seen).toEqual([0.4, 0]);
    off();
    source.set(0.9);
    expect(seen).toEqual([0.4, 0]);
    expect(source.get()).toBe(0.9);
  });
});
