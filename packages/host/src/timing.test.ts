import { describe, expect, it } from 'vitest';
import { createStepTimer } from './timing.js';

/** Часы, которые отдают заданные отметки по одной на вызов. */
function clock(marks: number[]): () => number {
  const queue = [...marks];
  return () => queue.shift() ?? 0;
}

describe('createStepTimer', () => {
  it('считает длительность шагов, порядок по первому появлению и totalMs', async () => {
    // старт 0; a: 10..40; b: 40..45; общий конец 100
    const timer = createStepTimer(clock([0, 10, 40, 40, 45, 100]));
    await timer.step('a', async () => 1);
    await timer.step('b', async () => 2);
    const result = timer.result();
    expect(result).toEqual({ totalMs: 100, steps: { a: 30, b: 5 } });
    expect(Object.keys(result.steps)).toEqual(['a', 'b']);
  });

  it('одинаковые имена складываются, значения округляются', async () => {
    const timer = createStepTimer(clock([0, 0, 10.4, 20, 25.2, 30]));
    await timer.step('a', async () => {});
    await timer.step('a', async () => {});
    expect(timer.result().steps).toEqual({ a: 16 });
  });

  it('упавший шаг учтён, ошибка проброшена', async () => {
    const timer = createStepTimer(clock([0, 5, 25, 30]));
    await expect(timer.step('bad', async () => {
      throw new Error('сбой');
    })).rejects.toThrow('сбой');
    expect(timer.result()).toEqual({ totalMs: 30, steps: { bad: 20 } });
  });

  it('возвращает значение работы', async () => {
    const timer = createStepTimer(clock([0, 0, 1]));
    await expect(timer.step('a', async () => 42)).resolves.toBe(42);
  });
});
