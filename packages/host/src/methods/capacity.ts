/**
 * Метод `capacity.get`: числа ёмкости машины и очередь запусков для сегмента строки состояния окна (спека 2026-10-30, 4.5).
 * Отдаёт тот же снимок, из которого хост рассылает `capacity.changed` и собирает `get_capacity` для агентов.
 * Очередь берётся из снимка работ, поэтому метод ждёт `worksReady` (`WORKS_GATED_METHODS` в `methods/index.ts`).
 */

import type { Handler } from '../context.js';
import type { CapacityFeed } from '../capacity/capacity-feed.js';

export interface CapacityMethodDeps {
  capacityFeed: Pick<CapacityFeed, 'snapshot'>;
}

export interface CapacityHandlers {
  capacityGet: Handler<'capacity.get'>;
}

export function createCapacityHandlers(deps: CapacityMethodDeps): CapacityHandlers {
  return {
    capacityGet: async () => deps.capacityFeed.snapshot(),
  };
}
