/**
 * Тест 1 куска 7.4 (спека 10.2): документы ⌘P на все пути `lsFiles` — имя файла весит 2, путь —
 * поле; секция показывает 50, а файл за первыми 50 путями находится по имени.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../../shared/files-types.js';
import { rankDocuments, SECTION_LIMITS } from '../palette/documents.js';
import { fileDocuments } from './quick-open.js';

const ROOT: FileRoot = { workKey: '/tmp/p\nw-01', spec: { kind: 'project' } };
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

describe('fileDocuments (тест 1)', () => {
  it('документ несёт путь для значка (спека значков 3.3)', () => {
    const [doc] = fileDocuments(ROOT, ['src/deep/package.json'], () => {});
    expect(doc?.filePath).toBe('src/deep/package.json');
  });

  it('запрос main поднимает src/main.ts выше docs/main-notes/x.md', () => {
    const docs = fileDocuments(ROOT, ['docs/main-notes/x.md', 'src/main.ts'], () => {});
    const [section] = rankDocuments('main', docs, NOW);
    expect(section?.section).toBe('files');
    expect(section?.docs.map((doc) => doc.fields[0])).toEqual(['src/main.ts', 'docs/main-notes/x.md']);
  });

  it('документ: название — имя файла с весом 2, поле — путь, значок файла', () => {
    const [doc] = fileDocuments(ROOT, ['src/deep/name.ts'], () => {});
    expect(doc).toMatchObject({ section: 'files', title: 'name.ts', fields: ['src/deep/name.ts'], titleWeight: 2, icon: 'file' });
  });

  it('60 путей → 60 документов; секция показывает 50, остальное — more (строка Refine your query в палитре)', () => {
    const paths = Array.from({ length: 60 }, (_, index) => `dir/file-${String(index).padStart(2, '0')}.ts`);
    const docs = fileDocuments(ROOT, paths, () => {});
    expect(docs).toHaveLength(60);
    const [section] = rankDocuments('file', docs, NOW);
    expect(SECTION_LIMITS.files).toBe(50);
    expect(section?.docs).toHaveLength(50);
    expect(section?.more).toBe(10);
  });

  it('шестидесятый путь находится по имени', () => {
    const paths = [...Array.from({ length: 59 }, (_, index) => `dir/file-${index}.ts`), 'deep/zeta-last.ts'];
    const docs = fileDocuments(ROOT, paths, () => {});
    const [section] = rankDocuments('zeta', docs, NOW);
    expect(section?.docs.map((doc) => doc.title)).toEqual(['zeta-last.ts']);
  });

  it('run: Enter — open(path, false), ⌘Enter — open(path, true)', () => {
    const open = vi.fn();
    const [doc] = fileDocuments(ROOT, ['a/b.ts'], open);
    doc?.run('default');
    doc?.run('split');
    expect(open.mock.calls).toEqual([
      ['a/b.ts', false],
      ['a/b.ts', true],
    ]);
  });
});
