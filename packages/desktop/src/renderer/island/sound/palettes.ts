/**
 * Палитры звуков острова (#9 §3.2): один набор рецептов (`synth.ts`), а тонику и тембр задаёт палитра. Тембры —
 * по прототипу `island-motion-sound` (`tone`, `noiseSweep`), формулы свои.
 */

export type IslandPalette = 'soft' | 'crystal' | 'warm';

export interface Palette {
  /** Тоника, Гц: ноты рецепта считаются в полутонах от неё. */
  root: number;
  /** Атака огибающей ноты, с. */
  attack: number;
  /** Хвост: огибающая ноты гаснет за `длительность × tail`. */
  tail: number;
  /** Добротность полосы шумовых сигналов (`open`, `close`). */
  noiseQ: number;
  /** Сколько осцилляторов у ноты с полным тембром. Когда нот много, `synth.ts` даёт меньше: первые слои важнее. */
  layers: number;
  /**
   * Тембр одной ноты: осцилляторы (не больше `layers`) и фильтры, выход — в `output` (огибающую ноты). Запуск и
   * остановку осцилляторов ставит `synth.ts`.
   */
  timbre(
    context: BaseAudioContext,
    output: AudioNode,
    frequency: number,
    start: number,
    duration: number,
    layers: number,
  ): OscillatorNode[];
}

/** Тихая октава «Мягкой» к основному синусу. */
const SOFT_OCTAVE_GAIN = 0.12;
const SOFT_LOWPASS_HZ = 3_200;
/** Синус и тихая октава — одна волна: один осциллятор на ноту вместо двух. Волна своя у каждого контекста. */
const softWaves = new WeakMap<BaseAudioContext, PeriodicWave>();
function softWave(context: BaseAudioContext): PeriodicWave {
  let wave = softWaves.get(context);
  if (!wave) {
    wave = context.createPeriodicWave([0, 0, 0], [0, 1, SOFT_OCTAVE_GAIN], { disableNormalization: true });
    softWaves.set(context, wave);
  }
  return wave;
}

/** FM-колокол «Хрусталя»: модулятор на частоте `× 3,5`, индекс от `× 2,2` гаснет до `× 0,05` за ноту. */
const CRYSTAL_MOD_RATIO = 3.5;
const CRYSTAL_INDEX_FROM = 2.2;
const CRYSTAL_INDEX_TO = 0.05;
/** Негармонический обертон колокола и его громкость. */
const CRYSTAL_SHIMMER_RATIO = 2.76;
const CRYSTAL_SHIMMER_GAIN = 0.18;

/** «Тёплая»: пилообразные расстроены на ±7 центов и тихие; ФНЧ спадает от `× 5` до `× 1,6` частоты ноты. */
const WARM_SAW_DETUNE_CENTS = [-7, 7] as const;
const WARM_SAW_GAIN = 0.12;
const WARM_LOWPASS_FROM = 5;
const WARM_LOWPASS_TO = 1.6;
const WARM_LOWPASS_Q = 0.7;

function oscillator(context: BaseAudioContext, type: OscillatorType, frequency: number): OscillatorNode {
  const node = context.createOscillator();
  node.type = type;
  node.frequency.value = frequency;
  return node;
}

function quiet(context: BaseAudioContext, input: AudioNode, output: AudioNode, gain: number): void {
  const node = context.createGain();
  node.gain.value = gain;
  input.connect(node);
  node.connect(output);
}

export const PALETTES: Record<IslandPalette, Palette> = {
  // D5: синус и тихая октава через ФНЧ 3,2 кГц, атака 12 мс — «стеклянные шарики».
  soft: {
    root: 587.33,
    attack: 0.012,
    tail: 1.25,
    noiseQ: 2.5,
    layers: 1,
    timbre(context, output, frequency) {
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = SOFT_LOWPASS_HZ;
      lowpass.connect(output);
      const tone = context.createOscillator();
      tone.setPeriodicWave(softWave(context));
      tone.frequency.value = frequency;
      tone.connect(lowpass);
      return [tone];
    },
  },
  // E5: FM-колокол и обертон × 2,76, атака 2 мс, длинный хвост — звонкая и светлая.
  crystal: {
    root: 659.25,
    attack: 0.002,
    tail: 1.9,
    noiseQ: 6,
    layers: 3,
    timbre(context, output, frequency, start, duration, layers) {
      const carrier = oscillator(context, 'sine', frequency);
      carrier.connect(output);
      const nodes = [carrier];
      if (layers >= 2) {
        const modulator = oscillator(context, 'sine', frequency * CRYSTAL_MOD_RATIO);
        const index = context.createGain();
        index.gain.setValueAtTime(frequency * CRYSTAL_INDEX_FROM, start);
        index.gain.exponentialRampToValueAtTime(frequency * CRYSTAL_INDEX_TO, start + duration);
        modulator.connect(index);
        index.connect(carrier.frequency);
        nodes.push(modulator);
      }
      if (layers >= 3) {
        const shimmer = oscillator(context, 'sine', frequency * CRYSTAL_SHIMMER_RATIO);
        quiet(context, shimmer, output, CRYSTAL_SHIMMER_GAIN);
        nodes.push(shimmer);
      }
      return nodes;
    },
  },
  // G4: треугольник и два расстроенных пилообразных через спадающий ФНЧ, атака 30 мс — «войлок».
  warm: {
    root: 392,
    attack: 0.03,
    tail: 1.25,
    noiseQ: 1.2,
    layers: 3,
    timbre(context, output, frequency, start, duration, layers) {
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.Q.value = WARM_LOWPASS_Q;
      lowpass.frequency.setValueAtTime(frequency * WARM_LOWPASS_FROM, start);
      lowpass.frequency.exponentialRampToValueAtTime(frequency * WARM_LOWPASS_TO, start + duration);
      lowpass.connect(output);
      const triangle = oscillator(context, 'triangle', frequency);
      triangle.connect(lowpass);
      const nodes = [triangle];
      for (const cents of WARM_SAW_DETUNE_CENTS.slice(0, layers - 1)) {
        const saw = oscillator(context, 'sawtooth', frequency);
        saw.detune.value = cents;
        quiet(context, saw, lowpass, WARM_SAW_GAIN);
        nodes.push(saw);
      }
      return nodes;
    },
  },
};
