import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLoopDelayLog } from './loop-delay.js';

const NS = 1_000_000;

function fakeHistogram(maxMs: number) {
  return {
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(),
    max: maxMs * NS,
    mean: 40 * NS,
    percentile: vi.fn(() => 120 * NS),
  };
}
const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('startLoopDelayLog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('max не ниже порога — одна строка warn с полями и reset', () => {
    const log = fakeLog();
    const histogram = fakeHistogram(300);
    const stop = startLoopDelayLog(log, { histogram, windowMs: 60_000, warnMs: 250 });
    vi.advanceTimersByTime(60_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('хост: цикл событий запаздывал', {
      maxMs: 300, p99Ms: 120, meanMs: 40, windowSec: 60,
    });
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    stop();
  });

  it('max ниже порога — строки нет, reset всё равно', () => {
    const log = fakeLog();
    const histogram = fakeHistogram(100);
    const stop = startLoopDelayLog(log, { histogram, windowMs: 60_000, warnMs: 250 });
    vi.advanceTimersByTime(60_000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stop() снимает таймер и выключает гистограмму', () => {
    const log = fakeLog();
    const histogram = fakeHistogram(300);
    const stop = startLoopDelayLog(log, { histogram, windowMs: 60_000 });
    expect(histogram.enable).toHaveBeenCalled();
    stop();
    expect(histogram.disable).toHaveBeenCalled();
    vi.advanceTimersByTime(180_000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
