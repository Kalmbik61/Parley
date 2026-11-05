/**
 * Локальные сигналы речи (чистый TS). В протоколе GPT-Live нет событий «человек говорит» и «модель воспроизводит»
 * (T0 §2a), поэтому:
 * - `humanSpeaking` — RMS микрофона с гистерезисом;
 * - `modelPlaying` — RMS удалённого аудиотрека с гистерезисом «модель замолчала» не меньше 500 мс (внутри реплики
 *   бывают паузы 0,1–0,4 с).
 */

export function rms(frame: ArrayLike<number>): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

export interface HysteresisOptions {
  /** Уровень, с которого сигнал включается. */
  on: number;
  /** Уровень, ниже которого сигнал начинает гаснуть (не выше `on`). */
  off: number;
  /** Сколько подряд держится уровень ≥ `on`, прежде чем сигнал включится; 0 — сразу. */
  attackMs: number;
  /** Сколько подряд держится уровень < `off`, прежде чем сигнал погаснет. */
  holdMs: number;
}

export interface Hysteresis {
  /** Кормит очередным уровнем в момент `nowMs`; возвращает текущее состояние сигнала. */
  push(level: number, nowMs: number): boolean;
  readonly active: boolean;
  reset(): void;
}

export function createHysteresis(options: HysteresisOptions): Hysteresis {
  let active = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;
  return {
    get active() {
      return active;
    },
    push(level, nowMs) {
      if (!active) {
        if (level >= options.on) {
          aboveSince ??= nowMs;
          if (nowMs - aboveSince >= options.attackMs) {
            active = true;
            belowSince = null;
          }
        } else {
          aboveSince = null;
        }
        return active;
      }
      // Между порогами (off ≤ level < on) сигнал держится, но отсчёт тишины сбрасывается: пауза должна быть непрерывной.
      if (level < options.off) {
        belowSince ??= nowMs;
        if (nowMs - belowSince >= options.holdMs) {
          active = false;
          aboveSince = null;
        }
      } else {
        belowSince = null;
      }
      return active;
    },
    reset() {
      active = false;
      aboveSince = null;
      belowSince = null;
    },
  };
}

/** Порог речи по RMS ноутбучного микрофона (речь ≈ 0,01–0,03); подбирается на живой проверке. */
export const HUMAN_SPEECH_ON = 0.02;
export const HUMAN_SPEECH_OFF = 0.01;
/** Гребень в один кадр (щелчок, стук) речью не считается. */
export const HUMAN_ATTACK_MS = 60;
export const HUMAN_HOLD_MS = 300;

/** Порог звука удалённого трека: тот же, что мерил T0 (RMS 0,01). */
export const MODEL_PLAY_ON = 0.01;
export const MODEL_PLAY_OFF = 0.005;
/** Гистерезис «модель замолчала» — не меньше 500 мс (спека §7). */
export const MODEL_QUIET_HOLD_MS = 500;

export const humanSpeakingHysteresis = (): Hysteresis => createHysteresis({ on: HUMAN_SPEECH_ON, off: HUMAN_SPEECH_OFF, attackMs: HUMAN_ATTACK_MS, holdMs: HUMAN_HOLD_MS });
export const modelPlayingHysteresis = (): Hysteresis => createHysteresis({ on: MODEL_PLAY_ON, off: MODEL_PLAY_OFF, attackMs: 0, holdMs: MODEL_QUIET_HOLD_MS });
