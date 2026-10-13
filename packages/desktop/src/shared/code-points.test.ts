import { describe, expect, it } from 'vitest';
import { cutCodePoints } from './code-points.js';

/** Эталон: как резала прежняя версия, раскладывая строку целиком. */
function reference(text: string, limit: number): { text: string; cut: boolean } {
  const points = Array.from(text);
  return points.length <= limit ? { text, cut: false } : { text: points.slice(0, limit).join(''), cut: true };
}

describe('cutCodePoints', () => {
  it('не длиннее предела — как есть, без обрезки; пара-эмодзи занимает два юнита, но одну точку', () => {
    expect(cutCodePoints('abc', 3)).toEqual({ text: 'abc', cut: false });
    expect(cutCodePoints('', 0)).toEqual({ text: '', cut: false });
    // Длина строки (3) больше предела (2), а точек две — обрезки нет.
    expect(cutCodePoints('a😀', 2)).toEqual({ text: 'a😀', cut: false });
  });

  it('длиннее — первые `limit` кодовых точек; суррогатная пара не рвётся', () => {
    expect(cutCodePoints('abcdef', 3)).toEqual({ text: 'abc', cut: true });
    expect(cutCodePoints('😀😀😀', 2)).toEqual({ text: '😀😀', cut: true });
    expect(cutCodePoints('a😀b', 2)).toEqual({ text: 'a😀', cut: true });
    expect(cutCodePoints('abc', 0)).toEqual({ text: '', cut: true });
  });

  it('как Array.from на любых краях: одинокие суррогаты, пары, пределы от 0 до 7', () => {
    const samples = ['', 'a', 'abc', '😀', 'a😀b😀', '\ud83d', '\ude00a', 'a\ud83d', '\ud83d\ud83d', '\ud83da', 'я😀я', '😀\ude00'];
    for (const sample of samples) {
      for (let limit = 0; limit <= 7; limit += 1) {
        expect(cutCodePoints(sample, limit), `${JSON.stringify(sample)} / ${limit}`).toEqual(reference(sample, limit));
      }
    }
  });

  it('строка в 50 млн знаков (длину задаёт страница) режется за время, не зависящее от длины: точки не раскладываются в массив', () => {
    const huge = 'x'.repeat(50_000_000);
    const started = performance.now();
    const result = cutCodePoints(huge, 500);
    const elapsed = performance.now() - started;
    expect(result).toEqual({ text: 'x'.repeat(500), cut: true });
    // Порог по времени, а не таймаут теста: вызов синхронный. Прежняя версия (`Array.from` по всей строке) — около полутора
    // секунд и ~800 МБ кучи в main, ленивая — единицы миллисекунд.
    expect(elapsed).toBeLessThan(300);
  });

  it('то же для суррогатных пар: 25 млн эмодзи, обрезка не посередине пары', () => {
    const huge = '😀'.repeat(25_000_000);
    const started = performance.now();
    const result = cutCodePoints(huge, 500);
    const elapsed = performance.now() - started;
    expect(result).toEqual({ text: '😀'.repeat(500), cut: true });
    expect(elapsed).toBeLessThan(300);
  });
});
