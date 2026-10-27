/**
 * Признаки голоса для лица, слои L1 и L2 (план 3b B17, B21; #9 §6.7, приёмка F1, F2 и F4): громкость рта по плану 3
 * v1, виземы по полосам спектра с самонормировкой, сглаживание; интонация — F0, ударный импульс, моргание в паузе,
 * вопрос по тону и по «?»; reduced motion и бюджет кадра. Буферы заданные: синус во времени и спектр с двумя
 * формантами в дБ, как их отдаёт `AnalyserNode` (fftSize 2048) через `speaker.read`.
 */

import { describe, expect, it } from 'vitest';

import { createVoiceAnalysis, type VoiceAnalysis, type VoiceFrame } from './voice-features.js';

const SAMPLE_RATE = 48000;
const FFT = 2048;
const DT = 1 / 60;

/** Временной буфер: синус `hz` (по умолчанию 140 Гц) с амплитудой `peak`; 0 — тишина. */
function wave(peak: number, hz = 140): Float32Array<ArrayBuffer> {
  const out = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) out[i] = peak * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return out;
}

/** Спектр в дБ по бинам: форманты — гауссовы горбы шириной 120 Гц над полом −100 дБ; без формант — тишина (−∞). */
function spectrum(formants: ReadonlyArray<readonly [hz: number, db: number]>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(FFT / 2);
  const binHz = SAMPLE_RATE / FFT;
  for (let k = 0; k < out.length; k++) {
    if (formants.length === 0) {
      out[k] = -Infinity;
      continue;
    }
    let power = 1e-10;
    for (const [hz, db] of formants) power += 10 ** (db / 10) * Math.exp(-(((k * binHz - hz) / 120) ** 2));
    out[k] = 10 * Math.log10(power);
  }
  return out;
}

type Sound = 'a' | 'i' | 'u' | 'pause';
/** Гласные по формантам F1, F2: «а» — высокая F1, «и» — низкая F1 и высокая F2, «у» — обе низкие. */
const BUFFERS: Record<Sound, { time: Float32Array<ArrayBuffer>; freq: Float32Array<ArrayBuffer> }> = {
  a: { time: wave(0.3), freq: spectrum([[750, -20], [1200, -26]]) },
  i: { time: wave(0.3), freq: spectrum([[280, -20], [2300, -26]]) },
  u: { time: wave(0.3), freq: spectrum([[300, -20], [650, -34]]) },
  pause: { time: wave(0), freq: spectrum([]) },
};
/** Кадр при reduced motion: L1 и L2 выключены, рот amp 0,3. */
const NEUTRAL_REDUCED: VoiceFrame = { amp: 0.3, visemes: { a: 0, i: 0, u: 0, m: 0 }, pulse: 0, eyesUp: 0, blink: false, loud: 0 };
const WINNER: Record<Sound, keyof VoiceFrame['visemes']> = { a: 'a', i: 'i', u: 'u', pause: 'm' };

/** Звуки по `ms` каждый, кадр раз в 1/60 с; возвращает кадры с меткой звучащего звука. */
function play(analysis: VoiceAnalysis, sounds: readonly Sound[], ms: number, clock = { now: 0 }): Array<{ sound: Sound; frame: VoiceFrame }> {
  const out: Array<{ sound: Sound; frame: VoiceFrame }> = [];
  for (const sound of sounds) {
    for (let t = 0; t < ms; t += DT * 1000) {
      clock.now += DT * 1000;
      out.push({ sound, frame: analysis.step(BUFFERS[sound].time, BUFFERS[sound].freq, DT, clock.now, false) });
    }
  }
  return out;
}

const winner = (frame: VoiceFrame): keyof VoiceFrame['visemes'] =>
  (Object.entries(frame.visemes) as Array<[keyof VoiceFrame['visemes'], number]>).reduce((best, next) => (next[1] > best[1] ? next : best))[0];

