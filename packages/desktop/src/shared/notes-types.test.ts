import { describe, expect, it } from 'vitest';
import { isNotesFile, NOTES_LIMITS, type DiffNote, type NotesFile } from './notes-types.js';

function note(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: '0a1b2c3d',
    path: 'src/a.ts',
    side: 'modified',
    startLine: 10,
    endLine: 14,
    body: 'fix this',
    createdAt: '2026-09-27T14:05:01.000Z',
    updatedAt: '2026-09-27T14:05:01.000Z',
    sentAt: null,
    sentTo: null,
    anchor: { text: 'const a = 1;' },
    stale: false,
    ...overrides,
  };
}

function file(notes: DiffNote[]): NotesFile {
  return { version: 1, notes };
}

describe('isNotesFile (кусок 8.4a, тест 4)', () => {
  it('верная форма — true, в том числе пустой список, отправленная заметка и ровно на пределах', () => {
    expect(isNotesFile(file([]))).toBe(true);
    expect(isNotesFile(file([note()]))).toBe(true);
    expect(isNotesFile(file([note({ sentAt: '2026-09-27T14:06:00.000Z', sentTo: 's-02', side: 'original' })]))).toBe(true);
    expect(isNotesFile(file([note({ startLine: 7, endLine: 7 })]))).toBe(true);
    expect(isNotesFile(file([note({ body: 'x'.repeat(NOTES_LIMITS.body), anchor: { text: 'y'.repeat(NOTES_LIMITS.anchor) } })]))).toBe(true);
    expect(isNotesFile(file(Array.from({ length: NOTES_LIMITS.notes }, () => note())))).toBe(true);
  });

  it('пределы плана: 1000 заметок, 1 МБ, тело 4000, якорь 4000', () => {
    expect(NOTES_LIMITS).toEqual({ notes: 1000, fileBytes: 1024 * 1024, body: 4000, anchor: 4000 });
  });

  it('1001 заметка → false', () => {
    expect(isNotesFile(file(Array.from({ length: 1001 }, () => note())))).toBe(false);
  });

  it('anchor.text из 4001 символа → false', () => {
    expect(isNotesFile(file([note({ anchor: { text: 'a'.repeat(4001) } })]))).toBe(false);
  });

  it('body пустой и из 4001 символа → false', () => {
    expect(isNotesFile(file([note({ body: '' })]))).toBe(false);
    expect(isNotesFile(file([note({ body: 'b'.repeat(4001) })]))).toBe(false);
  });

  it("sentTo: '../x' → false", () => {
    expect(isNotesFile(file([note({ sentAt: '2026-09-27T14:06:00.000Z', sentTo: '../x' })]))).toBe(false);
  });

  it('startLine больше endLine → false', () => {
    expect(isNotesFile(file([note({ startLine: 15, endLine: 14 })]))).toBe(false);
  });

  it('JSON больше 1 МБ → false, хотя каждая заметка в пределах', () => {
    const big = Array.from({ length: 300 }, () => note({ body: 'z'.repeat(4000) }));
    expect(JSON.stringify(file(big)).length).toBeGreaterThan(NOTES_LIMITS.fileBytes);
    expect(isNotesFile(file(big))).toBe(false);
  });

  it('прочие поломки формы → false', () => {
    const withoutBody: Record<string, unknown> = { ...note() };
    delete withoutBody.body;
    const broken: unknown[] = [
      null,
      [],
      'x',
      { version: 2, notes: [] },
      { version: 1 },
      { version: 1, notes: {} },
      { version: 1, notes: [withoutBody] },
      file([note({ id: 'nothex!!' })]),
      file([note({ id: '0a1b2c3' })]),
      file([note({ path: '' })]),
      file([note({ side: 'left' as DiffNote['side'] })]),
      file([note({ startLine: 0, endLine: 3 })]),
      file([note({ startLine: 1.5, endLine: 3 })]),
      file([note({ createdAt: 1 as unknown as string })]),
      file([note({ sentAt: 5 as unknown as string })]),
      file([note({ anchor: 'x' as unknown as DiffNote['anchor'] })]),
      file([note({ stale: 'no' as unknown as boolean })]),
    ];
    for (const value of broken) expect(isNotesFile(value), JSON.stringify(value)?.slice(0, 80)).toBe(false);
  });
});
