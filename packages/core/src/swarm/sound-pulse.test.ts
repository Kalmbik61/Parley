/** Пульс по громкости (`soundPulse`): выключен — кадр как раньше, уровень 0 — как выключен, уровень 1 — больше и ярче. */

import { describe, expect, it } from 'vitest';
import { createSwarm, type SwarmEngine, type SwarmOptions, type SwarmSink } from './engine.js';
import type { SwarmSpec } from './spec.js';

const OPTIONS: SwarmOptions = { width: 220, height: 220, d: 170, cy: 110, k: 0.058, minPx: 2.4 };
const SPHERE: SwarmSpec = { shape: 'sphere', fx: null, pal: 'amber', rot: 0.3, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };

type Call = [string, number, number, number, number, number];
const recorder = (): { sink: SwarmSink; calls: Call[] } => {
  const calls: Call[] = [];
  return { calls, sink: { begin() {}, end() {}, soul: (pal, c, x, y, size, a) => calls.push([pal, c, x, y, size, a]) } };
};

/** Несколько кадров по 16 мс с постоянным уровнем; возвращает вызовы последнего кадра. */
const run = (extra: Partial<SwarmOptions>, level: number, reduced = false): Call[] => {
  const engine: SwarmEngine = createSwarm(200, { ...OPTIONS, ...extra, seed: 5 });
  engine.setSpec(SPHERE, 0, reduced);
  let last: Call[] = [];
  for (let i = 0; i < 30; i++) {
    const r = recorder();
    engine.frame(i * 16, r.sink, reduced, level);
    last = r.calls;
  }
  return last;
};

const sum = (calls: Call[], i: 4 | 5): number => calls.reduce((a, c) => a + c[i], 0);

describe('soundPulse', () => {
  it('выключен: уровень ничего не меняет', () => {
    expect(run({}, 1)).toEqual(run({}, 0));
    expect(run({ soundPulse: false }, 1)).toEqual(run({}, 1));
  });

  it('включён с уровнем 0: те же вызовы приёмника, что у выключенного', () => {
    expect(run({ soundPulse: true }, 0)).toEqual(run({}, 0));
  });

  it('уровень 1: рой крупнее, ярче и сдвинут', () => {
    const off = run({}, 0);
    const on = run({ soundPulse: true }, 1);
    expect(on.length).toBe(off.length);
    expect(sum(on, 4)).toBeGreaterThan(sum(off, 4) * 1.04);
    expect(sum(on, 5)).toBeGreaterThan(sum(off, 5));
    expect(on.some((c, i) => c[2] !== off[i]![2])).toBe(true);
  });

  it('reduced motion: положение и размер те же, ярче', () => {
    const off = run({}, 0, true);
    const on = run({ soundPulse: true }, 1, true);
    expect(on.map((c) => [c[2], c[3], c[4]])).toEqual(off.map((c) => [c[2], c[3], c[4]]));
    expect(sum(on, 5)).toBeGreaterThan(sum(off, 5));
  });

  it('уровень спадает за ~120 мс и кадр ещё нужен, пока не затух', () => {
    const engine = createSwarm(50, { ...OPTIONS, soundPulse: true });
    engine.setSpec(SPHERE, 0, false);
    for (let i = 0; i < 10; i++) engine.frame(i * 16, null, false, 1);
    engine.frame(176, null, false, 0);
    expect(engine.needsFrame()).toBe(true);
    for (let i = 1; i < 120; i++) engine.frame(176 + i * 16, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
  });
});
