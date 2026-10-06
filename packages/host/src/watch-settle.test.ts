import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettler, WATCH_SETTLE_MS } from './watch-settle.js';

describe('createSettler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('дочитывает на каждой паузе от schedule и больше не трогает', () => {
    const run = vi.fn();
    createSettler(run).schedule();
    expect(run).not.toHaveBeenCalled();
    WATCH_SETTLE_MS.forEach((ms, index) => {
      vi.advanceTimersByTime(ms - (WATCH_SETTLE_MS[index - 1] ?? 0));
      expect(run).toHaveBeenCalledTimes(index + 1);
    });
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(WATCH_SETTLE_MS.length);
  });

  it('повторный schedule начинает отсчёт заново, cancel снимает всё', () => {
    const run = vi.fn();
    const settler = createSettler(run, [100, 200]);
    settler.schedule();
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(1);
    settler.schedule(); // прежняя пауза в 200 мс отменена, отсчёт пошёл заново
    vi.advanceTimersByTime(99);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    settler.cancel();
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
