/**
 * Реакции роя (#9 §4.1–§4.3, §4.5, §7): каналы реакций, замена вспышкой в малом рое, в лице (V3) и при уменьшенном
 * движении, кадры только на длительность реакции (M1, P1), центровка (§4.2) и детерминизм по seed. Положения и яркость
 * снимаются с записывающего контекста: центр каждого `drawImage` и `globalAlpha` в момент вызова.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSwarm, type SwarmEngine, type SwarmOptions } from './engine.js';
import { REACTION_FOR, type SwarmReaction, type SwarmSpec } from './spec.js';

const BIG = { width: 420, height: 136, d: 86, cy: 62, k: 0.058, minPx: 2.4 };
const MINI = { width: 28, height: 28, d: 17, cy: 14, k: 0.15, minPx: 1.5, seed: 5 };
const CLOUD: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };
const DOT: SwarmSpec = { ...CLOUD, shape: 'dot' };
const SPHERE: SwarmSpec = { ...CLOUD, shape: 'sphere' };
const FACE: SwarmSpec = { ...CLOUD, shape: 'face', emo: 'calm' };
const ALL: SwarmReaction[] = ['breathe', 'glint', 'hop', 'nod', 'spin', 'shake', 'lean'];
/** Длительность реакции, мс (#9 §4.1). */
const DUR: Record<SwarmReaction | 'flash', number> = { breathe: 700, glint: 450, hop: 450, nod: 700, spin: 1400, shake: 290, lean: 520, flash: 300 };

interface Dot {
  x: number;
  y: number;
  a: number;
}

