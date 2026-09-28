import { describe, expect, it } from 'vitest';
import { NOTES_LIMITS, type DiffNote } from '../../../shared/notes-types.js';
import { relocate } from './anchor.js';

function note(startLine: number, endLine: number, text: string): DiffNote {
  return {
    id: '0a1b2c3d',
    path: 'src/a.ts',
    side: 'modified',
    startLine,
    endLine,
    body: 'fix',
    createdAt: '2026-09-27T14:05:01.000Z',
    updatedAt: '2026-09-27T14:05:01.000Z',
    sentAt: null,
    sentTo: null,
    anchor: { text },
    stale: false,
  };
}

/** n строк `line 1` … `line n`, якорная — на позиции at (1-based). */
function linesWith(n: number, at: number, anchor: string): string[] {
  return Array.from({ length: n }, (_, i) => (i + 1 === at ? anchor : `line ${i + 1}`));
}

describe('relocate (кусок 8.4a, тест 2)', () => {
  const ANCHOR = 'const target = compute();';

  it('строка на месте → та же', () => {
    expect(relocate(note(10, 12, ANCHOR), linesWith(50, 10, ANCHOR))).toEqual({ startLine: 10, endLine: 12, stale: false });
  });

  it('сдвиг на 5 строк вниз и вверх → новая позиция, диапазон сохраняет длину', () => {
    expect(relocate(note(10, 12, ANCHOR), linesWith(50, 15, ANCHOR))).toEqual({ startLine: 15, endLine: 17, stale: false });
    expect(relocate(note(10, 12, ANCHOR), linesWith(50, 5, ANCHOR))).toEqual({ startLine: 5, endLine: 7, stale: false });
  });

  it('ровно ±20 строк ещё находится', () => {
    expect(relocate(note(30, 30, ANCHOR), linesWith(80, 50, ANCHOR))).toEqual({ startLine: 50, endLine: 50, stale: false });
    expect(relocate(note(30, 30, ANCHOR), linesWith(80, 10, ANCHOR))).toEqual({ startLine: 10, endLine: 10, stale: false });
  });

  it('текст исчез → stale: true, позиция прежняя', () => {
    expect(relocate(note(10, 12, ANCHOR), linesWith(50, 0, ANCHOR))).toEqual({ startLine: 10, endLine: 12, stale: true });
  });

  it('сдвиг на 25 строк → stale: true', () => {
    expect(relocate(note(10, 12, ANCHOR), linesWith(80, 35, ANCHOR))).toEqual({ startLine: 10, endLine: 12, stale: true });
  });

  it('устаревшая заметка, чья строка вернулась, снова свежая', () => {
    expect(relocate({ ...note(10, 10, ANCHOR), stale: true }, linesWith(50, 12, ANCHOR))).toEqual({ startLine: 12, endLine: 12, stale: false });
  });

  it('файл стал короче строки заметки — ищет в оставшихся, не падает', () => {
    expect(relocate(note(40, 40, ANCHOR), linesWith(25, 22, ANCHOR))).toEqual({ startLine: 22, endLine: 22, stale: false });
    expect(relocate(note(40, 40, ANCHOR), [])).toEqual({ startLine: 40, endLine: 40, stale: true });
  });

  it('якорь длинной строки обрезан до предела: строка сверяется по тому же префиксу', () => {
    const long = 'a'.repeat(NOTES_LIMITS.anchor + 100);
    const cut = long.slice(0, NOTES_LIMITS.anchor);
    expect(relocate(note(10, 10, cut), linesWith(50, 13, long))).toEqual({ startLine: 13, endLine: 13, stale: false });
  });
});