/** Рот плана 3 v1 (`speaker.mouth()`): `clamp((rms − 0,02) / 0,25)` по последним 512 отсчётам, атака мгновенная, спад 0,08 с. */
function mouthV1(levels: readonly number[]): number[] {
  let level = 0;
  return levels.map((peak) => {
    const samples = wave(peak).subarray(FFT - 512);
    let energy = 0;
    for (const v of samples) energy += v * v;
    const target = Math.min(1, Math.max(0, (Math.sqrt(energy / 512) - 0.02) / 0.25));
    level = Math.max(target, level - DT / 0.08);
    return level;
  });
}

describe('voice-features: L1', () => {
  it('F1: на гласных «а», «и», «у» побеждает своя форма, в паузе рот закрыт', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    const clock = { now: 0 };
    // Голос нормирует себя сам: несколько циклов слогов, затем проверочный цикл.
    play(analysis, ['a', 'i', 'u', 'a', 'i', 'u', 'a', 'i', 'u', 'a', 'i', 'u'], 200, clock);
    const frames = play(analysis, ['a', 'i', 'u', 'pause'], 300, clock);
    for (const sound of ['a', 'i', 'u', 'pause'] as const) {
      const own = frames.filter((f) => f.sound === sound);
      // Последние 100 мс звука: сглаживание уже догнало.
      for (const { frame } of own.slice(-6)) expect(winner(frame)).toBe(WINNER[sound]);
    }
    const last = frames[frames.length - 1]!.frame;
    expect(last.amp).toBe(0);
    expect(last.visemes.m).toBeGreaterThan(0.75);
  });

  it('F1: смена формы сглажена — за 50 мс вес меняется не больше чем на 0,6', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    const sounds: Sound[] = [];
    for (let k = 0; k < 6; k++) sounds.push('a', 'pause', 'i', 'u', 'pause', 'a', 'u', 'i');
    const frames = play(analysis, sounds, 120).map((f) => f.frame.visemes);
    const lag = Math.round(0.05 / DT);
    let biggest = 0;
    for (let k = lag; k < frames.length; k++) {
      for (const key of ['a', 'i', 'u', 'm'] as const) biggest = Math.max(biggest, Math.abs(frames[k]![key] - frames[k - lag]![key]));
    }
    expect(biggest).toBeGreaterThan(0.2); // формы действительно меняются
    expect(biggest).toBeLessThanOrEqual(0.6);
  });

  it('веса — доли с нейтральной долей 0,25: каждый в 0..0,8', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    for (const { frame } of play(analysis, ['a', 'i', 'u', 'pause', 'u', 'a', 'pause', 'i'], 250)) {
      const { a, i, u, m } = frame.visemes;
      for (const w of [a, i, u, m]) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(0.8 + 1e-9);
      }
    }
  });

  it('F1, режим громкости = v1: amp — рот плана 3 (атака мгновенная, спад 0,08 с) на тех же буферах', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    const levels = [0, 0.05, 0.3, 0.3, 0.12, 0, 0, 0, 0, 0.5, 0.02, 0.2, 0, 0.08, 0.4];
    const amps = levels.map((peak) => analysis.step(wave(peak), BUFFERS.a.freq, DT, 0, false).amp);
    const v1 = mouthV1(levels);
    amps.forEach((amp, k) => expect(amp).toBeCloseTo(v1[k]!, 12));
  });

  it('до самонормировки (первые звонкие кадры) открытые формы не выбираются: только пауза или нейтраль', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    const first = analysis.step(BUFFERS.a.time, BUFFERS.a.freq, DT, 0, false);
    expect(first.visemes.a).toBe(0);
    expect(first.visemes.i).toBe(0);
    expect(first.visemes.u).toBe(0);
  });

  it('F4, reduced motion: L1 выключен — нейтральный кадр, рот amp 0,3, буферы не читаются', () => {
    let reduced = true;
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => reduced });
    const untouched = new Proxy(new Float32Array(FFT), {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('буфер прочитан');
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    for (const sound of ['a', 'u', 'pause'] as const) {
      expect(analysis.step(untouched, BUFFERS[sound].freq, DT, 0, false)).toEqual(NEUTRAL_REDUCED);
    }
    reduced = false;
    expect(analysis.step(BUFFERS.a.time, BUFFERS.a.freq, DT, 0, false).amp).toBeGreaterThan(0.5);
  });

  it('F4: анализ кадра ≤ 0,5 мс на заданном буфере (медиана серий)', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });
    const { time, freq } = BUFFERS.a;
    const runs = 200;
    for (let k = 0; k < runs; k++) analysis.step(time, freq, DT, k, false); // прогрев JIT
    const perFrame: number[] = [];
    for (let series = 0; series < 31; series++) {
      const start = performance.now();
      for (let k = 0; k < runs; k++) analysis.step(time, freq, DT, k, false);
      perFrame.push((performance.now() - start) / runs);
    }
    perFrame.sort((x, y) => x - y);
    expect(perFrame[Math.floor(perFrame.length / 2)]!).toBeLessThanOrEqual(0.5);
  });
});

