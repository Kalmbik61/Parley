import { describe, expect, it } from 'vitest';
import { isSilent, levelWidth, peakOf, rms, SILENCE_PEAK } from './level.js';

describe('громкость записи', () => {
  it('rms и пик кадра', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([]))).toBe(0);
    expect(peakOf(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
  });

  it('тишина — пик ниже порога (спека 6.1, первый заслон)', () => {
    expect(isSilent(SILENCE_PEAK / 2)).toBe(true);
    expect(isSilent(SILENCE_PEAK * 2)).toBe(false);
  });

  it('ширина полоски 0…1: тихая речь заметна, громкая не выходит за край', () => {
    expect(levelWidth(0)).toBe(0);
    expect(levelWidth(0.05)).toBeCloseTo(0.4);
    expect(levelWidth(1)).toBe(1);
  });
});
