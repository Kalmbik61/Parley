/**
 * Каталог `drops/` (кусок 5.4, спека 8.5): скриншоты из буфера, которые окно отдаёт агенту
 * путём. Файлы — только для чтения агентом: права 0600, через 7 суток их убирает очистка
 * при старте.
 */

import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { harnasHome } from '@harnas/core';

/** `~/.harnas/desktop/drops` — рядом с `ui.json` и `layouts.json`; `harnasHome()` слушает `HARNAS_HOME`. */
export function dropsDir(home: string = harnasHome()): string {
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
 * PNG из картинки буфера: имя YYYYMMDD-HHMMSS-<4 hex>.png, open(…, 'wx', 0o600). Занятое имя (в том
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
    const file = path.join(dir, `${stamp(now)}-${hex}.png`);
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
 * Старше maxAgeMs — удалить: по lstat только обычные файлы и сами ссылки (цель ссылки цела), каталоги — нет.
 * Возвращает число удалённых. Каталога нет — 0.
 */
export async function cleanupDrops(dir: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
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