/** Отрезок речи: `ms` миллисекунд синуса `hz` с амплитудой `peak` (0 — пауза), кадр раз в 1/60 с. */
interface Segment {
  ms: number;
  peak: number;
  hz?: number;
  /** Вход `ask` у `step`: предложение кончается на «?». */
  ask?: boolean;
  /** Метка отрезка в кадрах. */
  tag?: string;
}

/** Отрезки подряд; кадры с меткой отрезка и временем `now`, мс. Спектр звонких кадров — «а», пауз — тишина. */
function speak(analysis: VoiceAnalysis, segments: readonly Segment[], clock = { now: 0 }): Array<{ tag: string; now: number; frame: VoiceFrame }> {
  const out: Array<{ tag: string; now: number; frame: VoiceFrame }> = [];
  segments.forEach((seg, k) => {
    const time = wave(seg.peak, seg.hz);
    const freq = seg.peak > 0 ? BUFFERS.a.freq : BUFFERS.pause.freq;
    for (let t = 0; t < seg.ms; t += DT * 1000) {
      clock.now += DT * 1000;
      out.push({ tag: seg.tag ?? String(k), now: clock.now, frame: analysis.step(time, freq, DT, clock.now, seg.ask === true) });
    }
  });
  return out;
}

const tagged = (frames: ReturnType<typeof speak>, tag: string): VoiceFrame[] => frames.filter((f) => f.tag === tag).map((f) => f.frame);
/** Сколько раз импульс начался: `pulse` вырос относительно прошлого кадра. */
const pulses = (frames: readonly VoiceFrame[], before = 0): number => {
  let count = 0;
  let prev = before;
  for (const f of frames) {
    if (f.pulse > prev) count++;
    prev = f.pulse;
  }
  return count;
};
const live = (): VoiceAnalysis => createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => false });

