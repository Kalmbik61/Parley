import { describe, expect, it } from 'vitest';
import { glyphs, statusColor, statusGlyph } from './glyphs.js';

describe('glyphs', () => {
  it('по умолчанию Unicode (дизайн 6.1)', () => {
    const g = glyphs({});
    expect(g.active).toBe('●');
    expect(g.pending).toBe('◌');
    expect(g.mail).toBe('✉');
    expect(g.expanded).toBe('▾');
    expect(g.collapsed).toBe('▸');
    expect(g.child).toBe('└');
    expect(g.flag).toBe('⚑');
    expect(g.ellipsis).toBe('…');
    expect(g.up).toBe('↑');
    expect(g.down).toBe('↓');
    expect(g.cache).toBe('⇄');
    expect(g.arrow).toBe('→');
  });

  it('HARNAS_ASCII=1 даёт запасной набор', () => {
    const g = glyphs({ HARNAS_ASCII: '1' });
    expect(g.pending).toBe('.');
    expect(g.active).toBe('*');
    expect(g.idle).toBe('~');
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
  });

  it('пустое значение переменной ASCII-режим не включает', () => {
    expect(glyphs({ HARNAS_ASCII: '' }).active).toBe('●');
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
    const marks = (['pending', 'active', 'idle', 'exited', 'done', 'failed'] as const).map(
      (status) => statusGlyph(status, g),
    );
    expect(marks).toEqual(['◌', '●', '◐', '○', '✓', '✗']);
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('statusColor', () => {
  it('цвета по таблице 6.2', () => {
    expect(statusColor('active')).toEqual({ color: 'green' });
    expect(statusColor('done')).toEqual({ color: 'green' });
    expect(statusColor('idle')).toEqual({ color: 'yellow' });
    expect(statusColor('exited')).toEqual({ color: 'yellow' });
    expect(statusColor('failed')).toEqual({ color: 'red' });
    expect(statusColor('pending')).toEqual({ dimColor: true });
  });
});
