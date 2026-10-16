import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { HealthSample } from '@parley/protocol';
import type { Log } from '../log.js';
import { emptyWindowTally, type WindowCounters } from './window-counters.js';

export const HEALTH_INTERVAL_MS = 30_000;

/**
 * Разрешение гистограммы лага. Node пишет в `monitorEventLoopDelay` интервал между срабатываниями таймера,
 * то есть разрешение плюс задержка цикла: в простое `max` ≈ 22 мс при разрешении 20. Саму задержку даёт
 * значение за вычетом разрешения.
 */
export const LOOP_RESOLUTION_MS = 20;

const NS_PER_MS = 1_000_000;
const BYTES_PER_MB = 1024 * 1024;

/** Счётчики того, что держит хост: читаются лениво при каждом `sample()`. */
export interface HealthCounters {
  ptys: number;
  attached: number;
  feedSubs: number;
  works: number;
  rooms: number;
  clients: number;
}

export interface HealthService {
  /** Показатели текущего окна (с прошлого тика) без сброса гистограммы. */
  sample(): HealthSample;
  start(): void;
  stop(): void;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Раз в `intervalMs` пишет строку `host: состояние` — CPU хоста, память, лаг цикла событий и счётчики — и
 * сбрасывает гистограмму лага. `sample()` отдаёт те же показатели для `host.diagnostics`, ничего не двигая.
 * Таймер `unref`.
 */
export function createHealthService(deps: {
  log: Log;
  counters: () => HealthCounters;
  /** Счётчики окна: читаются в `sample()`, обнуляются на тике вместе с гистограммой. Без них поля — нули. */
  windowCounters?: WindowCounters;
  histogram?: Pick<IntervalHistogram, 'enable' | 'disable' | 'reset' | 'max' | 'mean' | 'percentile'>;
  cpuUsage?: typeof process.cpuUsage;
  memoryUsage?: typeof process.memoryUsage;
  now?: () => number;
  intervalMs?: number;
}): HealthService {
  const histogram = deps.histogram ?? monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  const cpuUsage = deps.cpuUsage ?? process.cpuUsage;
  const memoryUsage = deps.memoryUsage ?? process.memoryUsage;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? HEALTH_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | null = null;
  // База окна: CPU и стена на последнем тике (или на старте).
  let baseCpu = cpuUsage();
  let baseAt = now();

  // У пустой гистограммы среднее — NaN: в журнале должен быть 0, а не null. Разрешение вычитаем (см.
  // `LOOP_RESOLUTION_MS`): без этого простой хост показывал бы лаг ≈ 20 мс; отсекаем на нуле.
  const ms = (ns: number): number => (Number.isFinite(ns) ? Math.max(0, Math.round(ns / NS_PER_MS) - LOOP_RESOLUTION_MS) : 0);

  const sample = (): HealthSample => {
    const wallMs = now() - baseAt;
    const cpu = cpuUsage();
    const cpuMs = (cpu.user - baseCpu.user + (cpu.system - baseCpu.system)) / 1000;
    const memory = memoryUsage();
    const windowTally = deps.windowCounters?.read() ?? emptyWindowTally();
    return {
      cpuPct: wallMs > 0 ? round1((cpuMs / wallMs) * 100) : 0,
      rssMb: Math.round(memory.rss / BYTES_PER_MB),
      heapMb: Math.round(memory.heapUsed / BYTES_PER_MB),
      extMb: Math.round(memory.external / BYTES_PER_MB),
      loop: { maxMs: ms(histogram.max), p99Ms: ms(histogram.percentile(99)), meanMs: ms(histogram.mean) },
      ...deps.counters(),
      ...windowTally,
      refreshMs: round1(windowTally.refreshMs),
    };
  };

  return {
    sample,
    start() {
      if (timer !== null) return;
      baseCpu = cpuUsage();
      baseAt = now();
      histogram.enable();
      timer = setInterval(() => {
        try {
          deps.log.info('host: состояние', sample());
          histogram.reset();
          deps.windowCounters?.reset();
          baseCpu = cpuUsage();
          baseAt = now();
        } catch {
          // Сбой строки состояния (счётчик бросил, журнал не записался) не должен ронять хост;
          // писать о нём некуда — журнал как раз мог быть недоступен.
        }
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      histogram.disable();
    },
  };
}
