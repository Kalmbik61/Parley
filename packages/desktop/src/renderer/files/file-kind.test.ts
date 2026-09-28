/** Тест 10 куска 7.3a: вид файла по расширению без учёта регистра. */

import { describe, expect, it } from 'vitest';
import { fileKind } from './file-kind.js';

describe('fileKind (тест 10)', () => {
  it('README.MD — markdown, x.tsv — tsv, logo.SVG — image, a.pdf — pdf, Makefile — text', () => {
    expect(fileKind('README.MD')).toBe('markdown');
    expect(fileKind('x.tsv')).toBe('tsv');
    expect(fileKind('logo.SVG')).toBe('image');
    expect(fileKind('a.pdf')).toBe('pdf');
    expect(fileKind('Makefile')).toBe('text');
  });

  it('прочие расширения списка и путь с папками; точка в имени папки расширением не считается', () => {
    // Спека 10.6: превью Markdown — у `.md` и `.markdown`.
    expect(fileKind('docs/notes.markdown')).toBe('markdown');
    expect(fileKind('data/t.csv')).toBe('csv');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) expect(fileKind(`img/a.${ext}`)).toBe('image');
    expect(fileKind('src/a.ts')).toBe('text');
    expect(fileKind('v1.2/Makefile')).toBe('text');
    expect(fileKind('.gitignore')).toBe('text');
    expect(fileKind('a.constructor')).toBe('text');
  });
});
