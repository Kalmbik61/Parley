/** Кусок 7.5, тест 1: разбор CSV и TSV по RFC 4180. */

import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv (тест 1)', () => {
  it('a,"b,c",d — три поля: запятая в кавычках поле не делит', () => {
    expect(parseCsv('a,"b,c",d', ',', 10)).toEqual({ rows: [['a', 'b,c', 'd']], truncated: false });
  });

  it('"x""y" — x"y: удвоенная кавычка внутри поля', () => {
    expect(parseCsv('"x""y"', ',', 10).rows).toEqual([['x"y']]);
  });

  it('перевод строки в кавычках не рвёт строку; CRLF и LF — концы строк', () => {
    expect(parseCsv('a,"line 1\nline 2",c\r\nd,e,f\n', ',', 10)).toEqual({
      rows: [
        ['a', 'line 1\nline 2', 'c'],
        ['d', 'e', 'f'],
      ],
      truncated: false,
    });
  });

  it('10 001 строка — 10 000 и truncated; ровно 10 000 — без truncated', () => {
    const lines = Array.from({ length: 10_001 }, (_, index) => `${index},x`);
    const over = parseCsv(lines.join('\n'), ',', 10_000);
    expect(over.rows).toHaveLength(10_000);
    expect(over.rows.at(-1)).toEqual(['9999', 'x']);
    expect(over.truncated).toBe(true);
    const exact = parseCsv(lines.slice(0, 10_000).join('\n') + '\n', ',', 10_000);
    expect(exact.rows).toHaveLength(10_000);
    expect(exact.truncated).toBe(false);
  });

  it('TSV: табуляция — разделитель, запятая — текст; пустые поля сохраняются', () => {
    expect(parseCsv('a,b\t"c\td"\t\n\t', '\t', 10).rows).toEqual([
      ['a,b', 'c\td', ''],
      ['', ''],
    ]);
  });

  it('пустой текст — ни одной строки; кавычка без пары — поле до конца текста', () => {
    expect(parseCsv('', ',', 10)).toEqual({ rows: [], truncated: false });
    expect(parseCsv('a,"b\nc', ',', 10).rows).toEqual([['a', 'b\nc']]);
  });
});
