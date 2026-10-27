import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthService } from './health-service.js';
import { createWindowCounters } from './window-counters.js';

const NS = 1_000_000;
const MB = 1024 * 1024;

const counters = { ptys: 15, attached: 3, feedSubs: 2, works: 4, rooms: 2, clients: 1 };

function fakeHistogram(overrides: { max?: number; mean?: number; p99?: number } = {}) {
  return {
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(),
    max: overrides.max ?? 120 * NS,
    mean: overrides.mean ?? 3 * NS,
    percentile: vi.fn(() => overrides.p99 ?? 40 * NS),
  };
}
const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const fakeMemory = (() => ({ rss: 490 * MB, heapUsed: 200 * MB, external: 30 * MB })) as unknown as typeof process.memoryUsage;

describe('createHealthService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('раз в 30 с пишет host: состояние с CPU, памятью, лагом и счётчиками', () => {
    const log = fakeLog();
    let usage = { user: 0, system: 0 };
    const cpuUsage = vi.fn((prev?: NodeJS.CpuUsage) =>
      prev === undefined ? usage : { user: usage.user - prev.user, system: usage.system - prev.system },
    );
    const histogram = fakeHistogram();
    const service = createHealthService({
      log,
      counters: () => counters,
      histogram,
      cpuUsage: cpuUsage as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
      intervalMs: 30_000,
    });
    service.start();
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    usage = { user: 15_000_000, system: 0 }; // 15 с CPU за 30 с стены
    vi.advanceTimersByTime(30_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('host: состояние', {
      cpuPct: 50, rssMb: 490, heapMb: 200, extMb: 30, loop: { maxMs: 100, p99Ms: 20, meanMs: 0 },
      ptys: 15, attached: 3, feedSubs: 2, works: 4, rooms: 2, clients: 1,
      refreshCount: 0, refreshMs: 0, mapBytesParsed: 0, ptyChunks: 0, ptyBytes: 0, recomputes: 0,
      worksChangedEvents: 0, worksChangedBytes: 0, mailEvents: 0, mailBytes: 0, lettersOnlyRefreshes: 0,
    });
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('sample() отдаёт текущее окно без сброса гистограммы', () => {
    const log = fakeLog();
    let usage = { user: 0, system: 0 };
    const cpuUsage = vi.fn((prev?: NodeJS.CpuUsage) =>
      prev === undefined ? usage : { user: usage.user - prev.user, system: usage.system - prev.system },
    );
    const histogram = fakeHistogram();
    const service = createHealthService({
      log,
      counters: () => counters,
      histogram,
      cpuUsage: cpuUsage as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
      intervalMs: 30_000,
    });
    service.start();
    usage = { user: 15_000_000, system: 0 };
    vi.advanceTimersByTime(30_000); // тик: окно закрыто, базу CPU и времени двигает он
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    usage = { user: 17_000_000, system: 1_000_000 }; // за 10 с после тика: 3 с CPU
    vi.advanceTimersByTime(10_000);
    const sample = service.sample();

    expect(sample).toEqual({
      cpuPct: 30, rssMb: 490, heapMb: 200, extMb: 30, loop: { maxMs: 100, p99Ms: 20, meanMs: 0 },
      ptys: 15, attached: 3, feedSubs: 2, works: 4, rooms: 2, clients: 1,
      refreshCount: 0, refreshMs: 0, mapBytesParsed: 0, ptyChunks: 0, ptyBytes: 0, recomputes: 0,
      worksChangedEvents: 0, worksChangedBytes: 0, mailEvents: 0, mailBytes: 0, lettersOnlyRefreshes: 0,
    });
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('счётчики окна попадают в sample() и в строку, тик обнуляет их, sample() не сбрасывает', () => {
    const log = fakeLog();
    const windowCounters = createWindowCounters();
    const service = createHealthService({
      log,
      counters: () => counters,
      windowCounters,
      histogram: fakeHistogram(),
      cpuUsage: (() => ({ user: 0, system: 0 })) as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
      intervalMs: 30_000,
    });
    service.start();
    windowCounters.refresh(40.04);
    windowCounters.refresh(10.01);
    windowCounters.mapsParsed(1000);
    windowCounters.mapsParsed(500);
    windowCounters.pty(7);
    windowCounters.pty(3);
    windowCounters.recompute();
    windowCounters.recompute();
    windowCounters.recompute();

    const expected = { refreshCount: 2, refreshMs: 50.1, mapBytesParsed: 1500, ptyChunks: 2, ptyBytes: 10, recomputes: 3 };
    expect(service.sample()).toMatchObject(expected);
    expect(service.sample()).toMatchObject(expected); // повторный sample() ничего не сбросил

    vi.advanceTimersByTime(30_000);
    expect(log.info).toHaveBeenCalledWith('host: состояние', expect.objectContaining(expected));
    expect(service.sample()).toMatchObject({
      refreshCount: 0, refreshMs: 0, mapBytesParsed: 0, ptyChunks: 0, ptyBytes: 0, recomputes: 0,
      worksChangedEvents: 0, worksChangedBytes: 0, mailEvents: 0, mailBytes: 0, lettersOnlyRefreshes: 0,
    });
    service.stop();
  });

  it('строка состояния несёт счётчики окна: письма, works.changed и обновления только из-за писем; тик обнуляет', () => {
    const log = fakeLog();
    const windowCounters = createWindowCounters();
    const service = createHealthService({
      log,
      counters: () => counters,
      windowCounters,
      histogram: fakeHistogram(),
      cpuUsage: (() => ({ user: 0, system: 0 })) as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
      intervalMs: 30_000,
    });
    service.start();
    windowCounters.mail(1000);
    windowCounters.worksChanged(500);
    windowCounters.lettersOnlyRefresh();

    const expected = { mailEvents: 1, mailBytes: 1000, worksChangedEvents: 1, worksChangedBytes: 500, lettersOnlyRefreshes: 1 };
    expect(service.sample()).toMatchObject(expected);

    vi.advanceTimersByTime(30_000);
    expect(log.info).toHaveBeenCalledWith('host: состояние', expect.objectContaining(expected));
    expect(service.sample()).toMatchObject({
      mailEvents: 0, mailBytes: 0, worksChangedEvents: 0, worksChangedBytes: 0, lettersOnlyRefreshes: 0,
    });
    service.stop();
  });

  it('пустая гистограмма (mean — NaN) даёт нули, а не NaN', () => {
    const histogram = fakeHistogram({ max: 0, mean: Number.NaN, p99: 0 });
    const service = createHealthService({
      log: fakeLog(),
      counters: () => counters,
      histogram,
      cpuUsage: (() => ({ user: 0, system: 0 })) as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
    });
    service.start();
    expect(service.sample().loop).toEqual({ maxMs: 0, p99Ms: 0, meanMs: 0 });
    service.stop();
  });

  it('stop() снимает таймер и выключает гистограмму', () => {
    const log = fakeLog();
    const histogram = fakeHistogram();
    const service = createHealthService({
      log,
      counters: () => counters,
      histogram,
      cpuUsage: (() => ({ user: 0, system: 0 })) as unknown as typeof process.cpuUsage,
      memoryUsage: fakeMemory,
      intervalMs: 30_000,
    });
    service.start();
    expect(vi.getTimerCount()).toBe(1);
    service.stop();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180_000);
    expect(log.info).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
