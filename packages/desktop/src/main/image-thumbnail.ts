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
 * Формат определяется по заголовку файла (PNG, JPEG, GIF, WebP), а не по расширению; не картинка по содержимому —
 * `null`. Размер читается оттуда же, до всякого декодирования.
 *
 * Пропорции. Системная миниатюра (`createThumbnailFromPath`) вписывает картинку в названный ящик целиком,
 * растягивая её: на macOS из ящика `side × side` выходит квадрат с искажённой картинкой (так выглядели вложения
 * и скриншоты 16:10). Поэтому PNG и JPEG main читает сам (`createFromPath`) и уменьшает по длинной стороне —
 * вторую сторону Electron считает по пропорциям. GIF и WebP `createFromPath` не читает (пустая картинка), их
 * умеет только система; для неё ящик называется в пропорциях картинки по размеру из заголовка.
 *
 * Бомба. Декодирование PNG и JPEG идёт в процессе main и выделяет ширина × высота × 4 байта, а заголовок мал и
 * врёт дёшево: крошечный файл может объявить 60 000 × 60 000. Поэтому такие картинки читаются только после
 * проверки размера из заголовка: сторона больше 16 384 или больше 50 млн пикселей — `null`, декодирования нет (и для
 * просмотра на 1600 тоже: размер запроса на это не влияет). Не удалось прочесть размер — тоже `null`: что нельзя
 * проверить, не декодируется. GIF и WebP эта проверка не касается: их читает система вне процесса main.
 */

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isImagePath } from '../shared/image-path.js';
import { MAX_DROP_IMAGE_BYTES } from './drops.js';

/** Длинная сторона миниатюры по умолчанию, px: лента показывает 160×120, запас — для экранов 2x. */
const THUMBNAIL_PX = 320;
/** Пределы стороны, которую может попросить окно. */
const MIN_THUMBNAIL_PX = 64;
const MAX_THUMBNAIL_PX = 2048;
/** Сколько байт начала файла хватает, чтобы узнать формат и прочесть размер PNG, GIF и WebP. */
const HEADER_BYTES = 32;
/** Предел PNG и JPEG, которые main декодирует сам: по стороне и по числу пикселей (50 млн — это 200 МБ пикселей RGBA). */
const MAX_DECODE_SIDE_PX = 16384;
const MAX_DECODE_PIXELS = 50_000_000;
/** Сколько сегментов JPEG пройти в поисках кадра: до него идут APPn, DQT, DHT — десятки, а не сотни. */
const MAX_JPEG_SEGMENTS = 256;

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

/** Формат по заголовку и размер, который тот объявляет. */
interface Header {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  size: Size;
}

/** Окну не доверяем: сторона — целое число в пределах, иначе 320. */
function thumbnailSide(requested: unknown): number {
  return typeof requested === 'number' && Number.isInteger(requested) && requested >= MIN_THUMBNAIL_PX && requested <= MAX_THUMBNAIL_PX
    ? requested
    : THUMBNAIL_PX;
}

/** Размер PNG: после подписи идёт блок IHDR — длина (4), «IHDR» (4), ширина (4) и высота (4), старший байт вперёд. */
function pngSize(head: Buffer): Size | null {
  if (head.length < 24 || head[0] !== 0x89 || head.toString('latin1', 1, 4) !== 'PNG' || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
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

/** До `length` байт файла с позиции `position`; короче — файл кончился. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Маркеры кадра JPEG (SOF0–SOF15) — кроме DHT (C4), JPG (C8) и DAC (CC). */
const isFrameMarker = (code: number): boolean => code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;

/**
 * Размер JPEG из первого кадра (SOFn). До него идёт цепочка сегментов `FF код длина…` (APPn с EXIF и профилями цвета, DQT,
 * DHT), поэтому файл идёт по сегментам, перескакивая через каждый целиком, а не читается окном: EXIF и профили сдвигают
 * кадр за 64 КБ. Встроенная в EXIF миниатюра лежит внутри сегмента, пропускается вместе с ним, и её кадр за кадр
 * картинки не сойдёт. Байты-заполнители `FF` перед маркером допустимы. Кадра нет (раньше пошли данные, файл короче,
 * сегментов слишком много) — `null`.
 */
async function jpegSize(handle: FileHandle): Promise<Size | null> {
  let position = 2; // после SOI
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS; segments += 1) {
    const marker = await readAt(handle, position, 4);
    if (marker.length < 4 || marker[0] !== 0xff) return null;
    const code = marker[1] as number;
    if (code === 0xff) {
      position += 1; // заполнитель: настоящий маркер начинается со следующего байта
      continue;
    }
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd8)) {
      position += 2; // маркеры без длины
      continue;
    }
    if (code === 0xd9 || code === 0xda) return null; // конец изображения или данные раньше кадра
    if (isFrameMarker(code)) {
      // После длины (2 байта): точность (1), высота (2) и ширина (2).
      const frame = await readAt(handle, position + 4, 5);
      return frame.length < 5 ? null : { width: frame.readUInt16BE(3), height: frame.readUInt16BE(1) };
    }
    const length = marker.readUInt16BE(2);
    if (length < 2) return null;
    position += 2 + length;
  }
  return null;
}

/**
 * Формат и размер по началу файла; не PNG, JPEG, GIF и не WebP, битый заголовок или нулевая сторона — `null`. Формат
 * решает подпись, а не расширение: файл `x.jpg` с WebP внутри — WebP.
 */
async function readHeader(file: string): Promise<Header | null> {
  const handle = await open(file, 'r');
  try {
    const head = await readAt(handle, 0, HEADER_BYTES);
    let header: Header | null = null;
    const png = pngSize(head);
    const gif = gifSize(head);
    const webp = webpSize(head);
    if (png !== null) header = { format: 'png', size: png };
    else if (gif !== null) header = { format: 'gif', size: gif };
    else if (webp !== null) header = { format: 'webp', size: webp };
    else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      const jpeg = await jpegSize(handle);
      if (jpeg !== null) header = { format: 'jpeg', size: jpeg };
    }
    return header !== null && header.size.width > 0 && header.size.height > 0 ? header : null;
  } finally {
    await handle.close();
  }
}

/** Картинка слишком велика для декодирования в процессе main (по размеру из заголовка). */
const oversized = ({ width, height }: Size): boolean =>
  width > MAX_DECODE_SIDE_PX || height > MAX_DECODE_SIDE_PX || width * height > MAX_DECODE_PIXELS;

/** Ящик в пропорциях картинки, длинной стороной не больше `side`: меньшая картинка остаётся своего размера. */
function boxFor(size: Size, side: number): Size {
  const scale = Math.min(1, side / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** GIF и WebP читает только система. Нет системных миниатюр (Linux) или файл ими не разобран — `null`. */
async function systemThumbnail(file: string, size: Size, side: number, deps: ThumbnailDeps): Promise<ThumbnailImage | null> {
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
    const header = await readHeader(input);
    if (header === null) return null;
    let image: ThumbnailImage | null;
    if (header.format === 'gif' || header.format === 'webp') {
      image = await systemThumbnail(input, header.size, side, deps);
    } else {
      if (oversized(header.size)) return null;
      image = deps.createFromPath(input);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        // Только вниз: мелкую картинку растягивать незачем, а по длинной стороне — чтобы узкая и высокая не вышла огромной.
        if (Math.max(width, height) > side) image = image.resize(width >= height ? { width: side } : { height: side });
      }
    }
    return image === null || image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}
