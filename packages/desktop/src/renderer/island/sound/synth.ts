/**
 * Сигналы острова (#9 §3.1): рецепты нот и шума, синтез на Web Audio во время работы, файлов звуков нет. Рецепт задаёт
 * ноты в полутонах от тоники, начало, длину и громкость; тонику и тембр даёт палитра (`palettes.ts`). Рецепты — по
 * прототипу `island-motion-sound` (`RECIPE`, `synth`).
 *
 * Функция не знает об окне и графе: остров играет в шину сигналов своего графа (`graph.ts`), а пример палитры в
 * Settings — в свой контекст главного окна. Ошибки Web Audio ловит вызывающий.
 */

import { PALETTES, type IslandPalette } from './palettes.js';

export type CueSound =
  | 'permission'
  | 'question'
  | 'plan'
  | 'done'
  | 'error'
  | 'start'
  | 'hover'
  | 'open'
  | 'close'
  | 'listen-start'
  | 'listen-end'
  | 'speak'
  | 'decide'
  | 'unmute';

/** Нота: полутоны от тоники, начало от начала сигнала (мс), длина (мс), громкость относительно уровня (дБ). */
type Note = readonly [semitones: number, startMs: number, durationMs: number, gainDb: number];
/** Свип шума: начало (мс), длина (мс), полоса от и до (Гц), громкость относительно уровня (дБ). */
type Sweep = readonly [startMs: number, durationMs: number, fromHz: number, toHz: number, gainDb: number];

export interface CueRecipe {
  /** Уровень сигнала, дБ относительно общей громкости (таблица §3.1). */
  level: number;
  notes?: readonly Note[];
  noise?: readonly Sweep[];
  /** Последняя нота во второй половине уходит на столько полутонов (вверх или вниз). */
  glide?: number;
  /** Соседние ноты расходятся на ± столько центов. */
  detune?: number;
}

export const CUE_RECIPES: Record<CueSound, CueRecipe> = {
  // два мягких двузвучия вверх
  permission: { level: -7, notes: [[0, 0, 240, 0], [7, 0, 240, -6], [5, 230, 380, 0], [12, 230, 380, -6]] },
  // две ноты, вторая с подъёмом в конце
  question: { level: -7, notes: [[0, 0, 170, 0], [9, 150, 460, 0]], glide: 2 },
  // арпеджио из четырёх нот
  plan: { level: -8, notes: [[0, 0, 190, -1], [4, 115, 190, -1], [7, 230, 190, -1], [11, 345, 520, 0]] },
  // восходящее арпеджио до октавы, длинный хвост
  done: { level: -5, notes: [[0, 0, 240, -2], [4, 90, 240, -2], [7, 180, 300, -1], [12, 280, 950, 0], [19, 290, 700, -12]] },
  // две низкие ноты на октаву ниже, полутон вниз
  error: { level: -8, notes: [[-12, 0, 320, 0], [-13, 210, 560, 0]], detune: 9 },
  // две ноты вверх: кварта, квинта
  start: { level: -15, notes: [[0, 0, 200, 0], [7, 95, 280, -1]] },
  // высокий щелчок
  hover: { level: -28, notes: [[19, 0, 60, 0]] },
  // свип шума вверх / вниз
  open: { level: -20, noise: [[0, 360, 500, 3_200, -2]], notes: [[12, 40, 300, -6]], glide: 7 },
  close: { level: -20, noise: [[0, 300, 2_600, 450, -2]], notes: [[19, 30, 260, -6]], glide: -7 },
  // две ноты вверх / вниз
  'listen-start': { level: -20, notes: [[7, 0, 90, 0], [12, 80, 150, 0]] },
  'listen-end': { level: -20, notes: [[12, 0, 90, 0], [7, 80, 170, 0]] },
  // тихое двузвучие
  speak: { level: -28, notes: [[0, 0, 320, 0], [4, 0, 320, -3]] },
  // короткое «да»
  decide: { level: -20, notes: [[12, 0, 110, 0], [16, 60, 160, -3]] },
  // щелчок-подтверждение
  unmute: { level: -28, notes: [[24, 0, 50, 0]] },
};

/**
 * Бюджет синтеза (#9 §7): не больше стольких осцилляторов на сигнал. Тембр палитр рецептов прототипа влезает целиком
 * (done в crystal и warm — 15).
 */
