import { describe, expect, it } from 'vitest';
import {
  PIN_MAX_MS,
  PIN_QUIET_MS,
  contentChanged,
  dragEnded,
  gestureBegan,
  jumped,
  momentumEnded,
  open,
  pinDeadline,
  scrolled,
  tick,
  type FollowState,
  type ScrollMetrics,
} from './follow-end';

const atEnd: ScrollMetrics = { offset: 900, content: 1000, viewport: 100 };
const middle: ScrollMetrics = { offset: 300, content: 1000, viewport: 100 };

describe('follow the end (A44)', () => {
  it('is pinned and at the bottom after open', () => {
    const s = open(0);
    expect(s.pinned).toBe(true);
    expect(s.atBottom).toBe(true);
  });

  it('scrolls to the end on every height growth while pinned', () => {
    let s = open(0);
    for (const [now, count] of [[10, 5], [60, 5], [200, 6], [450, 6]] as const) {
      const step = contentChanged(s, now, count);
      expect(step.scroll).not.toBe('none');
      expect(step.state.pinned).toBe(true);
      s = step.state;
    }
  });

  it('the first fill is instant, not animated', () => {
    expect(contentChanged(open(0), 5, 8).scroll).toBe('instant');
  });

  it('the pin ends after 500 ms without a height change', () => {
    const s = contentChanged(open(0), 100, 5).state;
    expect(tick(s, 100 + PIN_QUIET_MS - 1).pinned).toBe(true);
    expect(tick(s, 100 + PIN_QUIET_MS).pinned).toBe(false);
    expect(pinDeadline(s, 100)).toBe(PIN_QUIET_MS);
  });

  it('each growth restarts the quiet spell', () => {
    let s = open(0);
    s = contentChanged(s, 400, 5).state;
    s = contentChanged(s, 800, 5).state;
    expect(tick(s, 1200).pinned).toBe(true);
    expect(tick(s, 1300).pinned).toBe(false);
  });

  it('the pin ends at the 3 s cap even if the height keeps changing', () => {
    let s = open(0);
    for (let t = 100; t < PIN_MAX_MS; t += 200) s = contentChanged(s, t, 5).state;
    expect(tick(s, PIN_MAX_MS - 100).pinned).toBe(true);
    expect(tick(s, PIN_MAX_MS).pinned).toBe(false);
    expect(pinDeadline(s, PIN_MAX_MS - 100)).toBe(100);
  });

  it('a human drag ends the pin at once', () => {
    const s = gestureBegan(contentChanged(open(0), 10, 5).state);
    expect(s.pinned).toBe(false);
    expect(s.gesture).toBe(true);
  });

  it('content growth without a gesture keeps "at the bottom": a growth scroll event is ignored', () => {
    let s: FollowState = tick(contentChanged(open(0), 10, 5).state, 600);
    expect(s.pinned).toBe(false);
    // Rows grew, the offset is now far from the new end: the event is not the human's.
    s = scrolled(s, middle, 5);
    expect(s.atBottom).toBe(true);
    const step = contentChanged(s, 700, 5);
    expect(step.scroll).not.toBe('none');
  });

  it('only the human\'s own scrolling decides "not at the bottom"', () => {
    let s = tick(contentChanged(open(0), 10, 5).state, 600);
    s = gestureBegan(s);
    s = scrolled(s, middle, 5);
    expect(s.atBottom).toBe(false);
    s = dragEnded(s, middle, 5, true);
    expect(s.gesture).toBe(true);
    s = momentumEnded(s, middle, 5);
    expect(s.gesture).toBe(false);
    expect(s.atBottom).toBe(false);
    // After the gesture, a growth event changes nothing.
    expect(scrolled(s, atEnd, 5).atBottom).toBe(false);
  });

  it('a drag that ends with no momentum ends the gesture', () => {
    const s = dragEnded(gestureBegan(open(0)), middle, 5, false);
    expect(s.gesture).toBe(false);
    expect(s.atBottom).toBe(false);
  });

  it('new items away from the bottom count for "Jump to latest"', () => {
    let s = contentChanged(open(0), 10, 5).state;
    s = gestureBegan(s);
    s = dragEnded(s, middle, 5, false);
    const step = contentChanged(s, 5000, 8);
    expect(step.scroll).toBe('none');
    expect(step.state.away).toBe(3);
    expect(contentChanged(step.state, 5100, 9).state.away).toBe(4);
  });

  it('new items at the bottom do not count: they are followed', () => {
    const s = tick(contentChanged(open(0), 10, 5).state, 600);
    const step = contentChanged(s, 5000, 6);
    expect(step.scroll).toBe('animated');
    expect(step.state.away).toBe(0);
    expect(step.state.seen).toBe(6);
  });

  it('scrolling back to the bottom clears the count', () => {
    let s = gestureBegan(contentChanged(open(0), 10, 5).state);
    s = dragEnded(s, middle, 5, true);
    s = contentChanged(s, 5000, 8).state;
    expect(s.away).toBe(3);
    s = momentumEnded(s, atEnd, 8);
    expect(s.away).toBe(0);
    expect(s.atBottom).toBe(true);
  });

  it('"Jump to latest" goes to the end and follows again', () => {
    let s = dragEnded(gestureBegan(open(0)), middle, 5, false);
    s = contentChanged(s, 5000, 8).state;
    const step = jumped(s, 8);
    expect(step.scroll).toBe('animated');
    expect(step.state.atBottom).toBe(true);
    expect(step.state.away).toBe(0);
    expect(contentChanged(step.state, 5100, 9).scroll).toBe('animated');
  });
});
