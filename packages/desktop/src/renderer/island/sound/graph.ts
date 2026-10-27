/**
 * Аудиограф окна острова (#9 §3.3–§3.4, §6.4): один ленивый `AudioContext` на окно, в нём играют и сигналы, и голос
 * помощника. Схема — по прототипу `island-motion-sound` (`audio`, `applyGain`, `synth`):
 *
 *   сигналы ──────────────────────┐
 *   голос ── анализатор (2048) ───┴─ общая громкость (v²) ── компрессор (−14 дБ, 4:1) ── выход
 *
 * Анализатор стоит только на шине голоса: рот роя слышит голос, а не сигналы (V1). Любой сбой Web Audio — одно
 * `console.warn` на окно, как у `attention/chime.ts`: сигнал важнее звука, остров не падает.
 */

import type { IslandPalette } from './palettes.js';
import { playCue, type CueSound } from './synth.js';

/** Громкость острова по умолчанию (§5): 60 %, усиление 0,36 ≈ −9 дБ. */
export const DEFAULT_ISLAND_VOLUME = 0.6;

const COMPRESSOR_THRESHOLD_DB = -14;
const COMPRESSOR_RATIO = 4;
const COMPRESSOR_ATTACK_S = 0.003;
const COMPRESSOR_RELEASE_S = 0.2;
const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.5;
/** Постоянная времени общей громкости, с: ползунок едет плавно, без щелчков. */
const VOLUME_TIME_CONSTANT_S = 0.03;
/** Сигнал внимания опускает голос до 30 % на 0,7 с (§6.4). */
const DUCK_LEVEL = 0.3;
const DUCK_SECONDS = 0.7;
const DUCK_DOWN_S = 0.02;
const DUCK_UP_S = 0.15;

/** Что из графа нужно проигрывателю речи: контекст, вход шины голоса и анализатор для рта. */
export interface IslandAudioGraph {
  context: AudioContext;
  voice: GainNode;
  analyser: AnalyserNode;
}

export interface IslandSound {
  /** Граф окна: создаётся при первом вызове, усыплённый контекст будится. `null` — Web Audio не завёлся. */
  graph(): IslandAudioGraph | null;
  /** Сигнал в шину сигналов; `quiet` — на 10 дБ тише (работа и итог под речью). При громкости 0 узлов нет. */
  play(kind: CueSound, options?: { quiet?: boolean }): void;
  /** Общая громкость 0…1, усиление v²; на голос тоже (§6.5). Возврат из 0 подтверждается тихим `unmute`. */
  setVolume(volume: number): void;
  setPalette(palette: IslandPalette): void;
  /** Опустить голос до `level` на `seconds` и вернуть: сигнал внимания под речью. */
  duckVoice(level?: number, seconds?: number): void;
}

interface Graph extends IslandAudioGraph {
  cues: GainNode;
  master: GainNode;
}

export function createIslandSound(createContext: () => AudioContext = () => new AudioContext()): IslandSound {
  let built: Graph | null = null;
  let failed = false;
  let warned = false;
  let volume = DEFAULT_ISLAND_VOLUME;
  let palette: IslandPalette = 'soft';

  function warnOnce(error: unknown): void {
    if (warned) return;
    warned = true;
    console.warn('[parley] island sound failed', error);
  }

  function build(): Graph {
    const context = createContext();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = COMPRESSOR_THRESHOLD_DB;
    compressor.ratio.value = COMPRESSOR_RATIO;
    compressor.attack.value = COMPRESSOR_ATTACK_S;
    compressor.release.value = COMPRESSOR_RELEASE_S;
    const master = context.createGain();
    // Начальное значение ставится прямо: ещё ничего не звучит, а подъём от 1 сделал бы первый сигнал громче.
    master.gain.value = volume ** 2;
    const cues = context.createGain();
    const voice = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    cues.connect(master);
    voice.connect(analyser);
    analyser.connect(master);
    master.connect(compressor);
    compressor.connect(context.destination);
    return { context, cues, voice, analyser, master };
  }

  function graph(): Graph | null {
    if (!built && !failed) {
      try {
        built = build();
      } catch (error: unknown) {
        failed = true;
        warnOnce(error);
      }
    }
    if (built?.context.state === 'suspended') void built.context.resume().catch(warnOnce);
    return built;
  }

  function play(kind: CueSound, options: { quiet?: boolean } = {}): void {
    if (volume === 0) return;
    const current = graph();
    if (!current) return;
    try {
      playCue(current.context, current.cues, kind, palette, options);
    } catch (error: unknown) {
      warnOnce(error);
    }
  }

  return {
    graph,
    play,
    setVolume(next) {
      const wasOff = volume === 0;
      volume = next;
      try {
        built?.master.gain.setTargetAtTime(next ** 2, built.context.currentTime, VOLUME_TIME_CONSTANT_S);
      } catch (error: unknown) {
        warnOnce(error);
      }
      if (wasOff && next > 0) play('unmute');
    },
    setPalette(next) {
      palette = next;
    },
    duckVoice(level = DUCK_LEVEL, seconds = DUCK_SECONDS) {
      if (!built) return;
      try {
        const gain = built.voice.gain;
        const now = built.context.currentTime;
        gain.cancelScheduledValues(now);
        gain.setTargetAtTime(level, now, DUCK_DOWN_S);
        gain.setTargetAtTime(1, now + seconds, DUCK_UP_S);
      } catch (error: unknown) {
        warnOnce(error);
      }
    },
  };
}

/** Звук окна острова: один граф на окно. */
export const islandSound = createIslandSound();
