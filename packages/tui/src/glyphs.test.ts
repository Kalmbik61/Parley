import { afterEach, describe, expect, it } from 'vitest';
import { applyGlyphsConfig, glyphs, statusColor, statusGlyph } from './glyphs.js';

// Настройки — общий для всех модуль: после каждого теста возвращаем дефолт.
afterEach(() => applyGlyphsConfig(false));

describe('glyphs', () => {
  it('по умолчанию Unicode (дизайн 6.1)', () => {
    const g = glyphs({});
    expect(g.active).toBe('●');
    expect(g.pending).toBe('◌');
    expect(g.mail).toBe('▤');
    expect(g.expanded).toBe('▾');
    expect(g.collapsed).toBe('▸');
    expect(g.child).toBe('└');
    expect(g.flag).toBe('⚑');
    expect(g.ellipsis).toBe('…');
    expect(g.up).toBe('↑');
    expect(g.down).toBe('↓');
    expect(g.cache).toBe('⇄');
    expect(g.arrow).toBe('→');
    expect(g.cursor).toBe('›');
  });

  it('ascii из настроек даёт запасной набор', () => {
    applyGlyphsConfig(true);
    const g = glyphs({ LANG: 'ru_RU.UTF-8' });
    expect(g.pending).toBe('.');
    expect(g.active).toBe('*');
    expect(g.exited).toBe('!');
    expect(g.done).toBe('+');
    expect(g.failed).toBe('x');
    expect(g.mail).toBe('@');
    expect(g.expanded).toBe('v');
    expect(g.collapsed).toBe('>');
    expect(g.child).toBe('`');
    expect(g.flag).toBe('!');
    expect(g.ellipsis).toBe('~');
    expect(g.rule).toBe('-');
    expect(g.up).toBe('i');
    expect(g.down).toBe('o');
    expect(g.cache).toBe('c');
    expect(g.arrow).toBe('->');
    expect(g.cursor).toBe('>');
  });

  it('переменную окружения сам не читает: её разбирает loadConfig (3.4)', () => {
    // Единственный источник — `config.ascii`; `HARNAS_ASCII` перекрывает файл
    // внутри загрузчика настроек, а не здесь.
    expect(glyphs({ HARNAS_ASCII: '1', LANG: 'ru_RU.UTF-8' }).active).toBe('●');
  });

  it('терминал без Unicode тоже даёт запасной набор (6.1)', () => {
    expect(glyphs({ LANG: 'C' }).active).toBe('*');
    expect(glyphs({ LC_ALL: 'POSIX', LANG: 'ru_RU.UTF-8' }).active).toBe('*');
    expect(glyphs({ LC_CTYPE: 'ru_RU.ISO8859-5' }).active).toBe('*');
  });

  it('UTF-8 в локали оставляет Unicode', () => {
    expect(glyphs({ LANG: 'ru_RU.UTF-8' }).active).toBe('●');
    expect(glyphs({ LC_ALL: 'en_US.utf8' }).active).toBe('●');
    // Локаль не задана вовсе — Unicode: терминалы без неё сегодня скорее юникодные.
    expect(glyphs({ LANG: '' }).active).toBe('●');
  });
});

describe('statusGlyph', () => {
  it('каждому статусу свой глиф — в монохроме различимы все', () => {
    const g = glyphs({});
    const marks = (['pending', 'active', 'exited', 'done', 'failed'] as const).map((status) =>
      statusGlyph(status, g),
    );
    expect(marks).toEqual(['◌', '●', '○', '✓', '✗']);
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('statusColor', () => {
  it('цвета по таблице 6.2', () => {
    expect(statusColor('active')).toEqual({ color: 'green' });
    expect(statusColor('done')).toEqual({ color: 'green' });
    expect(statusColor('exited')).toEqual({ color: 'yellow' });
    expect(statusColor('failed')).toEqual({ color: 'red' });
    expect(statusColor('pending')).toEqual({ dimColor: true });
  });
});

describe('frame', () => {
  it('несёт грани рамки в обоих наборах', () => {
    applyGlyphsConfig(false);
    expect(glyphs().frame).toEqual({
      topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
      horizontal: '─', vertical: '│',
    });
    applyGlyphsConfig(true);
    expect(glyphs().frame).toEqual({
      topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
      horizontal: '-', vertical: '|',
    });
  });
});

describe('ширина глифов', () => {
  it('каждый Unicode-глиф занимает одну колонку по меркам Ink (string-width)', async () => {
    // Ink режет строки по string-width, а бюджеты списков считают String.length:
    // глиф шириной 2 (как был ✉) выталкивает за панель последний знак строки —
    // ту самую цифру `▤N`, которую дизайн 6.4 запрещает отбрасывать.
    const { default: stringWidth } = await import('string-width');
    const g = glyphs({});
    for (const [name, value] of Object.entries(g)) {
      if (typeof value !== 'string' || name === 'arrow') continue;
      expect(stringWidth(value), `глиф ${name} «${value}»`).toBe(1);
    }
  });
});
