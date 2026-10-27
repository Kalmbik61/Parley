/**
 * Признаки голоса для лица (план 3b B17, B21, Р10; #9 §6.7, слои L1 и L2): порт `createVoiceAnalysis` прототипа
 * island-motion-sound. Раз в кадр из времени и спектра анализатора шины голоса (fftSize 2048, `speaker.read`) считаются
 * громкость рта, веса четырёх форм рта (визем) и интонация. Анализатор читает вызывающий и только пока звучит голос;
 * здесь — чистые вычисления над переданными массивами, без Web Audio.
 *
 * - Громкость — рот плана 3 v1 (`speaker.mouth()`): `clamp((rms − 0,02) / 0,25)` по последним 512 отсчётам, атака
 *   мгновенная, спад линейный за 0,08 с. Поэтому режим лица «только громкость» повторяет v1 ровно (F1).
 * - Виземы — по энергиям полос 200–600, 600–1300 и 1300–3000 Гц: логарифмы отношений `mid/low` и `high/low`
 *   нормируются по самому голосу (скользящие среднее и дисперсия с постоянной 2 с, только по звонким кадрам), поэтому
 *   код один для любого голоса, движка и языка. Веса нормируются вместе с нейтральной долей 0,25 и сглаживаются.
 * - Интонация (L2) — F0 автокорреляцией по окну, прореженному в 4 раза (75–400 Гц, звонкий кадр — пик выше 0,5).
 *   Ударный слог — громкость на 9 дБ выше скользящей (0,35 с), не чаще раза в 250 мс: импульс со спадом 160 мс.
 *   Пауза дольше 250 мс зовёт моргание, не чаще раза в 600 мс. Если фраза перед такой паузой кончилась подъёмом тона
 *   (последние 150 мс выше прежних на 10 %) или предложение кончается на «?» (`ask`), глаза на 0,9 с расширяются и
 *   поднимаются. Вопрос по тексту срабатывает в паузе фразы, как и по тону.
 * - Reduced motion: L1 и L2 выключены, кадр нейтральный, рот `amp 0,3`; буферы не читаются (F4).
 */

/** Веса форм рта 0..1: `a` — широкий «а», `i` — растянутый «и/е», `u` — круглый «о/у», `m` — закрытый «м/б/п». */
export interface Visemes {
  a: number;
  i: number;
  u: number;
  m: number;
}

/** Кадр голоса для лица (Р10): поля L1 (`amp`, `visemes`) и интонации L2. */
export interface VoiceFrame {
  /** Открытие рта по громкости 0..1. */
  amp: number;
  visemes: Visemes;
  /** Ударный импульс 0..1: 1 на ударном слоге, спад за 0,16 с. */
  pulse: number;
  /** Подъём и расширение глаз 0..1 после вопроса (по тону или по «?»), сглажено. */
  eyesUp: number;
  /** На этом кадре пауза дольше 250 мс зовёт моргание (не чаще раза в 600 мс). */
  blink: boolean;
  /** Громкость 0..1: `(дБ + 45) / 30` — яркость лица растёт с ней. */
  loud: number;
}

export interface VoiceAnalysis {
  /**
   * Один кадр: `time` и `freq` — данные анализатора (`getFloatTimeDomainData`, `getFloatFrequencyData` в дБ), `dt` —
   * секунды с прошлого кадра. `now` (мс) и `ask` (предложение кончается на «?») — входы интонации L2. Паузы между
   * фразами и предложениями тоже идут кадрами: по ним L2 зовёт моргание и решает о вопросе.
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
const NEUTRAL_FRAME = (): VoiceFrame => ({ amp: REDUCED_AMP, visemes: { a: 0, i: 0, u: 0, m: 0 }, pulse: 0, eyesUp: 0, blink: false, loud: 0 });
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
/** F0: прореживание окна, диапазон, Гц, и порог пика автокорреляции звонкого кадра. */
const F0_DECIMATE = 4;
const F0_MIN_HZ = 75;
const F0_MAX_HZ = 400;
const F0_VOICED = 0.5;
/** Сколько истории F0 держим, мс; конец фразы — последние 150 мс; подъём — на 10 %. */
const F0_WINDOW_MS = 600;
const F0_TAIL_MS = 150;
const F0_RISE = 1.1;
/** Ударный слог: на сколько дБ громче скользящей, её постоянная, с, пауза между ударами, мс, и спад импульса, с. */
const STRESS_DB = 9;
const SLOW_DB_TAU_S = 0.35;
const STRESS_GAP_MS = 250;
const PULSE_DECAY_S = 0.16;
/** Пауза, мс, после которой фраза кончилась и зовётся моргание; моргание не чаще, мс. */
const PAUSE_MS = 250;
const BLINK_GAP_MS = 600;
/** Глаза после вопроса: держатся, мс, и сглаживание, с. */
const EYES_HOLD_MS = 900;
const EYES_TAU_S = 0.12;

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
  // L2: прореженное окно, история F0 фразы `[мс, Гц]`, скользящая громкость, импульс, пауза, глаза.
  let dec = new Float32Array(0);
  let f0s: Array<[at: number, hz: number]> = [];
  let slowDb = -60;
  let pulse = 0;
  let lastStress = -Infinity;
  let quiet = 0;
  let lastBlink = -Infinity;
  let phrase = false;
  let eyeHold = -Infinity;
  let eyesUp = 0;

