import { describe, expect, it } from 'vitest';
import { formatElapsed } from './elapsed';
import { levelOf } from './level';
import { assembleTranscript } from './transcript';

describe('levelOf', () => {
  it('clamps −2…10 to 0…1', () => {
    expect(levelOf(-2)).toBe(0);
    expect(levelOf(0)).toBe(0);
    expect(levelOf(5)).toBe(0.5);
    expect(levelOf(12)).toBe(1);
    expect(levelOf(Number.NaN)).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(65_400)).toBe('1:05');
  });
});

describe('assembleTranscript', () => {
  const final = (t: string) => ({ isFinal: true, results: [{ transcript: t }] });
  it('joins final pieces with one space (iOS 18 leading space)', () => {
    expect(assembleTranscript([final('hello there'), final(' how are you ')])).toBe('hello there how are you');
  });
  it('skips the empty final result and non-final ones', () => {
    expect(assembleTranscript([final('a'), { isFinal: true, results: [] }, { isFinal: false, results: [{ transcript: 'x' }] }, final('b')])).toBe('a b');
    expect(assembleTranscript([{ isFinal: true, results: [] }])).toBe('');
  });
});
