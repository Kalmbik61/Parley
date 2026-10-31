import { describe, expect, it } from 'vitest';
import { computeGuides, contentLeft, indentFor, trunkX } from './guides';

describe('computeGuides', () => {
  it('marks tees for non-last children and corners for the last', () => {
    // a (1), b (1) with child c (2), d (1)
    const g = computeGuides([1, 1, 2, 1]);
    expect(g.map((x) => x.last)).toEqual([false, false, true, true]);
    // c sits under b, which has a later sibling d: the level-1 trunk continues past c
    expect(g[2]!.continues).toEqual([true]);
  });
  it('the trunk of a finished parent does not continue', () => {
    const g = computeGuides([1, 2, 2, 3]);
    expect(g[3]!.continues).toEqual([false, false]);
    expect(g.map((x) => x.last)).toEqual([true, false, true, true]);
  });
});

describe('geometry', () => {
  it('puts level 1 under the avatar and shrinks the indent for large text', () => {
    expect(trunkX(1, 28)).toBe(30);
    expect(trunkX(2, 28)).toBe(58);
    expect(contentLeft(1, 28)).toBe(46);
    expect(indentFor(1)).toBe(28);
    expect(indentFor(1.6)).toBe(16);
  });
});
