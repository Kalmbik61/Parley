import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Log } from './log.js';

export const LOOP_DELAY_WINDOW_MS = 60_000;
export const LOOP_DELAY_WARN_MS = 250;

const NS_PER_MS = 1_000_000;

/** Раз в окно: max задержки цикла ≥ порога — строка warn с maxMs, p99Ms, meanMs, windowSec; гистограмма сбрасывается. Таймер unref. Возвращает stop(). */
export function startLoopDelayLog(
  log: Log,
  options: {
    histogram?: Pick<IntervalHistogram, 'enable' | 'disable' | 'reset' | 'max' | 'mean' | 'percentile'>;
    windowMs?: number;
    warnMs?: number;
  } = {},
): () => void {
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  const windowMs = options.windowMs ?? LOOP_DELAY_WINDOW_MS;
  const warnMs = options.warnMs ?? LOOP_DELAY_WARN_MS;
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = Math.round(histogram.max / NS_PER_MS);
    if (maxMs >= warnMs) {
      log.warn('хост: цикл событий запаздывал', {
        maxMs,
        p99Ms: Math.round(histogram.percentile(99) / NS_PER_MS),
        meanMs: Math.round(histogram.mean / NS_PER_MS),
        windowSec: Math.round(windowMs / 1000),
      });
    }
    histogram.reset();
  }, windowMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
