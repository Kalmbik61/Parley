import { describe, expect, it } from 'vitest';
import { DraftTracker } from './draft.js';

/** Таблица правил черновика — план, кусок 1.6. */
const CASES: Array<{ input: string; hasDraft: boolean | 'unchanged' }> = [
  { input: 'привет', hasDraft: true },
  { input: 'привет\r', hasDraft: false },
  { input: 'ab\x7f\x7f', hasDraft: false },
  { input: 'ab\x7f', hasDraft: true },
  { input: '\x1b[A', hasDraft: 'unchanged' },
  { input: '\x1b[200~текст\x1b[201~', hasDraft: true },
  { input: '😀\x7f', hasDraft: false },
  { input: 'abc\x15', hasDraft: false },
];

describe('DraftTracker', () => {
  for (const testCase of CASES) {
    it(`${JSON.stringify(testCase.input)} → ${testCase.hasDraft}`, () => {
      const tracker = new DraftTracker();
      if (testCase.hasDraft === 'unchanged') {
        // Курсорные и прочие CSI не должны сдвигать счётчик ни в одну сторону:
        // проверяем это с обеих сторон — при пустом и непустом черновике.
        tracker.input(testCase.input);
        expect(tracker.hasDraft).toBe(false);

        tracker.input('x');
        expect(tracker.hasDraft).toBe(true);
        tracker.input(testCase.input);
        expect(tracker.hasDraft).toBe(true);
        return;
      }
      tracker.input(testCase.input);
      expect(tracker.hasDraft).toBe(testCase.hasDraft);
    });
  }

  it('reset() обнуляет счётчик', () => {
    const tracker = new DraftTracker();
    tracker.input('текст');
    expect(tracker.hasDraft).toBe(true);
    tracker.reset();
    expect(tracker.hasDraft).toBe(false);
  });

  it('backspace не уводит счётчик ниже нуля', () => {
    const tracker = new DraftTracker();
    tracker.input('\x7f\x7f\x7f');
    expect(tracker.hasDraft).toBe(false);
  });
});