/** Записывающий контекст: центры душ и их яркость за последний кадр. */
function recorder(): { ctx: CanvasRenderingContext2D; dots: Dot[] } {
  const dots: Dot[] = [];
  let alpha = 1;
  const ctx = {
    globalCompositeOperation: '',
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    clearRect: () => dots.splice(0),
    drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => dots.push({ x: x + w / 2, y: y + h / 2, a: alpha }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, dots };
}

interface Rig {
  engine: SwarmEngine;
  dots: Dot[];
  at: (t: number) => Dot[];
}

/** Рой в облике `spec` с 0 мс и кадром в 3000 мс, когда переходы кончились; дальше кадры по `at`. */
function rig(options: SwarmOptions, spec: SwarmSpec, reduced = false, count = 300): Rig {
  const engine = createSwarm(count, options);
  const { ctx, dots } = recorder();
  engine.setSpec(spec, 0, reduced);
  engine.frame(0, ctx, reduced, 0);
  engine.frame(3000, ctx, reduced, 0);
  return {
    engine,
    dots,
    at: (t) => {
      engine.frame(t, ctx, reduced, 0);
      return dots.map((d) => ({ ...d }));
    },
  };
}

/** Пара: рой с реакцией в 4000 мс и такой же рой без неё; кадры у обоих одинаковые. */
function pair(options: SwarmOptions, spec: SwarmSpec, reaction: SwarmReaction, reduced = false): { on: Rig; off: Rig } {
  const on = rig(options, spec, reduced);
  const off = rig(options, spec, reduced);
  for (let t = 3016; t < 4000; t += 16) {
    on.at(t);
    off.at(t);
  }
  on.engine.react(reaction, 4000, 4000, reduced);
  return { on, off };
}

const brightness = (dots: Dot[]): number => dots.reduce((a, d) => a + d.a, 0);
const maxShift = (a: Dot[], b: Dot[]): number => Math.max(...a.map((d, i) => Math.hypot(d.x - b[i]!.x, d.y - b[i]!.y)));
const centroid = (dots: Dot[]): { x: number; y: number } => ({
  x: dots.reduce((s, d) => s + d.x, 0) / dots.length,
  y: dots.reduce((s, d) => s + d.y, 0) / dots.length,
});

beforeAll(() => {
  // Спрайтам нужен 2d-контекст документа; jsdom его не даёт — подставляем заглушку.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('реакции роя', () => {
  it('M1: каждое событие таблицы §4.1 — своя реакция', () => {
    expect(REACTION_FOR).toEqual({
      start: 'breathe',
      tool: 'glint',
      permission: 'hop',
      question: 'nod',
      plan: 'hop',
      done: 'spin',
      error: 'shake',
      hover: 'lean',
    });
  });

  it('M1: большой рой играет каждую реакцию как есть, кадры — ровно на её длительность', () => {
    for (const reaction of ALL) {
      const { on } = pair(BIG, SPHERE, reaction);
      expect(on.engine.debug.reacts).toEqual([reaction]);
      expect(on.engine.needsFrame()).toBe(true);
      for (let t = 4000; t < 4000 + DUR[reaction]; t += 33) {
        on.at(t);
        expect(on.engine.needsFrame()).toBe(true);
      }
      on.at(4000 + DUR[reaction]);
      expect(on.engine.debug.reacts).toEqual([]);
      expect(on.engine.needsFrame()).toBe(false);
    }
  });

  it('hop и nod сдвигают все души вверх на одно и то же, shake — вбок; потом всё на месте', () => {
    const cases: Array<[SwarmReaction, number, 'x' | 'y', number]> = [
      ['hop', 4150, 'y', -0.13],
      ['nod', 4110, 'y', -0.07],
      ['shake', 4050, 'x', 0.07],
    ];
    for (const [reaction, peak, axis, shift] of cases) {
      const { on, off } = pair(BIG, CLOUD, reaction);
      const a = on.at(peak);
      const b = off.at(peak);
      const other = axis === 'x' ? 'y' : 'x';
      a.forEach((d, i) => {
        expect(d[axis] - b[i]![axis]).toBeCloseTo(shift * BIG.d, 6);
        expect(d[other]).toBeCloseTo(b[i]![other], 6);
      });
    }
  });

  it('breathe и lean: масштаб относительно центра и ярче; glint — только яркость, без сдвига', () => {
    for (const [reaction, t, scale] of [['breathe', 4180, 0.9], ['lean', 4160, 1.05]] as const) {
      const { on, off } = pair(BIG, CLOUD, reaction);
      const a = on.at(t);
      const b = off.at(t);
      a.forEach((d, i) => {
        expect(d.x - BIG.width / 2).toBeCloseTo((b[i]!.x - BIG.width / 2) * scale, 6);
        expect(d.y - BIG.cy).toBeCloseTo((b[i]!.y - BIG.cy) * scale, 6);
      });
      expect(brightness(a)).toBeGreaterThan(brightness(b));
    }
    const { on, off } = pair(BIG, SPHERE, 'glint');
    const a = on.at(4200);
    const b = off.at(4200);
    expect(maxShift(a, b)).toBe(0);
    expect(brightness(a)).toBeGreaterThan(brightness(b) * 1.02);
  });

  it('spin: души оборачиваются, искры у части душ; через 1,4 с — снова прежний рой', () => {
    for (const spec of [CLOUD, SPHERE]) {
      const { on, off } = pair(BIG, spec, 'spin');
      expect(maxShift(on.at(4400), off.at(4400))).toBeGreaterThan(5);
      const a = on.at(4950);
      const b = off.at(4950);
      const lit = a.filter((d, i) => d.a > b[i]!.a * 1.2).length;
      expect(lit).toBeGreaterThan(0);
      expect(lit).toBeLessThan(a.length * 0.3);
      for (let t = 4966; t < 5400; t += 33) {
        on.at(t);
        off.at(t);
      }
      expect(on.at(5400)).toEqual(off.at(5400));
    }
  });

  it('§4.2 центровка: после каждой реакции души там же, где у роя без неё; центр — width / 2 и cy', () => {
    for (const options of [BIG, { ...BIG, width: 300, cy: 70 }]) {
      for (const reaction of ALL) {
        const { on, off } = pair(options, CLOUD, reaction);
        for (let t = 4000; t <= 5500; t += 33) {
          on.at(t);
          off.at(t);
        }
        const a = on.at(5500);
        expect(a).toEqual(off.at(5500));
        const c = centroid(a);
        expect(Math.abs(c.x - options.width / 2)).toBeLessThan(options.d * 0.2);
        expect(Math.abs(c.y - options.cy)).toBeLessThan(options.d * 0.2);
      }
    }
  });

  it('§4.3: малый рой — hop, nod, shake только вспышкой 300 мс без сдвига; breathe и spin остаются', () => {
    for (const reaction of ['hop', 'nod', 'shake'] as const) {
      const { on, off } = pair(MINI, DOT, reaction);
      expect(on.engine.debug.reacts).toEqual(['flash']);
      const a = on.at(4150);
      const b = off.at(4150);
      expect(maxShift(a, b)).toBe(0);
      expect(brightness(a)).toBeGreaterThan(brightness(b));
      on.at(4300);
      expect(on.engine.needsFrame()).toBe(false);
    }
    for (const reaction of ['breathe', 'spin', 'glint', 'lean'] as const) {
      const { on } = pair(MINI, DOT, reaction);
      expect(on.engine.debug.reacts).toEqual([reaction]);
    }
  });

  it('V3: пока говорит лицо, любая реакция — только вспышка, души лица не двигаются', () => {
    for (const reaction of ALL) {
      const { on, off } = pair(BIG, FACE, reaction);
      expect(on.engine.debug.reacts).toEqual(['flash']);
      for (let t = 4000; t <= 4300; t += 50) {
        const a = on.at(t);
        const b = off.at(t);
        expect(maxShift(a, b)).toBe(0);
        if (t > 4000 && t < 4300) expect(brightness(a)).toBeGreaterThan(brightness(b));
      }
      expect(on.engine.needsFrame()).toBe(false);
    }
  });

  it('V3: реакция со сдвигом, начатая до лица, лицо не толкает', () => {
    const on = rig(BIG, SPHERE);
    const off = rig(BIG, SPHERE);
    on.engine.react('hop', 3000, 3000, false);
    for (const r of [on, off]) r.engine.setSpec(FACE, 3000, false);
    for (let t = 3016; t < 3450; t += 16) expect(maxShift(on.at(t), off.at(t))).toBe(0);
  });

  it('§4.5 уменьшенное движение: любая реакция — вспышка без движения, кадры только на 300 мс', () => {
    for (const reaction of ALL) {
      const { on, off } = pair(BIG, SPHERE, reaction, true);
      expect(on.engine.debug.reacts).toEqual(['flash']);
      const a = on.at(4150);
      const b = off.at(4150);
      expect(maxShift(a, b)).toBe(0);
      expect(brightness(a)).toBeGreaterThan(brightness(b));
      on.at(4300);
      expect(on.engine.needsFrame()).toBe(false);
    }
  });

  it('P1: в покое кадров не просят; та же реакция заново начинается сначала; просроченная не ставится', () => {
    const { on } = pair(MINI, DOT, 'spin');
    on.at(4500);
    on.engine.react('spin', 4500, 4500, false);
    expect(on.engine.debug.reacts).toEqual(['spin']);
    on.at(5850);
    expect(on.engine.needsFrame()).toBe(true);
    on.at(5900);
    expect(on.engine.needsFrame()).toBe(false);
    on.engine.react('spin', 1000, 5900, false);
    expect(on.engine.debug.reacts).toEqual([]);
    expect(on.engine.needsFrame()).toBe(false);
  });

  it('детерминизм: один seed и одни кадры — одинаковые положения и яркость во время реакций', () => {
    const run = (seed: number): Dot[][] => {
      const r = rig({ ...BIG, seed }, CLOUD);
      const out: Dot[][] = [];
      r.engine.react('spin', 3100, 3100, false);
      r.engine.react('glint', 3200, 3200, false);
      for (let t = 3100; t <= 4600; t += 100) out.push(r.at(t));
      return out;
    };
    expect(run(3)).toEqual(run(3));
    expect(run(4)).not.toEqual(run(3));
  });
});
