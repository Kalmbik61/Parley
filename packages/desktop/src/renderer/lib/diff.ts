/**
 * Разбор git-патча `worktrees.diff` на файлы с ханками (кусок 4.3 плана
 * worktree): `gitdiff-parser` — та же библиотека, которую `react-diff-view`
 * называет эталонным парсером для git-диффов, её `Hunk[]` подходит `<Diff>`
 * без переразметки.
 */

import gitDiffParser, { type File as GitDiffFile } from 'gitdiff-parser';

export type { GitDiffFile };

/** Заголовок нового файла в едином патче — им же режем текст на секции ниже. */
const DIFF_HEADER = /^diff --git /m;

/** `gitdiff-parser@0.3.1` не выставляет `isBinary` для обычного вывода `git diff` («Binary files a/… and b/… differ» без явного `GIT binary patch`) — сама библиотека читает эту строку только вне разбора заголовка файла, куда она на практике никогда не долетает. */
function isBinarySection(section: string): boolean {
  return /^Binary files /m.test(section);
}

/**
 * Пустой патч (нет изменений вовсе) — гарантированно пустой список, а не сбой
 * парсера на `''`. Бинарные файлы довешиваются по тексту секции: секции идут
 * в том же порядке, что и файлы результата, — так же, как их видит сам парсер.
 */
export function parsePatch(patch: string): GitDiffFile[] {
  if (patch.trim() === '') return [];
  const files = gitDiffParser.parse(patch);
  const sections = patch.split(DIFF_HEADER).slice(1);
  return files.map((file, index) => {
    const section = sections[index];
    return section !== undefined && isBinarySection(section) ? { ...file, isBinary: true } : file;
  });
}

/** Путь файла для заголовка: у удалённого файла нового пути нет. */
export function filePathOf(file: GitDiffFile): string {
  return file.type === 'delete' ? file.oldPath : file.newPath;
}
