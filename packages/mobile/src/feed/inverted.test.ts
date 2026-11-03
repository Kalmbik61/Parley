import { describe, expect, it } from 'vitest';
import { atBottom, newestFirst, NEAR_BOTTOM, reverseIndex, start, trackAway } from './inverted';

describe('inverted feed', () => {
  it('lists newest first without touching the input', () => {
    const rows = ['a', 'b', 'c'];
    expect(newestFirst(rows)).toEqual(['c', 'b', 'a']);
    expect(rows).toEqual(['a', 'b', 'c']);
  });

  it('maps a chronological index to the reversed one (room quote jump)', () => {
    const chron = ['m1', 'm2', 'm3', 'm4'];
    const list = newestFirst(chron);
    for (const [at, id] of chron.entries()) expect(list[reverseIndex(chron.length, at)]).toBe(id);
  });

  it('"at the bottom" is the offset near zero', () => {
    expect(atBottom(0)).toBe(true);
    expect(atBottom(NEAR_BOTTOM)).toBe(true);
    expect(atBottom(NEAR_BOTTOM + 1)).toBe(false);
  });

  it('counts new items only while away from the bottom', () => {
    let s = trackAway(start, ['c', 'b', 'a'], true);
    expect(s).toEqual({ seenKey: 'c', away: 0 });
    // at the bottom: new items stick and are seen at once
    s = trackAway(s, ['d', 'c', 'b', 'a'], true);
    expect(s).toEqual({ seenKey: 'd', away: 0 });
    // scrolled away: two arrive, both counted
    s = trackAway(s, ['e', 'd', 'c', 'b', 'a'], false);
    s = trackAway(s, ['f', 'e', 'd', 'c', 'b', 'a'], false);
    expect(s).toEqual({ seenKey: 'd', away: 2 });
    // back at the bottom: cleared
    expect(trackAway(s, ['f', 'e', 'd', 'c', 'b', 'a'], true)).toEqual({ seenKey: 'f', away: 0 });
  });

  it('older pages appended at the end never count as new', () => {
    const s = trackAway(trackAway(start, ['c', 'b'], true), ['c', 'b', 'a', '0'], false);
    expect(s).toEqual({ seenKey: 'c', away: 0 });
  });

  it('a vanished anchor keeps the previous count; an empty feed resets', () => {
    const away = { seenKey: 'x', away: 3 };
    expect(trackAway(away, ['b', 'a'], false)).toBe(away);
    expect(trackAway(away, [], false)).toEqual(start);
  });
});
