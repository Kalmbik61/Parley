import { describe, expect, it } from 'vitest';
import { MODEL_QUIET_HOLD_MS, createHysteresis, humanSpeakingHysteresis, modelPlayingHysteresis, rms } from './levels.js';

describe('rms', () => {
  it('пустой кадр — 0, постоянный — модуль, синус — 1/√2', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5])).toBeCloseTo(0.5);
    const sine = Array.from({ length: 1000 }, (_, i) => Math.sin((2 * Math.PI * i) / 100));
    expect(rms(sine)).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('createHysteresis', () => {
  const make = () => createHysteresis({ on: 0.02, off: 0.01, attackMs: 60, holdMs: 300 });

  it('включается только после attackMs непрерывного уровня; одиночный щелчок не считается', () => {
    const h = make();
    expect(h.push(0.5, 0)).toBe(false);
    expect(h.push(0, 20)).toBe(false);
    expect(h.push(0.5, 40)).toBe(false);
    expect(h.push(0.5, 80)).toBe(false);
    expect(h.push(0.5, 100)).toBe(true);
  });

  it('гаснет только после holdMs непрерывной тишины ниже off', () => {
    const h = make();
    h.push(0.1, 0);
    h.push(0.1, 100);
    expect(h.active).toBe(true);
    expect(h.push(0.0, 200)).toBe(true);
    expect(h.push(0.0, 499)).toBe(true);
    expect(h.push(0.0, 500)).toBe(false);
  });

  it('уровень между off и on держит сигнал и сбрасывает отсчёт тишины', () => {
    const h = make();
    h.push(0.1, 0);
    h.push(0.1, 100);
    h.push(0.0, 200);
    expect(h.push(0.015, 400)).toBe(true);
    expect(h.push(0.0, 450)).toBe(true);
    expect(h.push(0.0, 740)).toBe(true);
    expect(h.push(0.0, 750)).toBe(false);
  });

  it('после гашения снова включается с новым attack', () => {
    const h = make();
    h.push(0.1, 0);
    h.push(0.1, 100);
    h.push(0, 200);
    h.push(0, 500);
    expect(h.active).toBe(false);
    expect(h.push(0.1, 600)).toBe(false);
    expect(h.push(0.1, 660)).toBe(true);
  });

  it('reset гасит сигнал', () => {
    const h = make();
    h.push(0.1, 0);
    h.push(0.1, 100);
    h.reset();
    expect(h.active).toBe(false);
  });
});

describe('готовые сигналы', () => {
  it('modelPlaying: включается сразу, пауза внутри реплики короче 500 мс не гасит, ровно 500 мс — гасит', () => {
    expect(MODEL_QUIET_HOLD_MS).toBeGreaterThanOrEqual(500);
    const h = modelPlayingHysteresis();
    expect(h.push(0.05, 0)).toBe(true);
    expect(h.push(0, 100)).toBe(true);
    expect(h.push(0, 100 + MODEL_QUIET_HOLD_MS - 1)).toBe(true);
    expect(h.push(0.05, 100 + MODEL_QUIET_HOLD_MS)).toBe(true);
    expect(h.push(0, 1000)).toBe(true);
    expect(h.push(0, 1000 + MODEL_QUIET_HOLD_MS)).toBe(false);
  });

  it('humanSpeaking: тишина микрофона не включает, речь включает', () => {
    const h = humanSpeakingHysteresis();
    for (let t = 0; t < 500; t += 20) expect(h.push(0.002, t)).toBe(false);
    let on = false;
    for (let t = 500; t < 700; t += 20) on = h.push(0.05, t);
    expect(on).toBe(true);
  });
});
