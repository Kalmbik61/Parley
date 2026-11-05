/**
 * Сглаживание эмоции лица по решениям Decisions GPT-Live (V2, чистый TS). Решения приходят на каждый фрагмент исходящего
 * транскрипта (около 5 в секунду в V0), поэтому лицо без сглаживания дёргалось бы. Правила:
 * - то же значение, что уже на лице, ничего не перезапускает;
 * - новая эмоция держится не меньше `EMOTION_HOLD_MS`, пока модель говорит; за время удержания кандидатом остаётся решение
 *   с самым новым `end_ms` исходного фрагмента, по окончании удержания оно применяется, если модель ещё говорит;
 * - решение с устаревшим смещением источника (старше уже принятого) лицо не откатывает;
 * - уверенность ниже `EMOTION_MIN_CONFIDENCE` игнорируется;
 * - модель замолчала или сессия закончилась — снова `calm`.
 * Ошибку контроллера (`error`) этот модуль не знает: её показывает стор, и она приходит только с нашей стороны.
 */
import type { LiveEmotion } from './events.js';

export const EMOTION_HOLD_MS = 1500;
export const EMOTION_MIN_CONFIDENCE = 0.5;

/** Решение достаточно уверенное, чтобы влиять на лицо (общее правило для сглаживателя и счётчика отклонённых в телеметрии). */
export const isConfidentEmotion = (confidence: number): boolean => confidence >= EMOTION_MIN_CONFIDENCE;

export interface EmotionDecision {
  value: LiveEmotion;
  confidence: number;
  /** `end_ms` исходного фрагмента транскрипта; `null` — неизвестен, тогда порядок определяет приход. */
  sourceEndMs: number | null;
}

export interface EmotionSmootherDeps {
  now(): number;
  /** Таймер конца удержания; возвращает отмену. */
  setTimer(callback: () => void, ms: number): () => void;
  /** Новое значение лица; вызывается только при смене. */
  apply(emotion: LiveEmotion): void;
  holdMs?: number;
}

export interface EmotionSmoother {
  decision(decision: EmotionDecision): void;
  /** Модель начала или перестала воспроизводить речь. */
  setPlaying(playing: boolean): void;
  /** Конец сессии: сбрасывает всё и возвращает `calm`. */
  reset(): void;
}

export function createEmotionSmoother(deps: EmotionSmootherDeps): EmotionSmoother {
  const holdMs = deps.holdMs ?? EMOTION_HOLD_MS;
  let current: LiveEmotion = 'calm';
  /** Когда `current` попал на лицо; `-Infinity` — спокойное исходное состояние, удерживать его не нужно. */
  let appliedAt = Number.NEGATIVE_INFINITY;
  let playing = false;
  let candidate: EmotionDecision | null = null;
  let cancelTimer: (() => void) | null = null;
  /** Самый новый `end_ms` среди принятых решений: старше него решения устарели. */
  let newestEnd = Number.NEGATIVE_INFINITY;

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = null;
  };
  const show = (emotion: LiveEmotion): void => {
    candidate = null;
    clearTimer();
    appliedAt = emotion === 'calm' ? Number.NEGATIVE_INFINITY : deps.now();
    if (emotion === current) return;
    current = emotion;
    deps.apply(emotion);
  };

  return {
    decision(decision) {
      if (!isConfidentEmotion(decision.confidence) || !playing) return;
      if (decision.sourceEndMs !== null) {
        if (decision.sourceEndMs < newestEnd) return;
        newestEnd = decision.sourceEndMs;
      }
      if (decision.value === current) {
        // Свежее решение подтвердило то, что на лице: более старый кандидат отменяется.
        candidate = null;
        clearTimer();
        return;
      }
      const waitMs = appliedAt + holdMs - deps.now();
      if (waitMs <= 0) {
        show(decision.value);
        return;
      }
      candidate = decision;
      if (cancelTimer === null) {
        cancelTimer = deps.setTimer(() => {
          cancelTimer = null;
          const next = candidate;
          if (playing && next !== null) show(next.value);
        }, waitMs);
      }
    },

    setPlaying(next) {
      if (playing === next) return;
      playing = next;
      if (!next) show('calm');
    },

    reset() {
      playing = false;
      newestEnd = Number.NEGATIVE_INFINITY;
      show('calm');
    },
  };
}
