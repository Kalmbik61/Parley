import { describe, expect, it } from 'vitest';
import { selectedFragment } from './selection';

describe('selectedFragment', () => {
  const text = 'Wave 3 is merged; next A27';
  it('the slice between start and end', () => {
    expect(selectedFragment(text, { start: 0, end: 6 })).toBe('Wave 3');
  });
  it('a reverse selection is the same fragment', () => {
    expect(selectedFragment(text, { start: 6, end: 0 })).toBe('Wave 3');
  });
  it('nothing or only blanks is empty', () => {
    expect(selectedFragment(text, { start: 4, end: 4 })).toBe('');
    expect(selectedFragment(text, { start: 6, end: 7 })).toBe('');
  });
  it('a surrogate pair is kept whole when the indices sit on its edges', () => {
    const t = 'a😀b';
    expect(selectedFragment(t, { start: 1, end: 3 })).toBe('😀');
    expect(selectedFragment(t, { start: 3, end: 1 })).toBe('😀');
  });
});
