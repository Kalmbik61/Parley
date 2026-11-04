import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, createFollowController } from './follow-controller';
import type { ScrollMetrics } from './follow-end';

const K = ['a', 'b', 'c'];
const atEnd: ScrollMetrics = { offset: 900, content: 1000, viewport: 100 };
const middle: ScrollMetrics = { offset: 300, content: 1000, viewport: 100 };

function setup() {
  const calls: boolean[] = [];
  const away: number[] = [];
  const reveals: number[] = [];
  const conceals: number[] = [];
  const reopens: number[] = [];
  const c = createFollowController({
    scrollToEnd: (a) => calls.push(a),
    onAway: (n) => away.push(n),
    onReveal: () => reveals.push(Date.now()),
    onConceal: () => conceals.push(Date.now()),
    onReopen: () => reopens.push(Date.now()),
    now: Date.now,
  });
  c.setKeys(K);
  return { c, calls, away, reveals, conceals, reopens };
}

describe('follow controller (A44)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls on growth and once more after the size settles', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    expect(calls).toEqual([false]);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(calls).toEqual([false, false]);
    c.dispose();
  });

  it('the pin ends 500 ms after the last growth, by its own timer', () => {
    const { c } = setup();
    c.contentSizeChanged();
    expect(c.isPinned()).toBe(true);
    vi.advanceTimersByTime(499);
    expect(c.isPinned()).toBe(true);
    vi.advanceTimersByTime(5);
    expect(c.isPinned()).toBe(false);
    c.dispose();
  });

  it('a touch cancels the repeat: nothing scrolls under the finger', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    c.beginDrag();
    vi.advanceTimersByTime(SETTLE_MS + 1);
    c.contentSizeChanged();
    expect(calls).toEqual([false]);
    c.dispose();
  });

  it('on release at the bottom one scroll follows the growth that came during the touch', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    c.scroll(atEnd);
    c.beginDrag();
    c.contentSizeChanged();
    const before = calls.length;
    c.endDrag(atEnd, false);
    expect(calls.length).toBe(before + 1);
    c.dispose();
  });

  it('reports the count of new items while away and clears it at the bottom', () => {
    const { c, away } = setup();
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    c.scroll(atEnd);
    c.leave();
    c.setKeys([...K, 'd', 'e']);
    c.contentSizeChanged();
    expect(away).toEqual([2]);
    c.beginDrag();
    c.endDrag(atEnd, false);
    expect(away).toEqual([2, 0]);
    c.dispose();
  });

  it('a quote jump (leave) keeps the feed where it is when rows grow', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    c.scroll(atEnd);
    c.leave();
    const before = calls.length;
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    expect(calls.length).toBe(before);
    c.dispose();
  });

  it('a shrinking window scrolls to the end; keepEnd does too', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    c.scroll(atEnd);
    c.layout(700);
    const before = calls.length;
    c.layout(400);
    expect(calls.length).toBe(before + 1);
    c.keepEnd();
    expect(calls.length).toBe(before + 2);
    c.dispose();
  });

  it('dispose clears the timers', () => {
    const { c, calls } = setup();
    c.contentSizeChanged();
    c.dispose();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([false]);
  });

  it('a skeleton does not start the pin timer', () => {
    const { c, calls } = setup();
    c.setKeys([]);
    c.contentSizeChanged();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
    expect(c.isPinned()).toBe(true);
    c.dispose();
  });

  it('a momentum begin of a human flick ends the pin and a position away from the end is kept', () => {
    const { c } = setup();
    c.contentSizeChanged();
    vi.advanceTimersByTime(1000);
    c.scroll(atEnd);
    c.momentumBegin();
    c.momentumEnd(middle);
    expect(c.state().atBottom).toBe(false);
    c.dispose();
  });

  const landed = (content: number): ScrollMetrics => ({ offset: content - 100, content, viewport: 100 });

  it('A44b: the list shows one frame after the last growth, once the scroll has landed at the end', () => {
    const { c, reveals } = setup();
    c.contentSizeChanged(3000);
    vi.advanceTimersByTime(140);
    expect(reveals).toEqual([]); // quiet, but no scroll event has seen the end yet
    c.scroll(landed(3000));
    expect(reveals.length).toBe(1);
    c.contentSizeChanged(3400);
    vi.advanceTimersByTime(1000);
    expect(reveals.length).toBe(1);
    c.dispose();
  });

  it('A44b: growth every 20 ms still reveals at the 600 ms cap', () => {
    const { c, reveals } = setup();
    for (let t = 0; t < 700; t += 20) {
      c.contentSizeChanged(3000 + t);
      vi.advanceTimersByTime(20);
    }
    expect(reveals.length).toBe(1);
    c.dispose();
  });

  it('A44b: a skeleton-only phase starts no cap; the cap runs from the first real rows', () => {
    const { c, reveals } = setup();
    c.setKeys([]);
    c.contentSizeChanged(200);
    vi.advanceTimersByTime(5000);
    expect(reveals).toEqual([]);
    c.setKeys(K);
    c.contentSizeChanged(3000);
    vi.advanceTimersByTime(599);
    expect(reveals).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(reveals.length).toBe(1);
    c.dispose();
  });

  it('A44b: a short feed shows at once, with no wait', () => {
    const { c, reveals } = setup();
    c.layout(800);
    c.contentSizeChanged(500);
    expect(reveals.length).toBe(1);
    c.dispose();
  });
});

describe('follow controller: a re-read (A44c)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Opened, shown, the pin over, at the end. */
  function shown() {
    const h = setup();
    h.c.contentSizeChanged(1000);
    h.c.scroll(atEnd);
    vi.advanceTimersByTime(700);
    expect(h.reveals).toHaveLength(1);
    h.calls.length = 0;
    return h;
  }
  const rows = (n: number): string[] => [...K, ...Array.from({ length: n }, (_, i) => `r${i}`)];

  it('+61 rows: concealed once, 7 growths 80 ms apart, every scroll instant, shown once within 600 ms', () => {
    const h = shown();
    const t0 = Date.now();
    h.c.setKeys(rows(61));
    expect(h.c.reread()).toBe(true);
    expect(h.conceals).toHaveLength(1);
    expect(h.reopens).toHaveLength(1);
    for (let i = 0; i < 7; i++) {
      h.c.contentSizeChanged(2000 + i * 500);
      h.c.scroll({ offset: 2000 + i * 500 - 100, content: 2000 + i * 500, viewport: 100 });
      vi.advanceTimersByTime(80);
    }
    vi.advanceTimersByTime(300);
    expect(h.calls.every((a) => !a)).toBe(true);
    expect(h.conceals).toHaveLength(1);
    expect(h.reveals).toHaveLength(2);
    expect(h.reveals[1]! - t0).toBeLessThanOrEqual(601);
    h.c.dispose();
  });

  it('+3 rows: no conceal, the scroll is instant', () => {
    const h = shown();
    h.c.setKeys(rows(3));
    expect(h.c.reread()).toBe(false);
    h.c.contentSizeChanged(1300);
    expect(h.conceals).toHaveLength(0);
    expect(h.calls).toEqual([false]);
    h.c.dispose();
  });

  it('remounted(): concealed, shown within 600 ms', () => {
    const h = shown();
    const t0 = Date.now();
    expect(h.c.remounted()).toBe(true);
    expect(h.conceals).toHaveLength(1);
    h.c.contentSizeChanged(1000);
    vi.advanceTimersByTime(700);
    expect(h.reveals).toHaveLength(2);
    expect(h.reveals[1]! - t0).toBeLessThanOrEqual(601);
    h.c.dispose();
  });
});
