/** Движок роя без canvas (`ctx = null`): детерминизм, границы облака, радиус сферы, лицо, переходы и reduced motion. */

import { describe, expect, it } from 'vitest';
import { createSwarm, type SwarmEngine } from './engine.js';
import { DUR, type SwarmEmotion, type SwarmSpec } from './spec.js';

const OPTIONS = { width: 420, height: 136, d: 86, cy: 62, k: 0.058, minPx: 2.4 };
const CLOUD: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };
const SPHERE: SwarmSpec = { ...CLOUD, shape: 'sphere' };
const face = (emo: SwarmEmotion, pal: SwarmSpec['pal'] = 'amber'): SwarmSpec => ({ ...CLOUD, shape: 'face', emo, pal });

const make = (seed?: number): SwarmEngine => createSwarm(300, { ...OPTIONS, ...(seed === undefined ? {} : { seed }) });
const snapshot = (engine: SwarmEngine): number[] => engine.souls.flatMap((s) => [s.x, s.y, s.z]);
/** Облако с 0 мс, лицо с 1000 мс; кадр после конца перехода облако → лицо (1,4 с + 0,2 с рта). */
const FACE_DONE = 1000 + (DUR.cloudface + 0.2 + 0.1) * 1000;
const toFace = (engine: SwarmEngine, spec: SwarmSpec, mouth = 0): void => {
  engine.setSpec(CLOUD, 0, false);
  engine.frame(0, null, false, 0);
  engine.setSpec(spec, 1000, false);
  engine.frame(FACE_DONE, null, false, 0, mouth);
};
/** Высота рта: разброс y душ роли 2 без короны. */
const mouthHeight = (engine: SwarmEngine): number => {
  const ys = engine.souls.filter((s) => s.role === 2 && !s.corona).map((s) => s.y);
  return Math.max(...ys) - Math.min(...ys);
};

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

  it('порядок генератора не изменился: облако и сфера по seed 3 — прежние числа', () => {
    const engine = make(3);
    engine.setSpec(CLOUD, 0, false);
    for (const t of [0, 16, 32]) engine.frame(t, null, false, 0);
    const cloud = engine.souls.slice(0, 3).flatMap((s) => [s.x, s.y, s.z]);
    [0.4099876769233541, -0.17981409222574976, 0.1690579408077658, 0.4680458185868283, 0.0714672131074287, 0.1330997690746168,
      -0.10309002929891917, -0.0155287491193505, 0.14148748832080096].forEach((v, i) => expect(cloud[i]).toBeCloseTo(v, 12));
    engine.setSpec(SPHERE, 1000, false);
    engine.frame(3000, null, false, 0);
    const sphere = engine.souls.slice(0, 3).flatMap((s) => [s.x, s.y, s.z]);
    [0.03937482466086842, 0.4870242077765116, 0.11572331778809582, -0.023327696490720994, 0.45594270366867157, 0.2090619802954048,
      -0.04335892001694279, 0.4980153327128785, 0.047281862221603896].forEach((v, i) => expect(sphere[i]).toBeCloseTo(v, 12));
    expect(engine.souls.filter((s) => s.corona).length).toBe(58);
  });

  it('лицо calm: роль 0 — в эллипсе левого глаза, роль 1 — правого, роль 2 — в полосе рта', () => {
    const engine = make();
    toFace(engine, face('calm'));
    const core = engine.souls.filter((s) => !s.corona);
    for (const role of [0, 1, 2] as const) expect(core.filter((s) => s.role === role).length).toBeGreaterThan(30);
    for (const s of core.filter((c) => c.role === 0)) {
      expect(Math.abs(s.x / 1.2 + 0.41)).toBeLessThanOrEqual(0.095 + 0.06);
      expect(Math.abs(s.y / 1.2 + 0.28)).toBeLessThanOrEqual(0.13 + 0.06);
    }
    for (const s of core.filter((c) => c.role === 1)) {
      expect(Math.abs(s.x / 1.2 - 0.41)).toBeLessThanOrEqual(0.095 + 0.06);
      expect(Math.abs(s.y / 1.2 + 0.28)).toBeLessThanOrEqual(0.13 + 0.06);
    }
    for (const s of core.filter((c) => c.role === 2)) {
      expect(Math.abs(s.x / 1.2)).toBeLessThanOrEqual(0.39 + 0.06);
      expect(Math.abs(s.y / 1.2 - 0.25)).toBeLessThanOrEqual(0.25);
    }
  });

  it('рот: mouth 1 выше, чем mouth 0', () => {
    const closed = make();
    const open = make();
    toFace(closed, face('calm'), 0);
    toFace(open, face('calm'), 1);
    expect(mouthHeight(open)).toBeGreaterThan(mouthHeight(closed) * 1.5);
  });

  it('лицо детерминировано: один seed и одинаковые кадры — одинаковые души через 5 с (моргание тоже)', () => {
    const a = make(3);
    const b = make(3);
    for (const engine of [a, b]) {
      engine.setSpec(SPHERE, 0, false);
      engine.frame(0, null, false, 0);
      engine.setSpec(face('calm'), 100, false);
      for (let t = 100; t <= 5100; t += 16) engine.frame(t, null, false, 0, 0.5 + 0.5 * Math.sin(t / 90));
    }
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('моргание: глаза сжимаются по вертикали хотя бы раз за 5 с, у surprise — никогда', () => {
    const spread = (engine: SwarmEngine): number => {
      const ys = engine.souls.filter((s) => s.role === 0 && !s.corona).map((s) => s.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    for (const [emo, blinks] of [['calm', true], ['surprise', false]] as const) {
      const engine = make();
      toFace(engine, face(emo));
      const open = spread(engine);
      let min = open;
      for (let t = FACE_DONE; t <= FACE_DONE + 5000; t += 16) {
        engine.frame(t, null, false, 0);
        min = Math.min(min, spread(engine));
      }
      if (blinks) expect(min).toBeLessThan(open * 0.5);
      else expect(min).toBeCloseTo(open, 9);
    }
  });

  it('переходы лица: sphere → face 0,8 с + 0,2 с рта, face → cloud 1,2 с', () => {
    const engine = make();
    engine.setSpec(SPHERE, 0, false);
    engine.frame(0, null, false, 0);
    engine.setSpec(face('calm'), 1000, false);
    expect(engine.debug).toMatchObject({ dur: DUR.sphereface, extra: 0.2 });
    engine.frame(1900, null, false, 0);
    expect(engine.needsFrame()).toBe(true); // 0,9 с: рот ещё входит
    engine.frame(2050, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
    engine.setSpec(CLOUD, 3000, false);
    expect(engine.debug).toMatchObject({ dur: DUR.facecloud, extra: 0 });
    expect([DUR.sphereface, DUR.facesphere, DUR.cloudface, DUR.facecloud]).toEqual([0.8, 0.8, 1.4, 1.2]);
  });

  it('смена эмоции в лице: joy → anger — переход 0,6 с, палитра коралл за 0,3 с', () => {
    const engine = make();
    toFace(engine, face('joy'));
    engine.setSpec(face('anger', 'coral'), 5000, false);
    expect(engine.debug).toMatchObject({ dur: 0.6, extra: 0, pal: 'coral' });
    for (let t = 5016; t <= 5584; t += 16) engine.frame(t, null, false, 0);
    expect(engine.needsFrame()).toBe(true); // 0,584 с < 0,6 с
    engine.frame(5616, null, false, 0);
    expect(engine.needsFrame()).toBe(false);
  });

  it('surprise: вспышка на входе, спад за 0,6 с; без неё у других эмоций', () => {
    const engine = make();
    toFace(engine, face('calm'));
    expect(engine.debug.flash).toBe(0);
    engine.setSpec(face('surprise'), 5000, false);
    expect(engine.debug.flash).toBe(1);
    engine.frame(5016, null, false, 0);
    expect(engine.debug.flash).toBeGreaterThan(0.9);
    for (let t = 5032; t <= 5700; t += 16) engine.frame(t, null, false, 0);
    expect(engine.debug.flash).toBe(0);
  });

  it('reduced motion в лице: рот amp 0.3 независимо от mouth, без моргания и вспышки', () => {
    const a = make();
    const b = make();
    for (const [engine, mouth] of [[a, 0], [b, 1]] as const) {
      engine.setSpec(face('surprise'), 0, true);
      engine.frame(0, null, true, 0, mouth);
      expect(engine.debug.flash).toBe(0);
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    const calm = make();
    calm.setSpec(face('calm'), 0, true);
    calm.frame(0, null, true, 0, 0);
    const before = snapshot(calm);
    for (let t = 100; t <= 6000; t += 100) {
      calm.setSpec(face('calm'), t, true);
      calm.frame(t, null, true, 0, 1);
      expect(snapshot(calm)).toEqual(before);
    }
  });

  it('кадр до первой спеки ничего не делает', () => {
    const engine = make();
    expect(() => engine.frame(0, null, false, 0)).not.toThrow();
    expect(engine.needsFrame()).toBe(false);
  });
});
