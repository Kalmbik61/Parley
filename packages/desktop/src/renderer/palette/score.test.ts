/**
 * Тесты 1–3 куска 6.2 (спека 9.2): очки токена, документа и корзины свежести.
 */

import { describe, expect, it } from 'vitest';
import { normalize, recencyBucket, scoreDocument, scoreToken } from './score.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('scoreToken (тест 1)', () => {
  it('точное совпадение поля — 100, регистр не важен', () => {
    expect(scoreToken('s02', 'S02')).toBe(100);
    expect(scoreToken('S02', 'S02')).toBe(100);
  });

  it('префикс поля — 80', () => {
    expect(scoreToken('исп', 'исполнитель')).toBe(80);
    expect(scoreToken('ред', 'Редизайн окна')).toBe(80);
  });

  it('префикс слова внутри поля — 60', () => {
    expect(scoreToken('окн', 'Редизайн окна')).toBe(60);
  });

  it('подстрока на границе — 40: разделитель и смена регистра в исходном поле', () => {
    expect(scoreToken('api', 'room-api-review')).toBe(40);
    expect(scoreToken('api', 'roomApiReview')).toBe(40);
  });

  it('просто подстрока — 20', () => {
    expect(scoreToken('ain', 'Редизайн main')).toBe(20);
  });

  it('ё совпадает, как е', () => {
    expect(scoreToken('ё', 'ещё')).toBe(scoreToken('е', 'ещё'));
    expect(scoreToken('ё', 'ещё')).toBeGreaterThan(0);
    expect(scoreToken('еще', 'Ещё')).toBe(100);
  });

  it('нет совпадения — 0', () => {
    expect(scoreToken('xyz', 'Редизайн окна')).toBe(0);
  });

  it('нечёткое совпадение: символы по порядку с разрывами — от 1 до 10', () => {
    const score = scoreToken('sprt', 'sprint');
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(10);
    expect(scoreToken('sprt', 'sprint')).toBeGreaterThan(scoreToken('sprt', 's-p-r-i-n-t'));
    expect(scoreToken('abcdefghijklm', 'a1b2c3d4e5f6g7h8i9j0k1l2m')).toBe(1);
  });
});

describe('scoreDocument (тест 2)', () => {
  it('токен не совпал ни с одним полем — null', () => {
    expect(scoreDocument(['api', 'xyz'], { title: 'room-api', fields: ['review'] })).toBeNull();
  });

  it('совпадение по названию весит больше, чем по подписи', () => {
    const byTitle = scoreDocument(['план'], { title: 'план', fields: ['другое'] });
    const byField = scoreDocument(['план'], { title: 'другое', fields: ['план'] });
    expect(byTitle).not.toBeNull();
    expect(byField).not.toBeNull();
    expect(byTitle!).toBeGreaterThan(byField!);
  });

  it('очки документа — сумма очков токенов', () => {
    expect(scoreDocument(['s02', 'план'], { title: 'x', fields: ['S02', 'план'] })).toBe(200);
  });
});

describe('scoreDocument — вес названия из документа (тест 4 куска 7.4)', () => {
  it('titleWeight 2 даёт больше очков, чем вес по умолчанию; без titleWeight — 1.5, как в 6.2', () => {
    const heavy = scoreDocument(['main'], { title: 'main.ts', fields: ['src/main.ts'], titleWeight: 2 });
    const plain = scoreDocument(['main'], { title: 'main.ts', fields: ['src/main.ts'] });
    expect(heavy).toBe(160);
    expect(plain).toBe(120);
    expect(heavy!).toBeGreaterThan(plain!);
  });
});

describe('recencyBucket (тест 3)', () => {
  it('30 мин → 0, 5 ч → 1, 3 сут → 2, 30 сут и null → 3', () => {
    expect(recencyBucket(30 * 60 * 1000)).toBe(0);
    expect(recencyBucket(5 * HOUR)).toBe(1);
    expect(recencyBucket(3 * DAY)).toBe(2);
    expect(recencyBucket(30 * DAY)).toBe(3);
    expect(recencyBucket(null)).toBe(3);
  });
});

describe('normalize', () => {
  it('нижний регистр и ё → е, длина сохраняется', () => {
    expect(normalize('ЁЖИК Ёлка')).toBe('ежик елка');
    expect(normalize('İx').length).toBe(2);
  });
});
