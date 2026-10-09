/**
 * Миниатюры картинок-вложений «Chat» для чипов поля ввода и ленты: main читает файл по пути из окна и
 * отдаёт data-URL. Путь любой — вложения лежат где угодно, не только в корнях работ, — поэтому читаются
 * только картинки по расширению, только обычные файлы и не больше `MAX_DROP_IMAGE_BYTES`. Любой отказ —
 * `null`: окно рисует чип без картинки, а не ошибку.
 *
 * Сторона миниатюры — 320 px; окно может попросить другую (просмотр скриншота из результата инструмента
 * просит 1600), но только целую от 64 до 2048: что бы ни пришло из окна, всё прочее читается как 320.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isImagePath } from '../shared/image-path.js';
import { MAX_DROP_IMAGE_BYTES } from './drops.js';

/** Длинная сторона миниатюры по умолчанию, px: лента показывает 160×120, запас — для экранов 2x. */
const THUMBNAIL_PX = 320;
/** Пределы стороны, которую может попросить окно. */
const MIN_THUMBNAIL_PX = 64;
const MAX_THUMBNAIL_PX = 2048;

/** Часть `NativeImage`, которая здесь нужна. */
export interface ThumbnailImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number }): ThumbnailImage;
  toDataURL(): string;
}

/** Часть модуля `nativeImage` Electron: тест подставляет свою, настоящий Electron ему не нужен. */
export interface ThumbnailDeps {
  createThumbnailFromPath(path: string, size: { width: number; height: number }): Promise<ThumbnailImage>;
  createFromPath(path: string): ThumbnailImage;
}

/** Окну не доверяем: сторона — целое число в пределах, иначе 320. */
function thumbnailSide(requested: unknown): number {
  return typeof requested === 'number' && Number.isInteger(requested) && requested >= MIN_THUMBNAIL_PX && requested <= MAX_THUMBNAIL_PX
    ? requested
    : THUMBNAIL_PX;
}

export async function imageThumbnail(input: unknown, deps: ThumbnailDeps, maxPx?: unknown): Promise<string | null> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || !isImagePath(input)) return null;
  const side = thumbnailSide(maxPx);
  try {
    const info = await stat(input);
    if (!info.isFile() || info.size > MAX_DROP_IMAGE_BYTES) return null;
    let image: ThumbnailImage | null = null;
    try {
      image = await deps.createThumbnailFromPath(input, { width: side, height: side });
    } catch {
      // Системных миниатюр нет (Linux) или файл ими не разобран — читаем сами.
    }
    if (image === null || image.isEmpty()) {
      image = deps.createFromPath(input);
      const { width, height } = image.getSize();
      // Только вниз: мелкую картинку растягивать незачем, а по длинной стороне — чтобы узкая и высокая не вышла огромной.
      if (Math.max(width, height) > side) image = image.resize(width >= height ? { width: side } : { height: side });
    }
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}