  /** F0 по окну `time`, Гц; 0 — кадр не звонкий. Автокорреляция по окну, прореженному в 4 раза. */
  const pitch = (time: Float32Array): number => {
    const n = Math.floor(time.length / F0_DECIMATE);
    if (dec.length !== n) dec = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = 0; j < F0_DECIMATE; j++) v += time[F0_DECIMATE * i + j]!;
      dec[i] = v / F0_DECIMATE;
      mean += dec[i]!;
    }
    mean /= n;
    let e0 = 0;
    for (let i = 0; i < n; i++) {
      dec[i]! -= mean;
      e0 += dec[i]! * dec[i]!;
    }
    if (e0 <= 1e-6) return 0;
    const rate = sampleRate / F0_DECIMATE;
    let best = 0;
    let bestLag = 0;
    for (let lag = Math.floor(rate / F0_MAX_HZ); lag <= Math.ceil(rate / F0_MIN_HZ) && lag < n / 2; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) acc += dec[i]! * dec[i + lag]!;
      const r = ((acc / e0) * n) / (n - lag);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    return best > F0_VOICED ? rate / bestLag : 0;
  };

  /** Кончилась ли фраза подъёмом тона: средняя F0 последних 150 мс выше прежних на 10 %. */
  const risingEnd = (): boolean => {
    if (f0s.length <= 4) return false;
    const end = f0s[f0s.length - 1]![0];
    let late = 0;
    let lateN = 0;
    let early = 0;
    let earlyN = 0;
    for (const [at, hz] of f0s) {
      if (end - at < F0_TAIL_MS) {
        late += hz;
        lateN++;
      } else {
        early += hz;
        earlyN++;
      }
    }
    return lateN > 0 && earlyN > 0 && late / lateN > (early / earlyN) * F0_RISE;
  };

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
    step(time, freq, dt, now, ask) {
      if (reduced()) return NEUTRAL_FRAME();
      const from = Math.max(0, time.length - MOUTH_SAMPLES);
      let energy = 0;
      for (let k = from; k < time.length; k++) energy += time[k]! * time[k]!;
      const rms = Math.sqrt(energy / Math.max(1, time.length - from));
      amp = Math.max(clamp((rms - MOUTH_FLOOR) / MOUTH_RANGE), amp - dt / MOUTH_RELEASE_S);
      const db = 20 * Math.log10(rms + 1e-9);
      const loud = clamp((db + 45) / 30);
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

      // L2: F0 звонких кадров — в историю фразы; в паузе дольше 250 мс фраза кончилась: вопрос по тону или по «?».
      const f0 = voiced ? pitch(time) : 0;
      if (f0 > 0) {
        f0s.push([now, f0]);
        while (f0s.length > 0 && now - f0s[0]![0] > F0_WINDOW_MS) f0s.shift();
      }
      if (voiced) {
        quiet = 0;
        phrase = true;
      } else if (quiet > PAUSE_MS && phrase) {
        phrase = false;
        if (ask || risingEnd()) eyeHold = now + EYES_HOLD_MS;
        f0s = [];
      }
      eyesUp = smooth(eyesUp, now < eyeHold ? 1 : 0, dt, EYES_TAU_S);
      if (f0 > 0 && db - slowDb > STRESS_DB && now - lastStress > STRESS_GAP_MS) {
        pulse = 1;
        lastStress = now;
      }
      pulse = Math.max(0, pulse - dt / PULSE_DECAY_S);
      slowDb = smooth(slowDb, db, dt, SLOW_DB_TAU_S);
      let blink = false;
      if (!voiced) {
        quiet += dt * 1000;
        if (quiet > PAUSE_MS && now - lastBlink > BLINK_GAP_MS) {
          lastBlink = now;
          blink = true;
        }
      }
      return { amp, visemes: { a: wide, i: smile, u: round, m: closed }, pulse, eyesUp, blink, loud };
    },
  };
}
