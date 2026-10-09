/**
 * Миниатюры картинок-вложений «Chat» для чипов поля ввода и ленты: main читает файл по пути из окна и
 * отдаёт data-URL. Путь любой — вложения лежат где угодно, не только в корнях работ, — поэтому читаются
 * только картинки по расширению, только обычные файлы и не больше `MAX_DROP_IMAGE_BYTES`. Любой отказ —
 * `null`: окно рисует чип без картинки, а не ошибку.
 *
 * Сторона миниатюры — 320 px; окно может попросить другую (просмотр скриншота из результата инструмента
 * просит 1600), но только целую от 64 до 2048: что бы ни пришло из окна, всё прочее читается как 320. Это
 * длинная сторона: пропорции картинки сохраняются, а меньшая картинка не растягивается.
 *
 * Пропорции. Системная миниатюра (`createThumbnailFromPath`) вписывает картинку в названный ящик целиком,
 * растягивая её: на macOS из ящика `side × side` выходит квадрат с искажённой картинкой (так выглядели вложения
 * и скриншоты 16:10). Поэтому PNG и JPEG main читает сам (`createFromPath`) и уменьшает по длинной стороне —
 * вторую сторону Electron считает по пропорциям. GIF и WebP `createFromPath` не читает (пустая картинка), их
 * умеет только система; для неё размер берётся из заголовка файла и ящик называется в пропорциях картинки.
 */

import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { isImagePath } from '../shared/image-path.js';
import { MAX_DROP_IMAGE_BYTES } from './drops.js';

/** Длинная сторона миниатюры по умолчанию, px: лента показывает 160×120, запас — для экранов 2x. */
const THUMBNAIL_PX = 320;
/** Пределы стороны, которую может попросить окно. */
const MIN_THUMBNAIL_PX = 64;
const MAX_THUMBNAIL_PX = 2048;
/** Сколько байт начала файла хватает, чтобы прочесть размер GIF и WebP. */
const HEADER_BYTES = 32;

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

interface Size {
  width: number;
  height: number;
}

/** Окну не доверяем: сторона — целое число в пределах, иначе 320. */
function thumbnailSide(requested: unknown): number {
  return typeof requested === 'number' && Number.isInteger(requested) && requested >= MIN_THUMBNAIL_PX && requested <= MAX_THUMBNAIL_PX
    ? requested
    : THUMBNAIL_PX;
}

/** Размер GIF: логический экран после подписи `GIF8…`, по 16 бит на сторону, младший байт вперёд. */
function gifSize(head: Buffer): Size | null {
  if (head.length < 10 || head.toString('ascii', 0, 4) !== 'GIF8') return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

/** Размер WebP по первому блоку после `RIFF…WEBP`: `VP8 ` (с потерями), `VP8L` (без потерь) или `VP8X` (расширенный). */
function webpSize(head: Buffer): Size | null {
  if (head.length < 30 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') return null;
  switch (head.toString('ascii', 12, 16)) {
    case 'VP8 ':
      // Тег кадра (3 байта), код старта 9D 01 2A, затем по 14 бит на сторону: старшие два бита слова — масштаб, не размер.
      return head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a
        ? { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
        : null;
    case 'VP8L': {
      // Подпись 0x2F, затем 14 бит «ширина − 1» и 14 бит «высота − 1».
      if (head[20] !== 0x2f) return null;
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      // Холст: по 24 бита на «ширина − 1» и «высота − 1».
      return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** Размер GIF или WebP по началу файла; другой формат, битый заголовок или нулевая сторона — `null`. */
async function headerSize(file: string): Promise<Size | null> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0);
    const size = gifSize(head.subarray(0, bytesRead)) ?? webpSize(head.subarray(0, bytesRead));
    return size !== null && size.width > 0 && size.height > 0 ? size : null;
  } finally {
    await handle.close();
  }
}

/** Ящик в пропорциях картинки, длинной стороной не больше `side`: меньшая картинка остаётся своего размера. */
function boxFor(size: Size, side: number): Size {
  const scale = Math.min(1, side / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** GIF и WebP читает только система. Нет системных миниатюр (Linux) или файл ими не разобран — `null`. */
async function systemThumbnail(file: string, side: number, deps: ThumbnailDeps): Promise<ThumbnailImage | null> {
  const size = await headerSize(file);
  if (size === null) return null;
  try {
    return await deps.createThumbnailFromPath(file, boxFor(size, side));
  } catch {
    return null;
  }
}

export async function imageThumbnail(input: unknown, deps: ThumbnailDeps, maxPx?: unknown): Promise<string | null> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || !isImagePath(input)) return null;
  const side = thumbnailSide(maxPx);
  try {
    const info = await stat(input);
    if (!info.isFile() || info.size > MAX_DROP_IMAGE_BYTES) return null;
    let image: ThumbnailImage | null = deps.createFromPath(input);
    if (image.isEmpty()) {
      image = await systemThumbnail(input, side, deps);
    } else {
      const { width, height } = image.getSize();
      // Только вниз: мелкую картинку растягивать незачем, а по длинной стороне — чтобы узкая и высокая не вышла огромной.
      if (Math.max(width, height) > side) image = image.resize(width >= height ? { width: side } : { height: side });
    }
    return image === null || image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}
