import { chmod, mkdir, open, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Каталог 0700 (и уже существующий приводится к 0700). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
}

export interface AtomicWriteOptions {
  /** Тесты: вызывается между записью временного файла и переименованием. */
  beforeRename?: () => void | Promise<void>;
}

/**
 * Временный файл рядом, 0600, `fsync`, переименование. Сбой на любом шаге
 * оставляет прежний файл целым, временный файл убирается.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const handle = await open(temp, 'wx', FILE_MODE);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, FILE_MODE);
    await options.beforeRename?.();
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // fsync каталога: само переименование должно пережить сбой питания.
  try {
    const dirHandle = await open(path.dirname(file), 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // каталог нельзя синкнуть на части ФС — запись уже на месте
  }
}

export async function writeJsonAtomic(file: string, value: unknown, options?: AtomicWriteOptions): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Читает JSON; нет файла → `undefined`. Битый JSON бросает без содержимого в тексте. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`);
  }
}