describe('voice-features: L2', () => {
  it('F2: подъём F0 на 20 % в конце фразы и пауза расширяют глаза; ровная фраза — нет', () => {
    const rising = speak(live(), [
      { ms: 600, peak: 0.3, hz: 140, tag: 'speech' },
      { ms: 250, peak: 0.3, hz: 168, tag: 'speech' },
      { ms: 500, peak: 0, tag: 'pause' },
    ]);
    for (const f of tagged(rising, 'speech')) expect(f.eyesUp).toBe(0);
    expect(Math.max(...tagged(rising, 'pause').map((f) => f.eyesUp))).toBeGreaterThan(0.8);

    const flat = speak(live(), [
      { ms: 850, peak: 0.3, hz: 140, tag: 'speech' },
      { ms: 500, peak: 0, tag: 'pause' },
    ]);
    for (const { frame } of flat) expect(frame.eyesUp).toBe(0);
  });

  it('F2: глаза держатся 0,9 с и снова сходятся', () => {
    const frames = speak(live(), [
      { ms: 600, peak: 0.3, hz: 140 },
      { ms: 250, peak: 0.3, hz: 168 },
      { ms: 2000, peak: 0, tag: 'pause' },
    ]);
    const pause = tagged(frames, 'pause');
    expect(pause[pause.length - 1]!.eyesUp).toBeLessThan(0.01);
  });

  it('F2: предложение с «?» расширяет глаза в своей паузе, а не во время речи; без «?» — нет', () => {
    for (const ask of [true, false]) {
      const frames = speak(live(), [
        { ms: 850, peak: 0.3, hz: 140, ask, tag: 'speech' },
        { ms: 500, peak: 0, ask, tag: 'pause' },
      ]);
      for (const f of tagged(frames, 'speech')) expect(f.eyesUp).toBe(0);
      const widest = Math.max(...tagged(frames, 'pause').map((f) => f.eyesUp));
      if (ask) expect(widest).toBeGreaterThan(0.8);
      else expect(widest).toBe(0);
    }
  });

  it('F2: ударный слог (+9 дБ) даёт ровно один импульс за 250 мс; +6 дБ — ни одного; спад 160 мс', () => {
    const frames = speak(live(), [
      { ms: 700, peak: 0.1, tag: 'warmup' },
      { ms: 500, peak: 0.1, tag: 'steady' },
      { ms: 250, peak: 0.32, tag: 'stress' },
      { ms: 500, peak: 0.1, tag: 'after' },
      { ms: 250, peak: 0.2, tag: 'soft' },
    ]);
    expect(pulses(tagged(frames, 'steady'))).toBe(0);
    const stress = tagged(frames, 'stress');
    expect(pulses(stress)).toBe(1);
    expect(stress[0]!.pulse).toBeGreaterThan(0.85);
    // Спад 160 мс: через 10 кадров (≈ 167 мс) импульса нет.
    expect(stress[10]!.pulse).toBe(0);
    expect(pulses(tagged(frames, 'soft'))).toBe(0);
  });

  it('F2: пауза 300 мс даёт моргание, пауза 200 мс — нет', () => {
    const frames = speak(live(), [
      { ms: 400, peak: 0.3 },
      { ms: 200, peak: 0, tag: 'short' },
      { ms: 400, peak: 0.3 },
      { ms: 300, peak: 0, tag: 'long' },
      { ms: 400, peak: 0.3, tag: 'speech' },
    ]);
    expect(tagged(frames, 'short').filter((f) => f.blink)).toHaveLength(0);
    expect(tagged(frames, 'long').filter((f) => f.blink)).toHaveLength(1);
    expect(tagged(frames, 'speech').filter((f) => f.blink)).toHaveLength(0);
  });

  it('моргание в долгой паузе — не чаще раза в 600 мс', () => {
    const frames = speak(live(), [
      { ms: 400, peak: 0.3 },
      { ms: 2000, peak: 0, tag: 'pause' },
    ]);
    const at = frames.filter((f) => f.tag === 'pause' && f.frame.blink).map((f) => f.now);
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!).toBeGreaterThan(600);
  });

  it('громкость кадра `loud` — (дБ + 45) / 30 по последним 512 отсчётам', () => {
    const analysis = live();
    const loudOf = (peak: number): number => analysis.step(wave(peak), BUFFERS.a.freq, DT, 0, false).loud;
    const expected = (peak: number): number => Math.min(1, Math.max(0, (20 * Math.log10(peak / Math.SQRT2) + 45) / 30));
    for (const peak of [0, 0.01, 0.05, 0.1, 0.5]) expect(loudOf(peak)).toBeCloseTo(expected(peak), 2);
  });

  it('F4, reduced motion: L2 выключен — нет импульса, моргания в паузе и подъёма глаз', () => {
    const analysis = createVoiceAnalysis({ sampleRate: SAMPLE_RATE, reducedMotion: () => true });
    const frames = speak(analysis, [
      { ms: 600, peak: 0.1, hz: 140, ask: true },
      { ms: 250, peak: 0.35, hz: 168, ask: true },
      { ms: 800, peak: 0, ask: true },
    ]);
    for (const { frame } of frames) expect(frame).toEqual(NEUTRAL_REDUCED);
  });
});
