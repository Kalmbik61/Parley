/**
 * Каталог `drops/` (кусок 5.4, спека 8.5): скриншоты из буфера, которые окно отдаёт агенту
 * путём. Файлы — только для чтения агентом: права 0600, через 7 суток их убирает очистка
 * при старте.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import { isImagePath } from '../shared/image-path.js';

/** `~/.parley/desktop/drops` — рядом с `ui.json` и `layouts.json`; дом — `parleyHome()` (`PARLEY_HOME`, прежний `HARNAS_HOME`, `~/.parley`, `~/.harnas`). */
export function dropsDir(home: string = parleyHome()): string {
  return path.join(home, 'desktop', 'drops');
}

/**
 * Предел картинки из буфера (раунд fix-main-r1): случайно скопированный огромный скриншот (несколько
 * 5K-мониторов, «Copy image» из редактора со слоями) не пишется на диск молча — окно показывает тост.
 */
export const MAX_DROP_IMAGE_BYTES = 20 * 1024 * 1024;

/** Картинка больше предела; код доезжает до окна через IPC (`withIpcError`). */
export class DropTooLargeError extends Error {
  readonly code = 'drops:too-large';

  constructor(bytes: number) {
    super(`clipboard image is ${bytes} bytes, limit ${MAX_DROP_IMAGE_BYTES}`);
    this.name = 'DropTooLargeError';
  }
}

/** Сколько раз пробуем новое имя, если занято: 65536 имён на секунду — хватит с запасом. */
const MAX_ATTEMPTS = 32;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function stamp(now: Date): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/**
 * PNG из картинки буфера: имя [prefix]YYYYMMDD-HHMMSS-<4 hex>.png, open(…, 'wx', 0o600). Занятое имя (в том
 * числе симлинк) не перезаписывается: EEXIST — новое случайное имя. Пустая картинка → null,
 * больше MAX_DROP_IMAGE_BYTES — DropTooLargeError, файл не пишется.
 *
 * `wx` (O_CREAT|O_EXCL) не идёт по симлинку: подложенная в `drops/` ссылка на чужой файл
 * даёт EEXIST, а не запись в её цель.
 */
export async function saveImage(input: {
  png: Buffer | null;
  dir: string;
  now?: Date;
  random?: () => number;
  /** Начало имени файла: снимки агента лежат с `agent-`, чтобы их убирала своя, частая уборка. */
  prefix?: string;
}): Promise<string | null> {
  const { png, dir } = input;
  if (png === null || png.length === 0) return null;
  if (png.length > MAX_DROP_IMAGE_BYTES) throw new DropTooLargeError(png.length);
  const now = input.now ?? new Date();
  const random = input.random ?? Math.random;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const hex = Math.floor(random() * 0x10000)
      .toString(16)
      .padStart(4, '0')
      .slice(-4);
    const file = path.join(dir, `${input.prefix ?? ''}${stamp(now)}-${hex}.png`);
    let handle;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(png);
    } finally {
      await handle.close();
    }
    return file;
  }
  throw new Error(`no free file name in ${dir}`);
}

/**
 * Внешнее изображение → собственная копия Parley: CLI может не иметь доступа к контейнеру приложения,
 * откуда человек перетащил файл. Байты и формат сохраняются; хеш не даёт повторному добавлению создать дубль.
 */
export async function importDropImage(input: unknown, dir: string = dropsDir()): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || !isImagePath(input)) {
    throw new Error('Expected an absolute image path');
  }
  const source = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size === 0) throw new Error('Expected a non-empty image file');
    if (info.size > MAX_DROP_IMAGE_BYTES) throw new DropTooLargeError(info.size);
    // Ограниченное чтение даже если исходник вырос после stat; короткое чтение не означает конец файла.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await source.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('Image changed while importing; attach it again');
    bytes = buffer.subarray(0, length);
  } finally {
    await source.close();
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(dir, `attachment-${digest}${path.extname(input).toLowerCase()}`);
  // Публикуем только целый файл: два одновременных добавления не увидят недописанную копию.
  const temporary = path.join(dir, `attachment-${randomUUID()}.tmp`);
  const target = await open(temporary, 'wx', 0o600);
  try {
    await target.writeFile(bytes);
    await target.close();
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Повторное вложение: не следуем по ссылке и не возвращаем повреждённую копию.
    const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await existing.stat();
      if (!info.isFile() || info.size !== bytes.length) throw new Error('Invalid attachment copy');
      const buffer = Buffer.alloc(bytes.length);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await existing.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== bytes.length || !buffer.equals(bytes)) throw new Error('Invalid attachment copy');
      await existing.chmod(0o600);
      const now = new Date();
      await existing.utimes(now, now);
    } finally {
      await existing.close();
    }
  } finally {
    await target.close();
    await unlink(temporary);
  }
  return file;
}

/**
 * Старше maxAgeMs — удалить: по lstat только обычные файлы и сами ссылки (цель ссылки цела), каталоги — нет.
 * Возвращает число удалённых. Каталога нет — 0. `accept` — какие имена трогать (по умолчанию все).
 */
export async function cleanupDrops(dir: string, maxAgeMs: number, now: number = Date.now(), accept?: (name: string) => boolean): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (accept !== undefined && !accept(name)) continue;
    const file = path.join(dir, name);
    try {
      // lstat, а не stat: ссылку судим по ней самой и удаляем её, а не цель.
      const info = await lstat(file);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(file);
      removed += 1;
    } catch (error) {
      // Файл исчез между readdir и unlink — не повод бросать очистку остальных.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/** Начало имени снимка агента (`saveImage`, `prefix`) и срок, после которого его убирает почасовая уборка (спека, S8). */
export const AGENT_SHOT_PREFIX = 'agent-';
export const AGENT_SHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Подкаталог файлов-контекстов браузера (спека браузера 3.6): `drops/context/`. */
export const CONTEXT_SUBDIR = 'context';

/** Очистка `drops/` и `drops/context/` — те же правила и тот же срок (спека браузера 3.6). */
export async function cleanupDropsTree(dir: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const top = await cleanupDrops(dir, maxAgeMs, now);
  return top + (await cleanupDrops(path.join(dir, CONTEXT_SUBDIR), maxAgeMs, now));
}
