import { describe, expect, it } from 'vitest';
import type { DiffNote } from '../../../shared/notes-types.js';
import { formatNotes } from './format.js';

function note(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: '0a1b2c3d',
    path: 'src/a.ts',
    side: 'modified',
    startLine: 7,
    endLine: 7,
    body: 'fix',
    createdAt: '2026-09-27T14:05:01.000Z',
    updatedAt: '2026-09-27T14:05:01.000Z',
    sentAt: null,
    sentTo: null,
    anchor: { text: 'x' },
    stale: false,
    ...overrides,
  };
}

const BRANCH = 'harnas/w-0003/s02';

describe('formatNotes (кусок 8.4a, тест 1)', () => {
  it('одна строка → Line: 7; заголовок с веткой и пустая строка за ним', () => {
    expect(formatNotes({ sessionLabel: 'S02', branch: BRANCH, notes: [note({ body: 'ещё текст' })] })).toBe(
      ['Review notes for S02 (branch harnas/w-0003/s02):', '', 'File: src/a.ts', 'Line: 7', 'Note: ещё текст'].join('\n'),
    );
  });

  it('диапазон → Lines: 10-14', () => {
    expect(formatNotes({ sessionLabel: 'S02', branch: BRANCH, notes: [note({ startLine: 10, endLine: 14 })] })).toContain(
      'File: src/a.ts\nLines: 10-14\nNote: fix',
    );
  });

  it('старая сторона → строка Side: original после строк', () => {
    expect(formatNotes({ sessionLabel: 'S02', branch: BRANCH, notes: [note({ side: 'original' })] })).toContain(
      'File: src/a.ts\nLine: 7\nSide: original\nNote: fix',
    );
    expect(formatNotes({ sessionLabel: 'S02', branch: BRANCH, notes: [note()] })).not.toContain('Side:');
  });

  it('две заметки разделены пустой строкой; порядок — по файлу, потом по строке', () => {
    const text = formatNotes({
      sessionLabel: 'S02',
      branch: BRANCH,
      notes: [
        note({ path: 'src/b.ts', startLine: 7, endLine: 7, body: 'b7' }),
        note({ path: 'src/a.ts', startLine: 20, endLine: 22, body: 'a20' }),
        note({ path: 'src/a.ts', startLine: 3, endLine: 3, body: 'a3' }),
      ],
    });
    expect(text).toBe(
      [
        'Review notes for S02 (branch harnas/w-0003/s02):',
        '',
        'File: src/a.ts',
        'Line: 3',
        'Note: a3',
        '',
        'File: src/a.ts',
        'Lines: 20-22',
        'Note: a20',
        '',
        'File: src/b.ts',
        'Line: 7',
        'Note: b7',
      ].join('\n'),
    );
  });

  it('переводы строк в тексте сохранены', () => {
    expect(formatNotes({ sessionLabel: 'S02', branch: BRANCH, notes: [note({ body: 'first,\nsecond\n\nthird' })] })).toContain(
      'Note: first,\nsecond\n\nthird',
    );
  });

  it('без ветки — Review notes for S02:', () => {
    expect(formatNotes({ sessionLabel: 'S02', branch: null, notes: [note()] }).split('\n')[0]).toBe('Review notes for S02:');
  });
});
