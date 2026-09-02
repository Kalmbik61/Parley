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
  });

  it('пустое значение переменной ASCII-режим не включает', () => {
    expect(glyphs({ HARNAS_ASCII: '' }).active).toBe('●');
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
