/**
 * Лента ёмкости машины (спека сна агентов и ёмкости 2026-10-30, 4.3 и 4.5): хост считает числа один раз и отдаёт их двоим —
 * окну (`capacity.get` и событие `capacity.changed`) и агентам (`get_capacity`). Считает `machineCapacity` из core, входы
 * берутся у тех, кто их знает: занятые слоты и очередь — у сервиса ёмкости, давление и своп — у датчика, потолок и пороги
 * сна — из настроек.
 *
 * Рассылка идёт только окну и только при изменении: любое событие (старт и выход процесса, снимок работ, чтение датчика) ставит один
 * таймер на `publishMs`, по нему считается снимок и рассылается, если он отличается от прошлой рассылки. Так буря изменений
 * работ даёт не больше одной рассылки за окно времени, а чтение датчика раз в 10 с без перемен — ни одной.
 */

import { totalmem } from 'node:os';
import { machineCapacity, machineLimit, type ParleyConfig } from '@parley/core';
import type { CapacitySnapshot } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import type { CapacityService } from './capacity-service.js';
import type { PressureSensor } from './memory-pressure.js';

/** Не чаще раза в это время окну уходит `capacity.changed`. */
export const CAPACITY_PUBLISH_MS = 500;

export interface CapacityFeedDeps {
  capacity: Pick<CapacityService, 'occupied' | 'queue'>;
  pressure: Pick<PressureSensor, 'current' | 'onReading'>;
  works: Pick<WorksService, 'onChange'>;
  pty: Pick<PtyManager, 'on'>;
  /** Настройки читаются на каждом снимке: человек меняет потолок и пороги сна на ходу. */
  config: () => Promise<Pick<ParleyConfig, 'machineConcurrent' | 'sleepAfterMinutes' | 'sleepUnderPressureMinutes'>>;
  /** По умолчанию `os.totalmem()`. */
  totalMemBytes?: number;
  /** По умолчанию `CAPACITY_PUBLISH_MS`. */
  publishMs?: number;
}

export interface CapacityFeed {
  /** Числа машины и очередь сейчас. */
  snapshot(): Promise<CapacitySnapshot>;
  start(): void;
  stop(): void;
}

export function createCapacityFeed(host: HostContext, deps: CapacityFeedDeps): CapacityFeed {
  const totalMem = deps.totalMemBytes ?? totalmem();
  const publishMs = deps.publishMs ?? CAPACITY_PUBLISH_MS;

  let stopped = true;
  let timer: NodeJS.Timeout | null = null;
  let unsubscribes: Array<() => void> = [];
  /** Что ушло окнам в последний раз: рассылается только другое. */
  let lastPublished: string | null = null;

  async function snapshot(): Promise<CapacitySnapshot> {
    const config = await deps.config();
    const queue = deps.capacity.queue();
    const reading = deps.pressure.current();
    return {
      machine: machineCapacity({
        occupied: deps.capacity.occupied(),
        limit: machineLimit(config.machineConcurrent, totalMem),
        queued: queue.length,
        pressure: reading.level,
        swapGb: reading.swapGb,
        sleepAfterMinutes: config.sleepAfterMinutes,
        sleepUnderPressureMinutes: config.sleepUnderPressureMinutes,
      }),
      queue,
    };
  }

  async function publish(): Promise<void> {
    try {
      const current = await snapshot();
      if (stopped) return;
      const text = JSON.stringify(current);
      if (text === lastPublished) return;
      lastPublished = text;
      host.broadcast('capacity.changed', current);
    } catch (error) {
      host.log.warn('ёмкость: снимок для окон не собрался', { error: String(error) });
    }
  }

  /** Любое событие ставит один таймер, пока он не сработал. */
  function touch(): void {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void publish();
    }, publishMs);
  }

  return {
    snapshot,

    start() {
      if (!stopped) return;
      stopped = false;
      // Перезапущенная лента рассылает снимок заново, даже если он не изменился: окно могло пропустить рассылки.
      lastPublished = null;
      unsubscribes = [
        deps.pty.on('start', touch),
        deps.pty.on('exit', touch),
        deps.works.onChange(touch),
        deps.pressure.onReading(touch),
      ];
    },

    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
