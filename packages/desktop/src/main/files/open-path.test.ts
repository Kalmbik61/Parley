import { describe, expect, it } from 'vitest';
import { OPENABLE_EXTENSIONS, openVerdict } from './open-path.js';

const file = (name: string, mode = 0o100644): { name: string; isDirectory: boolean; mode: number } => ({
  name,
  isDirectory: false,
  mode,
});
const folder = (name: string): { name: string; isDirectory: boolean; mode: number } => ({
  name,
  isDirectory: true,
  mode: 0o40755,
});

describe('openVerdict (кусок 5.2, тест 12)', () => {
  it('x.command, x.SH, index.html и x.py 0644 — reveal', () => {
    for (const name of ['x.command', 'x.SH', 'index.html', 'x.py']) {
      expect(openVerdict([file(name), file(name)]), name).toBe('reveal');
    }
  });

  it('report.pdf, a.txt, IMG.PNG 0644 — open', () => {
    for (const name of ['report.pdf', 'a.txt', 'IMG.PNG']) {
      expect(openVerdict([file(name), file(name)]), name).toBe('open');
    }
  });

  it('notes.txt 0755 — reveal: бит x главнее белого списка', () => {
    expect(openVerdict([file('notes.txt', 0o100755), file('notes.txt', 0o100755)])).toBe('reveal');
    expect(openVerdict([file('notes.txt', 0o100644 | 0o001), file('notes.txt', 0o100644 | 0o001)])).toBe('reveal');
  });

  it('каталог Foo.app — reveal, каталог docs — open', () => {
    expect(openVerdict([folder('Foo.app'), folder('Foo.app')])).toBe('reveal');
    expect(openVerdict([folder('docs'), folder('docs')])).toBe('open');
  });

  it('a.txt, чей realpath — b.command, — reveal', () => {
    expect(openVerdict([file('a.txt'), file('b.command')])).toBe('reveal');
  });

  it('файл без расширения, офис с макросами, архив и .webloc — reveal', () => {
    for (const name of ['Makefile', 'book.xlsm', 'a.zip', 'link.webloc', 'setup.pkg', 'x.htm', '.bashrc']) {
      expect(openVerdict([file(name), file(name)]), name).toBe('reveal');
    }
  });

  it('белый список — ровно спека 10.8', () => {
    expect([...OPENABLE_EXTENSIONS].sort()).toEqual(
      [
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'ico', 'svg',
        'pdf',
        'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'log',
        'docx', 'xlsx', 'pptx', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp',
        'mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'm4v', 'webm',
      ].sort(),
    );
  });
});
