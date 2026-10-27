/**
 * Признаки голоса для лица (план 3b B17, Р10; #9 §6.7, слой L1): порт `createVoiceAnalysis` прототипа
 * island-motion-sound. Раз в кадр из времени и спектра анализатора шины голоса (fftSize 2048, `speaker.read`) считаются
 * громкость рта и веса четырёх форм рта (визем). Анализатор читает вызывающий и только пока звучит голос; здесь —
 * чистые вычисления над переданными массивами, без Web Audio.
 *
 * - Громкость — рот плана 3 v1 (`speaker.mouth()`): `clamp((rms − 0,02) / 0,25)` по последним 512 отсчётам, атака
 *   мгновенная, спад линейный за 0,08 с. Поэтому режим лица «только громкость» повторяет v1 ровно (F1).
 * - Виземы — по энергиям полос 200–600, 600–1300 и 1300–3000 Гц: логарифмы отношений `mid/low` и `high/low`
 *   нормируются по самому голосу (скользящие среднее и дисперсия с постоянной 2 с, только по звонким кадрам), поэтому
 *   код один для любого голоса, движка и языка. Веса нормируются вместе с нейтральной долей 0,25 и сглаживаются.
 * - Reduced motion: L1 выключен, кадр нейтральный, рот `amp 0,3`; буферы не читаются (F4).
 */

/** Веса форм рта 0..1: `a` — широкий «а», `i` — растянутый «и/е», `u` — круглый «о/у», `m` — закрытый «м/б/п». */
export interface Visemes {
  a: number;
  i: number;
  u: number;
  m: number;
}

/** Кадр голоса для лица (Р10). Поля L1; поля интонации L2 добавляет B21. */
export interface VoiceFrame {
  /** Открытие рта по громкости 0..1. */
  amp: number;
  visemes: Visemes;
}

export interface VoiceAnalysis {
  /**
   * Один кадр: `time` и `freq` — данные анализатора (`getFloatTimeDomainData`, `getFloatFrequencyData` в дБ), `dt` —
   * секунды с прошлого кадра. `now` (мс) и `ask` (предложение кончается на «?») — входы интонации L2 (B21).
   */
  step(time: Float32Array, freq: Float32Array, dt: number, now: number, ask: boolean): VoiceFrame;
}

export interface VoiceAnalysisOptions {
  /** Частота `AudioContext` острова, Гц: по ней спектр делится на полосы. */
  sampleRate?: number;
  /** Включено ли уменьшенное движение; по умолчанию — системная настройка. */
  reducedMotion?: () => boolean;
}

const DEFAULT_SAMPLE_RATE = 48000;
const REDUCED = '(prefers-reduced-motion: reduce)';

/** Рот плана 3: последние 512 отсчётов, порог и диапазон rms, спад, с. */
const MOUTH_SAMPLES = 512;
const MOUTH_FLOOR = 0.02;
const MOUTH_RANGE = 0.25;
const MOUTH_RELEASE_S = 0.08;
/** Рот при reduced motion (#9 §6.1). */
const REDUCED_AMP = 0.3;
/** Кадр звонкий, если громкость `(дБ + 45) / 30` выше этого порога. */
const VOICED_LOUD = 0.18;
/** Постоянная самонормировки, с, и сколько звонких кадров нужно, прежде чем открытые формы выбираются. */
const NORM_TAU_S = 2;
const NORM_READY = 8;
/** Нейтральная доля в нормировке весов. */
const NEUTRAL = 0.25;
/** Сглаживание весов, с: закрытый рот чуть быстрее. */
const CLOSED_TAU_S = 0.06;
const SHAPE_TAU_S = 0.07;

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (cur: number, target: number, dt: number, tau: number): number => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const systemReducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED).matches;

export function createVoiceAnalysis(options: VoiceAnalysisOptions = {}): VoiceAnalysis {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const reduced = options.reducedMotion ?? systemReducedMotion;
  let amp = 0;
  let closed = 0;
  let round = 0;
  let wide = 0;
  let smile = 0;
  // Скользящие среднее и дисперсия признаков `mid/low` (M) и `high/low` (H), число звонких кадров.
  let meanM = 0;
  let varM = 0.5;
  let meanH = 0;
  let varH = 0.5;
  let voicedFrames = 0;

  /** Энергия полосы [lo, hi] Гц по спектру в дБ. */
  const band = (freq: Float32Array, lo: number, hi: number): number => {
    const binHz = sampleRate / (2 * freq.length);
    const from = Math.max(1, Math.floor(lo / binHz));
    const to = Math.min(freq.length - 1, Math.ceil(hi / binHz));
    let e = 0;
    for (let k = from; k <= to; k++) e += Math.pow(10, freq[k]! / 10);
    return e;
  };

  return {
    step(time, freq, dt) {
      if (reduced()) return { amp: REDUCED_AMP, visemes: { a: 0, i: 0, u: 0, m: 0 } };
      const from = Math.max(0, time.length - MOUTH_SAMPLES);
      let energy = 0;
      for (let k = from; k < time.length; k++) energy += time[k]! * time[k]!;
      const rms = Math.sqrt(energy / Math.max(1, time.length - from));
      amp = Math.max(clamp((rms - MOUTH_FLOOR) / MOUTH_RANGE), amp - dt / MOUTH_RELEASE_S);
      const loud = clamp((20 * Math.log10(rms + 1e-9) + 45) / 30);
      const voiced = loud > VOICED_LOUD;

      const eLo = band(freq, 200, 600);
      const eMid = band(freq, 600, 1300);
      const eHi = band(freq, 1300, 3000);
      const fM = Math.log((eMid + 1e-12) / (eLo + 1e-12));
      const fH = Math.log((eHi + 1e-12) / (eLo + 1e-12));
      if (voiced) {
        const k = 1 - Math.exp(-dt / NORM_TAU_S);
        meanM += (fM - meanM) * k;
        varM += ((fM - meanM) ** 2 - varM) * k;
        meanH += (fH - meanH) * k;
        varH += ((fH - meanH) ** 2 - varH) * k;
        voicedFrames++;
      }
      const zM = (fM - meanM) / Math.sqrt(varM + 1e-6);
      const zH = (fH - meanH) / Math.sqrt(varH + 1e-6);
      const open = voiced && voicedFrames > NORM_READY;
      let tc = voiced ? 0 : 1; // тишина между слогами — закрытый «м/б/п»
      let tw = open ? clamp((zM - 0.2) / 0.8) : 0; // энергии F1 больше обычного — широкий «а»
      let ts = open ? clamp((zH - 0.3) / 0.8) * clamp(1 - zM / 1.2) : 0; // высокая F2 при невысокой F1 — «и/е»
      let tr = open ? clamp((-zH - 0.3) / 0.8) * clamp((0.3 - zM) / 0.8) : 0; // обе ниже обычного — круглый «о/у»
      const sum = tc + tr + tw + ts + NEUTRAL;
      tc /= sum;
      tr /= sum;
      tw /= sum;
      ts /= sum;
      closed = smooth(closed, tc, dt, CLOSED_TAU_S);
      round = smooth(round, tr, dt, SHAPE_TAU_S);
      wide = smooth(wide, tw, dt, SHAPE_TAU_S);
      smile = smooth(smile, ts, dt, SHAPE_TAU_S);
      return { amp, visemes: { a: wide, i: smile, u: round, m: closed } };
    },
  };
}
