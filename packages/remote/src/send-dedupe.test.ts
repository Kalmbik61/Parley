import { describe, expect, it } from 'vitest';
import { createSendDedupe } from './send-dedupe.js';
import type { SendOutcome } from './send-dedupe.js';

const done = (n: number): Promise<SendOutcome> => Promise.resolve({ result: n });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('send dedupe cache', () => {
  it('keeps at most maxPerDevice keys, evicting the oldest first', async () => {
    const cache = createSendDedupe({ maxPerDevice: 3 });
    for (let i = 0; i < 5; i++) cache.remember('d1', `k${i}`, 'f', done(i));
    await tick();
    expect(cache.size('d1')).toBe(3);
    expect(cache.lookup('d1', 'k0')).toBeNull();
    expect(cache.lookup('d1', 'k1')).toBeNull();
    expect(await cache.lookup('d1', 'k4')?.outcome).toEqual({ result: 4 });
  });

  it('an in-flight call never expires; a finished one expires ttl after it finished; idle devices are pruned', async () => {
    let t = 0;
    const cache = createSendDedupe({ now: () => t, ttlMs: 100 });
    let finish!: (v: SendOutcome) => void;
    cache.remember('d1', 'slow', 'f', new Promise((r) => (finish = r)));
    cache.remember('d2', 'fast', 'f', done(1));
    await tick();
    t = 1000;
    expect(cache.lookup('d1', 'slow')).not.toBeNull();
    finish({ result: 'late' });
    await tick();
    t = 1099;
    expect(await cache.lookup('d1', 'slow')?.outcome).toEqual({ result: 'late' });
    // d2 expired long ago: a write for another device drops its map.
    cache.remember('d3', 'x', 'f', done(3));
    expect(cache.size('d2')).toBe(0);
    t = 1100;
    expect(cache.lookup('d1', 'slow')).toBeNull();
  });
});
