import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { fillLine, pad } from './fill.js';

describe('pad — переезжает из sidebar.tsx без изменений (приёмка B)', () => {
  it('добивает пробелами до ширины', () => {
    expect(pad(3, 10)).toBe(' '.repeat(7));
    expect(pad(0, 5)).toBe(' '.repeat(5));
  });

  it('used > width — вырожденный случай, пустая строка, а не отрицательный повтор', () => {
    expect(pad(12, 5)).toBe('');
    expect(pad(6, 5)).toBe('');
  });

  it('width = 0 — вырожденный случай, пустая строка при любом used', () => {
    expect(pad(0, 0)).toBe('');
    expect(pad(5, 0)).toBe('');
  });
});

describe('fillLine — считает по колонкам, а не по длине строки (приёмка B)', () => {
  it('короткий текст добивается пробелами до нужной ширины', () => {
    expect(fillLine('ab', 5)).toBe('ab   ');
    expect(stringWidth(fillLine('ab', 5))).toBe(5);
  });

  it('текст уже нужной ширины — без изменений', () => {
    expect(fillLine('abcde', 5)).toBe('abcde');
  });

  it('width = 0 — пустая строка', () => {
    expect(fillLine('abc', 0)).toBe('');
  });

  it('широкие символы (CJK, 2 колонки) считаются по колонкам, не по .length', () => {
    // '文字' — два full-width знака: 2 по .length, но 4 колонки. Добивка по
    // .length дала бы 4 пробела (итого 6 колонок вместо 6), здесь их 2.
    const filled = fillLine('文字', 6);
    expect(filled).toBe('文字  ');
    expect(stringWidth(filled)).toBe(6);
  });

  it('текст уже нужной ширины в колонках — добивки нет, даже если .length меньше width', () => {
    // '文字'.length === 2, но stringWidth === 4: на width=4 добивки быть не должно.
    expect(fillLine('文字', 4)).toBe('文字');
  });

  it('многоточие (ellipsis) занимает одну колонку — считается верно', () => {
    expect(fillLine('…', 3)).toBe('…  ');
    expect(stringWidth(fillLine('…', 3))).toBe(3);
  });

  it('текст длиннее ширины — усекается по колонкам', () => {
    expect(fillLine('abcdef', 3)).toBe('abc');
    expect(stringWidth(fillLine('abcdef', 3))).toBe(3);
  });

  it('широкий символ на границе ширины — усекается, не переполняя колонки', () => {
    // '文' — 2 колонки. На ширине 3 после него влезает только 1 обычный знак.
    const cut = fillLine('文abc', 3);
    expect(stringWidth(cut)).toBeLessThanOrEqual(3);
  });

  it('результат всегда ровно width колонок — обычные строки, широкие символы, многоточие, ширины 1..12', () => {
    // Срез широкого символа на границе может снять две колонки разом и
    // отдать width - 1: без добивки остатка это осталось бы незамеченным
    // точечными тестами выше, поэтому здесь — инвариант по всем ширинам.
    const samples = ['', 'a', 'abcdefghij', '文字文字', 'ab文cd文ef', '…', 'a…b…c', '文…a'];
    for (const text of samples) {
      for (let width = 1; width <= 12; width++) {
        expect(stringWidth(fillLine(text, width))).toBe(width);
      }
    }
  });
});
