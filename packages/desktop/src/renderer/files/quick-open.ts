/**
 * Документы ⌘P (кусок 7.4, спека 10.2): по одному на каждый путь `lsFiles`. Название — имя
 * файла с весом 2, поле — путь. Документы — на все пути, а не на первые 50: предел секции (6.2)
 * срабатывает после ранжирования, иначе файл за первыми 50 путями не нашёлся бы.
 */

import type { FileRoot } from '../../shared/files-types.js';
import type { PaletteDoc } from '../palette/documents.js';

/** Вес имени файла в очках (спека 10.2). */
const FILE_NAME_WEIGHT = 2;

/** Документы на все пути lsFiles: title — имя файла (titleWeight 2), fields — [путь]. 50 показывает секция после ранжирования. */
export function fileDocuments(root: FileRoot, paths: string[], open: (path: string, split: boolean) => void): PaletteDoc[] {
  return paths.map((path, index) => ({
    id: `file:${root.workKey}\n${path}`,
    section: 'files',
    title: path.slice(path.lastIndexOf('/') + 1),
    subtitle: path,
    fields: [path],
    recencyAt: null,
    order: index,
    icon: 'file',
    titleWeight: FILE_NAME_WEIGHT,
    run: (mode) => open(path, mode === 'split'),
  }));
}
