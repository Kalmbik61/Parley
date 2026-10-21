import { describe, expect, it } from 'vitest';
import { CALLBACK_CODES, optionIndex, parseCallback } from './callbacks.js';

describe('parseCallback', () => {
  it('разбирает карточку pc1', () => {
    expect(parseCallback('pc1:aB3dE9fG:q2')).toEqual({ family: 'pc1', shortId: 'aB3dE9fG', code: 'q2' });
  });
  it('разбирает кнопки карточки согласия: pc1:<shortId>:a и :d', () => {
    expect(parseCallback('pc1:abc:a')).toEqual({ family: 'pc1', shortId: 'abc', code: CALLBACK_CODES.allow });
    expect(parseCallback('pc1:abc:d')).toEqual({ family: 'pc1', shortId: 'abc', code: CALLBACK_CODES.deny });
  });
  it('разбирает карточку помощника pa1', () => {
    expect(parseCallback('pa1:p7:send')).toEqual({ family: 'pa1', proposalId: 'p7', code: 'send' });
  });
  it('мусор и неизвестный код pa1 → null', () => {
    expect(parseCallback('garbage')).toBeNull();
    expect(parseCallback('pc1:onlytwo')).toBeNull();
    expect(parseCallback('xx1:a:b')).toBeNull();
    expect(parseCallback('pa1:p7:maybe')).toBeNull();
    expect(parseCallback('pc1::a')).toBeNull();
  });
});

describe('optionIndex', () => {
  it('q3 → 3, остальное null', () => {
    expect(optionIndex('q3')).toBe(3);
    expect(optionIndex('a')).toBeNull();
    expect(optionIndex('qx')).toBeNull();
  });
  it('согласован с CALLBACK_CODES.option', () => {
    expect(optionIndex(CALLBACK_CODES.option(5))).toBe(5);
  });
});
