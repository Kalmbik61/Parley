/**
 * Движок роя без canvas (`ctx = null`): детерминизм, границы облака, радиус сферы, лицо, переходы и reduced motion;
 * формы рта по кадру голоса (L1, F1) и пороги «рот не пропадает» (F5).
 */

import { describe, expect, it } from 'vitest';
import type { VoiceFrame, Visemes } from '../assistant/voice-features.js';
import { createSwarm, type SwarmEngine, type SwarmOptions } from './engine.js';
import { DUR, EMO, type SwarmEmotion, type SwarmSpec } from './spec.js';

const OPTIONS = { width: 420, height: 136, d: 86, cy: 62, k: 0.058, minPx: 2.4 };
const CLOUD: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };
const SPHERE: SwarmSpec = { ...CLOUD, shape: 'sphere' };
const face = (emo: SwarmEmotion, pal: SwarmSpec['pal'] = 'amber'): SwarmSpec => ({ ...CLOUD, shape: 'face', emo, pal });

const make = (seed?: number): SwarmEngine => createSwarm(300, { ...OPTIONS, ...(seed === undefined ? {} : { seed }) });
const NO_SHAPE: Visemes = { a: 0, i: 0, u: 0, m: 0 };
/** Кадр голоса: громкость и веса форм (по умолчанию — без формы). */
const voice = (amp: number, visemes: Partial<Visemes> = {}): VoiceFrame => ({ amp, visemes: { ...NO_SHAPE, ...visemes } });
const snapshot = (engine: SwarmEngine): number[] => engine.souls.flatMap((s) => [s.x, s.y, s.z]);
/** Облако с 0 мс, лицо с 1000 мс; кадр после конца перехода облако → лицо (1,4 с + 0,2 с рта). */
const FACE_DONE = 1000 + (DUR.cloudface + 0.2 + 0.1) * 1000;
const toFace = (engine: SwarmEngine, spec: SwarmSpec, frame: VoiceFrame | null = null): void => {
  engine.setSpec(CLOUD, 0, false);
  engine.frame(0, null, false, 0);
  engine.setSpec(spec, 1000, false);
  engine.frame(FACE_DONE, null, false, 0, frame);
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

  it('рот: amp 1 выше, чем amp 0', () => {
    const closed = make();
    const open = make();
    toFace(closed, face('calm'), voice(0));
    toFace(open, face('calm'), voice(1));
    expect(mouthHeight(open)).toBeGreaterThan(mouthHeight(closed) * 1.5);
  });

  it('лицо детерминировано: один seed и одинаковые кадры — одинаковые души через 5 с (моргание тоже)', () => {
    const a = make(3);
    const b = make(3);
    for (const engine of [a, b]) {
      engine.setSpec(SPHERE, 0, false);
      engine.frame(0, null, false, 0);
      engine.setSpec(face('calm'), 100, false);
      for (let t = 100; t <= 5100; t += 16) engine.frame(t, null, false, 0, voice(0.5 + 0.5 * Math.sin(t / 90), { u: 0.4 + 0.4 * Math.sin(t / 70) }));
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

  it('F4, reduced motion в лице: L1 выключен — рот amp 0.3 при любом кадре голоса, без моргания и вспышки', () => {
    const a = make();
    const b = make();
    for (const [engine, frame] of [[a, null], [b, voice(1, { u: 0.8 })]] as const) {
      engine.setSpec(face('surprise'), 0, true);
      engine.frame(0, null, true, 0, frame);
      expect(engine.debug.flash).toBe(0);
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    const calm = make();
    calm.setSpec(face('calm'), 0, true);
    calm.frame(0, null, true, 0, voice(0));
    const before = snapshot(calm);
    const shapes: Array<Partial<Visemes>> = [{ a: 0.8 }, { i: 0.8 }, { u: 0.8 }, { m: 0.8 }];
    for (let t = 100; t <= 6000; t += 100) {
      calm.setSpec(face('calm'), t, true);
      calm.frame(t, null, true, 0, voice((t / 100) % 2, shapes[(t / 100) % 4]));
      expect(snapshot(calm)).toEqual(before);
    }
    const reference = make();
    reference.setSpec(face('calm'), 0, false);
    reference.frame(0, null, false, 0, voice(0.3));
    expect(mouthHeight(calm)).toBeCloseTo(mouthHeight(reference), 9); // статичный рот — amp 0,3 без форм
  });

  it('кадр до первой спеки ничего не делает', () => {
    const engine = make();
    expect(() => engine.frame(0, null, false, 0)).not.toThrow();
    expect(engine.needsFrame()).toBe(false);
  });
});

/** Рой лица как в окне помощника (700 душ) с данным режимом голоса; кадр после входа в лицо. */
const faceSwarm = (emo: SwarmEmotion, frame: VoiceFrame | null, voiceMode?: SwarmOptions['voiceMode']): SwarmEngine => {
  const engine = createSwarm(700, { ...OPTIONS, ...(voiceMode === undefined ? {} : { voiceMode }) });
  toFace(engine, face(emo), frame);
  return engine;
};
const mouthSouls = (engine: SwarmEngine): Array<{ x: number; y: number }> => engine.souls.filter((s) => s.role === 2 && !s.corona);
/** Ширина рта: размах x душ рта. */
const mouthWidth = (engine: SwarmEngine): number => {
  const xs = mouthSouls(engine).map((s) => s.x);
  return Math.max(...xs) - Math.min(...xs);
};
const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.round(p * (sorted.length - 1))]!;
};
/** Толщина штриха у `cx`: размах души поперёк средней линии (линейная подгонка) в полосе ±0,03 d. */
const strokeAt = (souls: ReadonlyArray<{ x: number; y: number }>, cx: number): number => {
  const near = souls.filter((s) => Math.abs(s.x - cx) <= 0.03);
  const mx = near.reduce((a, s) => a + s.x, 0) / near.length;
  const my = near.reduce((a, s) => a + s.y, 0) / near.length;
  const sxx = near.reduce((a, s) => a + (s.x - mx) ** 2, 0);
  const slope = sxx > 0 ? near.reduce((a, s) => a + (s.x - mx) * (s.y - my), 0) / sxx : 0;
  const rest = near.map((s) => s.y - my - slope * (s.x - mx));
  return Math.max(...rest) - Math.min(...rest);
};
/**
 * Рот-линия по F5 (в долях d): длина — между 5-м и 95-м перцентилями x душ рта; толщина в середине и на концах — штрих
 * в точке середины и в точках этих перцентилей.
 */
const lineMouth = (engine: SwarmEngine): { length: number; middle: number; ends: number } => {
  const souls = mouthSouls(engine);
  const xs = souls.map((s) => s.x);
  const x5 = percentile(xs, 0.05);
  const x95 = percentile(xs, 0.95);
  return { length: x95 - x5, middle: strokeAt(souls, (x5 + x95) / 2), ends: Math.min(strokeAt(souls, x5), strokeAt(souls, x95)) };
};
/** Формы рта F5: тишина, тихая речь, закрыт, «о/у» наполовину и полностью, «а», «и/е» — и громкие варианты. */
const FORMS: Array<{ name: string; frame: VoiceFrame; round: boolean }> = [
  { name: 'тишина', frame: voice(0), round: false },
  { name: 'тихая речь', frame: voice(0.15), round: false },
  { name: 'закрыт', frame: voice(0.6, { m: 1 }), round: false },
  { name: '«о/у» наполовину', frame: voice(0.5, { u: 0.5 }), round: true },
  { name: '«о/у» полностью', frame: voice(0.5, { u: 1 }), round: true },
  { name: '«о/у» тихо', frame: voice(0, { u: 1 }), round: true },
  { name: '«а»', frame: voice(1, { a: 1 }), round: false },
  { name: '«и/е»', frame: voice(0.8, { i: 1 }), round: false },
  { name: '«и/е» тихо', frame: voice(0, { i: 1 }), round: false },
];
const LINE_EMOTIONS: SwarmEmotion[] = ['calm', 'joy', 'sad', 'anger', 'error'];

describe('лицо: формы рта по голосу (L1, F1)', () => {
  it('«о/у» сужает рот, «а» поднимает, «и/е» растягивает и понижает, закрытый — тонкая линия', () => {
    const plain = faceSwarm('calm', voice(0.5));
    const round = faceSwarm('calm', voice(0.5, { u: 1 }));
    const wide = faceSwarm('calm', voice(0.5, { a: 1 }));
    const smile = faceSwarm('calm', voice(0.5, { i: 1 }));
    const closed = faceSwarm('calm', voice(0.5, { m: 1 }));
    expect(mouthWidth(round)).toBeLessThan(mouthWidth(plain) * 0.75);
    expect(mouthHeight(wide)).toBeGreaterThan(mouthHeight(plain) * 1.25);
    expect(mouthWidth(smile)).toBeGreaterThan(mouthWidth(plain) * 1.15);
    expect(lineMouth(smile).middle).toBeLessThan(lineMouth(plain).middle);
    expect(lineMouth(closed).middle).toBeLessThan(lineMouth(plain).middle * 0.6);
  });

  it('surprise: свой овал, L1 меняет только его высоту и ширину в пределах; овал не уже 0,65·mw и не ниже 0,5·H0', () => {
    const { mw, H0 } = EMO.surprise;
    for (const frame of [voice(0), voice(0.5, { u: 1 }), voice(0.5, { m: 1 }), voice(1, { a: 1 }), voice(1, { i: 1 })]) {
      const engine = faceSwarm('surprise', frame);
      const ys = mouthSouls(engine).map((s) => s.y);
      expect(mouthWidth(engine)).toBeGreaterThanOrEqual(0.65 * mw);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(0.5 * H0);
    }
  });

  it('режим громкости = v1: формы не действуют, рот идёт только по amp; в полном режиме формы действуют', () => {
    for (const shape of [{ a: 0.8 }, { i: 0.8 }, { u: 0.8 }, { m: 0.8 }]) {
      for (const amp of [0, 0.4, 1]) {
        expect(snapshot(faceSwarm('calm', voice(amp, shape), 'loudness'))).toEqual(snapshot(faceSwarm('calm', voice(amp), 'loudness')));
        expect(snapshot(faceSwarm('calm', voice(amp, shape)))).not.toEqual(snapshot(faceSwarm('calm', voice(amp))));
      }
    }
    expect(mouthHeight(faceSwarm('calm', voice(1), 'loudness'))).toBeGreaterThan(mouthHeight(faceSwarm('calm', voice(0), 'loudness')) * 1.5);
  });

  it('без кадра голоса рот закрыт: как amp 0 без форм', () => {
    expect(snapshot(faceSwarm('joy', null))).toEqual(snapshot(faceSwarm('joy', voice(0))));
  });
});

describe('лицо: рот не пропадает (F5)', () => {
  for (const emo of LINE_EMOTIONS) {
    it(`${emo}: длина ≥ 0,95·mw (у «о/у» ≥ 0,6·mw), штрих в середине ≥ 0,055 d, на концах ≥ 0,05 d`, () => {
      const { mw } = EMO[emo];
      for (const form of FORMS) {
        for (const voiceMode of ['full', 'loudness'] as const) {
          const m = lineMouth(faceSwarm(emo, form.frame, voiceMode));
          const where = `${emo}, ${form.name}, ${voiceMode}`;
          expect(m.length, where).toBeGreaterThanOrEqual((form.round && voiceMode === 'full' ? 0.6 : 0.95) * mw);
          expect(m.middle, where).toBeGreaterThanOrEqual(0.055);
          expect(m.ends, where).toBeGreaterThanOrEqual(0.05);
        }
      }
    });
  }

  it('речь в обоих режимах: пороги держатся в каждом кадре вне переходов', () => {
    // Кадры речи — как у анализа: веса с нейтральной долей 0,25, громкость скачет; генератор с фиксированным seed.
    let seed = 11;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const emo of LINE_EMOTIONS) {
      for (const voiceMode of ['full', 'loudness'] as const) {
        const engine = createSwarm(700, { ...OPTIONS, voiceMode });
        toFace(engine, face(emo));
        const { mw } = EMO[emo];
        for (let t = FACE_DONE; t < FACE_DONE + 2000; t += 16) {
          const w = [random(), random(), random(), random()].map((v) => (random() < 0.5 ? 0 : v));
          const sum = w.reduce((a, v) => a + v, 0.25);
          engine.frame(t, null, false, 0, voice(random() < 0.2 ? 0 : random(), { a: w[0]! / sum, i: w[1]! / sum, u: w[2]! / sum, m: w[3]! / sum }));
          const m = lineMouth(engine);
          const where = `${emo}, ${voiceMode}, ${t} мс`;
          expect(m.length, where).toBeGreaterThanOrEqual((voiceMode === 'full' ? 0.6 : 0.95) * mw);
          expect(m.middle, where).toBeGreaterThanOrEqual(0.055);
          expect(m.ends, where).toBeGreaterThanOrEqual(0.05);
        }
      }
    }
  });
});
