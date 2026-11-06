import { describe, expect, it } from 'vitest';
import { createSwarm, type SwarmSpec } from '@parley/core/swarm';
import { createAtlasSink, SPRITE_COUNT } from './atlas-sink.js';

const SPHERE: SwarmSpec = { shape: 'sphere', fx: null, pal: 'amber', rot: 0.3, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };

describe('createAtlasSink', () => {
  it('кадр настоящего движка на 700 душ ложится в буферы', () => {
    const engine = createSwarm(700, { width: 220, height: 220, d: 132, cy: 110, k: 0.058, minPx: 3.7, soundPulse: true });
    const sink = createAtlasSink(1400);
    engine.setSpec(SPHERE, 0, false);
    for (let i = 0; i < 5; i++) engine.frame(i * 33, sink, false, 0.5);
    expect(sink.count).toBeGreaterThan(300);
    expect(sink.count).toBeLessThanOrEqual(700);
    for (let i = 0; i < sink.count; i++) {
      expect(sink.sprite[i]!).toBeLessThan(SPRITE_COUNT);
      expect(sink.alpha[i]!).toBeGreaterThan(0);
      expect(sink.alpha[i]!).toBeLessThanOrEqual(1);
      expect(sink.xform[i * 4]!).toBeGreaterThan(0);
      expect(sink.xform[i * 4 + 1]).toBe(0);
      for (const v of [sink.xform[i * 4 + 2]!, sink.xform[i * 4 + 3]!]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('смена палитры даёт две записи на душу, но не выходит за ёмкость', () => {
    const engine = createSwarm(100, { width: 220, height: 220, d: 132, cy: 110 });
    const sink = createAtlasSink(150);
    engine.setSpec(SPHERE, 0, false);
    engine.frame(0, sink, false, 0);
    engine.setSpec({ ...SPHERE, pal: 'coral' }, 10, false);
    engine.frame(20, sink, false, 0);
    expect(sink.count).toBeLessThanOrEqual(150);
    expect(sink.count).toBeGreaterThan(100);
  });

  it('begin обнуляет счёт', () => {
    const sink = createAtlasSink(4);
    sink.soul('gray', 3, 1, 2, 24, 0.5);
    expect(sink.count).toBe(1);
    expect(sink.sprite[0]).toBe(11);
    expect(sink.xform[0]).toBe(0.5);
    sink.begin(1, 1);
    expect(sink.count).toBe(0);
  });
});
