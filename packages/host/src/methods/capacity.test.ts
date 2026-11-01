import { describe, expect, it, vi } from 'vitest';
import type { CapacitySnapshot } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import { createCapacityHandlers } from './capacity.js';

const SNAPSHOT: CapacitySnapshot = {
  machine: { live: 3, limit: 4, queued: 0, pressure: 'normal', swapGb: null, sleepMinutes: 60 },
  queue: [],
};

describe('capacity.get', () => {
  it('capacity.get отдаёт снимок ленты', async () => {
    const snapshot = vi.fn(async () => SNAPSHOT);
    const { capacityGet } = createCapacityHandlers({ capacityFeed: { snapshot } });

    await expect(capacityGet({}, {} as RequestInfo)).resolves.toBe(SNAPSHOT);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
