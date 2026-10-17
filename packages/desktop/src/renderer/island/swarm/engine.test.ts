/** Движок роя без canvas (`ctx = null`): детерминизм, границы облака, радиус сферы, переходы и reduced motion. */

import { describe, expect, it } from 'vitest';
import { createSwarm, type SwarmEngine } from './engine.js';
import { DUR, type SwarmSpec } from './spec.js';

const OPTIONS = { width: 420, height: 136, d: 86, cy: 62, k: 0.058, minPx: 2.4 };
const CLOUD: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false };
const SPHERE: SwarmSpec = { ...CLOUD, shape: 'sphere' };

const make = (seed?: number): SwarmEngine => createSwarm(300, { ...OPTIONS, ...(seed === undefined ? {} : { seed }) });
const snapshot = (engine: SwarmEngine): number[] => engine.souls.flatMap((s) => [s.x, s.y, s.z]);

describe('движок роя', () => {
  it('детерминизм: один seed и одинаковые кадры дают одинаковые души', () => {
    const a = make(3);
    const b = make(3);
    for (const engine of [a, b]) {
      engine.setSpec(CLOUD, 0, false);
      engine.frame(0, null, false, 0);
      engine.frame(16, null, false, 0);
      engine.frame(32, null, false, 0);
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    const other = make(4);
    other.setSpec(CLOUD, 0, false);
    other.frame(0, null, false, 0);
    expect(snapshot(other)).not.toEqual(snapshot(a));
  });

  it('облако: все души в пределах |x|, |y| ≤ 1.6', () => {
    const engine = make();
    engine.setSpec(CLOUD, 0, false);
    for (let i = 0; i < 5; i++) engine.frame(i * 16, null, false, 0);
    for (const soul of engine.souls) {
      expect(Math.abs(soul.x)).toBeLessThanOrEqual(1.6);
      expect(Math.abs(soul.y)).toBeLessThanOrEqual(1.6);
    }
  });

  it('сфера: после перехода не-корональные души лежат на радиусе 0.5 ± 0.03', () => {
    const engine = make();
    engine.setSpec(CLOUD, 0, false);
    engine.frame(0, null, false, 0);
    engine.setSpec(SPHERE, 1000, false);
    engine.frame(1000 + (DUR.cloudsphere + 0.1) * 1000, null, false, 0);
    const shell = engine.souls.filter((s) => !s.corona);
    expect(shell.length).toBeGreaterThan(100);
    for (const soul of shell) {
      expect(Math.hypot(soul.x, soul.y, soul.z)).toBeGreaterThan(0.47);
      expect(Math.hypot(soul.x, soul.y, soul.z)).toBeLessThan(0.53);
    }
  });

  it('needsFrame: истинно после смены спеки и во время перехода, ложно после', () => {
    const engine = make();
    expect(engine.needsFrame()).toBe(false);
    engine.setSpec(CLOUD, 0, false);
    expect(engine.needsFrame()).toBe(true);
    engine.frame(0, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
    engine.setSpec(SPHERE, 1000, false);
    engine.frame(1016, null, false, 0);
    expect(engine.needsFrame()).toBe(true);
    engine.frame(1000 + (DUR.cloudsphere + 0.1) * 1000, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
  });

  it('смена палитры держит кадры 0,3 с', () => {
    const engine = make();
    engine.setSpec(CLOUD, 0, false);
    engine.frame(0, null, false, 0);
    engine.setSpec({ ...CLOUD, pal: 'gray' }, 100, false);
    engine.frame(116, null, false, 0);
    expect(engine.needsFrame()).toBe(true);
    for (let t = 132; t < 600; t += 16) engine.frame(t, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
  });

  it('reduced motion: переход не длится — сразу цель', () => {
    const engine = make();
    engine.setSpec(CLOUD, 0, true);
    engine.frame(0, null, true, 0);
    engine.setSpec(SPHERE, 100, true);
    engine.frame(100, null, true, 0);
    expect(engine.needsFrame()).toBe(false);
    for (const soul of engine.souls.filter((s) => !s.corona)) {
      expect(Math.hypot(soul.x, soul.y, soul.z)).toBeGreaterThan(0.47);
      expect(Math.hypot(soul.x, soul.y, soul.z)).toBeLessThan(0.53);
    }
  });

  it('кадр до первой спеки ничего не делает', () => {
    const engine = make();
    expect(() => engine.frame(0, null, false, 0)).not.toThrow();
    expect(engine.needsFrame()).toBe(false);
  });
});