export const MAX_CUE_OSCILLATORS = 16;
/** Работа и итог под речью звучат на 10 дБ тише (§6.4). */
const QUIET_DB = -10;
/** Сигнал начинается чуть позже `currentTime`: расписание в прошлом Web Audio сдвинул бы. */
const START_DELAY_S = 0.01;
/** Огибающая гаснет до этого уровня, не до нуля: экспоненциальный спад в ноль невозможен. */
const SILENCE = 1e-4;
/** Нота после атаки опускается до этой доли пика к середине длины, дальше — до тишины. */
const SUSTAIN = 0.35;
const SUSTAIN_AT = 0.55;
/** Источник останавливается чуть позже конца огибающей: он уже беззвучен, щелчка нет. */
const STOP_PAD_S = 0.05;
/** Подъём тона начинается с этой доли длины ноты. */
const GLIDE_AT = 0.45;
/** Шум воспринимается тише ноты того же уровня. */
const NOISE_BOOST = 1.6;
/** Шум нарастает до пика за эту долю длины свипа. */
const NOISE_PEAK_AT = 0.35;
const NOISE_SECONDS = 1.5;

const dbToGain = (db: number): number => 10 ** (db / 20);

/** Белый шум — один буфер на контекст. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    const length = Math.round(context.sampleRate * NOISE_SECONDS);
    buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

/**
 * Проигрывает сигнал `kind` палитрой `palette` в `destination`. Каждая нота — огибающая (атака палитры, спад к
 * `SUSTAIN` и до тишины за `длительность × tail`) и тембр палитры. Слоёв тембра на ноту — сколько влезает в
 * `MAX_CUE_OSCILLATORS`: у двузвучия тембр полный, у арпеджио — первый слой. Все источники останавливаются сами по
 * концу огибающей.
 */
export function playCue(
  context: BaseAudioContext,
  destination: AudioNode,
  kind: CueSound,
  palette: IslandPalette,
  options: { quiet?: boolean } = {},
): void {
  const recipe = CUE_RECIPES[kind];
  const timbre = PALETTES[palette];
  const begin = context.currentTime + START_DELAY_S;
  const level = dbToGain(recipe.level + (options.quiet ? QUIET_DB : 0));
  const notes = recipe.notes ?? [];
  const layers = Math.min(timbre.layers, Math.max(1, Math.floor(MAX_CUE_OSCILLATORS / notes.length)));

  notes.forEach(([semitones, startMs, durationMs, gainDb], index) => {
    const start = begin + startMs / 1000;
    const duration = durationMs / 1000;
    const end = start + duration * timbre.tail;
    const peak = level * dbToGain(gainDb);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + timbre.attack);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(SILENCE, peak * SUSTAIN),
      start + Math.max(timbre.attack + 0.01, duration * SUSTAIN_AT),
    );
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
    envelope.connect(destination);

    const frequency = timbre.root * 2 ** (semitones / 12);
    for (const oscillator of timbre.timbre(context, envelope, frequency, start, duration, layers)) {
      if (recipe.detune) oscillator.detune.value += (index % 2 === 0 ? 1 : -1) * recipe.detune;
      if (recipe.glide && index === notes.length - 1) {
        const from = oscillator.frequency.value;
        oscillator.frequency.setValueAtTime(from, start + duration * GLIDE_AT);
        oscillator.frequency.exponentialRampToValueAtTime(from * 2 ** (recipe.glide / 12), start + duration);
      }
      oscillator.start(start);
      oscillator.stop(end + STOP_PAD_S);
    }
  });

  for (const [startMs, durationMs, fromHz, toHz, gainDb] of recipe.noise ?? []) {
    const start = begin + startMs / 1000;
    const duration = durationMs / 1000;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer(context);
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = timbre.noiseQ;
    band.frequency.setValueAtTime(fromHz, start);
    band.frequency.exponentialRampToValueAtTime(toHz, start + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(level * dbToGain(gainDb) * NOISE_BOOST, start + duration * NOISE_PEAK_AT);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, start + duration);
    source.connect(band);
    band.connect(envelope);
    envelope.connect(destination);
    source.start(start);
    source.stop(start + duration + STOP_PAD_S);
  }
}
