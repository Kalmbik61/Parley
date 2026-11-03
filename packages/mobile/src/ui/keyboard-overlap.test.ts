import { describe, expect, it } from 'vitest';
import { keyboardRise } from './keyboard-overlap';

describe('keyboardRise (plan A35e)', () => {
  it('the keyboard up: the rise is its height, whatever the view starts at (a sheet offset does not matter)', () => {
    // iPhone 17 window 874 high, keyboard with suggestions from y=546: the footer of a sheet body must rise by 328.
    // The old way (layout frame of a sheet body: y=0, height 812) gave 812 - 546 = 266 and left the button under the keys.
    expect(keyboardRise(874, 546)).toBe(328);
  });

  it('the keyboard hidden (its top at or below the bottom) gives no padding', () => {
    expect(keyboardRise(874, 874)).toBe(0);
    expect(keyboardRise(874, 900)).toBe(0);
  });
});
