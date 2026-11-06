import { beforeEach, describe, expect, it } from 'vitest';
import { createEmotionSmoother, EMOTION_HOLD_MS, EMOTION_MIN_CONFIDENCE, isConfidentEmotion, type EmotionDecision, type EmotionSmoother } from './emotion.js';
import type { LiveEmotion } from './live-events.js';

function setup() {
  let now = 10_000;
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = [];
  const applied: LiveEmotion[] = [];
  const smoother: EmotionSmoother = createEmotionSmoother({
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    apply: (emotion) => void applied.push(emotion),
  });
  /** Двигает часы и срабатывает таймерам по порядку. */
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      next.live = false;
      now = next.at;
      next.callback();
    }
    now = target;
  };
  const d = (value: LiveEmotion, sourceEndMs: number | null, confidence = 0.9): EmotionDecision => ({ value, confidence, sourceEndMs });
  return { smoother, applied, advance, d };
}

describe('createEmotionSmoother', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('пока модель не играет, решения не влияют на лицо', () => {
    t.smoother.decision(t.d('joy', 1000));
    t.advance(5000);
    expect(t.applied).toEqual([]);
  });

  it('первая эмоция после спокойного состояния применяется сразу', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    expect(t.applied).toEqual(['joy']);
  });

  it('то же значение ничего не перезапускает: ни применения, ни нового удержания', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.advance(1000);
    t.smoother.decision(t.d('joy', 1200));
    t.advance(500);
    // удержание считается от первого применения (1500 мс), повтор его не продлил
    t.smoother.decision(t.d('sad', 1400));
    expect(t.applied).toEqual(['joy', 'sad']);
  });

  it('новая эмоция держится не меньше 1500 мс: кандидат применяется по окончании удержания, пока модель играет', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.advance(400);
    t.smoother.decision(t.d('sad', 1400));
    expect(t.applied).toEqual(['joy']);
    t.advance(EMOTION_HOLD_MS - 400 - 1);
    expect(t.applied).toEqual(['joy']);
    t.advance(1);
    expect(t.applied).toEqual(['joy', 'sad']);
  });

  it('за время удержания кандидатом остаётся решение с самым новым end_ms', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.advance(200);
    t.smoother.decision(t.d('sad', 1200));
    t.advance(200);
    t.smoother.decision(t.d('surprise', 1600));
    t.advance(200);
    t.smoother.decision(t.d('anger', 1800));
    t.advance(EMOTION_HOLD_MS);
    expect(t.applied).toEqual(['joy', 'anger']);
  });

  it('устаревшее смещение источника не откатывает лицо и не подменяет кандидата', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 2000));
    t.advance(300);
    t.smoother.decision(t.d('sad', 2600));
    t.smoother.decision(t.d('anger', 2200)); // пришло позже, но источник старше уже принятого
    t.advance(EMOTION_HOLD_MS);
    expect(t.applied).toEqual(['joy', 'sad']);
    t.smoother.decision(t.d('joy', 1000)); // совсем старое
    t.advance(EMOTION_HOLD_MS);
    expect(t.applied).toEqual(['joy', 'sad']);
  });

  it('более свежее решение, подтвердившее текущую эмоцию, отменяет прежнего кандидата', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.advance(200);
    t.smoother.decision(t.d('sad', 1200));
    t.smoother.decision(t.d('joy', 1400));
    t.advance(EMOTION_HOLD_MS * 2);
    expect(t.applied).toEqual(['joy']);
  });

  it('модель замолчала до конца удержания: кандидат не применяется, лицо возвращается к calm', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.advance(200);
    t.smoother.decision(t.d('sad', 1200));
    t.smoother.setPlaying(false);
    t.advance(EMOTION_HOLD_MS * 2);
    expect(t.applied).toEqual(['joy', 'calm']);
  });

  it('следующая реплика начинается с чистого удержания: первая эмоция снова сразу', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000));
    t.smoother.setPlaying(false);
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('sad', 9000));
    expect(t.applied).toEqual(['joy', 'calm', 'sad']);
  });

  it('уверенность ниже порога игнорируется; ровно порог проходит', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 1000, EMOTION_MIN_CONFIDENCE - 0.01));
    expect(t.applied).toEqual([]);
    t.smoother.decision(t.d('joy', 1200, EMOTION_MIN_CONFIDENCE));
    expect(t.applied).toEqual(['joy']);
    expect(isConfidentEmotion(0.49)).toBe(false);
    expect(isConfidentEmotion(0.5)).toBe(true);
  });

  it('неуверенное решение не двигает отметку «самое новое»: более старое, но уверенное принимается', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 5000, 0.2));
    t.smoother.decision(t.d('sad', 4000, 0.9));
    expect(t.applied).toEqual(['sad']);
  });

  it('смещение источника неизвестно (null): решение принимается по порядку прихода', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 5000));
    t.advance(EMOTION_HOLD_MS);
    t.smoother.decision(t.d('sad', null));
    expect(t.applied).toEqual(['joy', 'sad']);
  });

  it('reset: calm, таймер и кандидат сброшены, старые смещения забыты', () => {
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('joy', 9000));
    t.advance(200);
    t.smoother.decision(t.d('sad', 9200));
    t.smoother.reset();
    expect(t.applied).toEqual(['joy', 'calm']);
    t.advance(EMOTION_HOLD_MS * 2);
    expect(t.applied).toEqual(['joy', 'calm']);
    // новая сессия: смещения идут с нуля и не считаются устаревшими
    t.smoother.setPlaying(true);
    t.smoother.decision(t.d('surprise', 200));
    expect(t.applied).toEqual(['joy', 'calm', 'surprise']);
  });

  it('reset без эмоции на лице ничего не применяет', () => {
    t.smoother.reset();
    expect(t.applied).toEqual([]);
  });
});
