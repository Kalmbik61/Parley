/**
 * Согласие человека на папку проекта для агентов (спека 2026-10-21, раздел 4.1): `<parleyHome>/trust.json`.
 * Согласие живёт у Parley, а не в `~/.codex`: Parley подставляет его в запуск Codex флагом `projects=…`.
 * Ключ записи — realpath папки, чтобы `/tmp` и `/private/tmp` или путь через символическую ссылку были одной папкой.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from './store.js';

export interface TrustRecord {
  /** Ключ: realpath папки проекта. */
  folder: string;
  /** Когда выдано, ISO-8601. */
  grantedAt: string;
  /** Кто дал согласие: окно, остров или Telegram. */
  by: 'window' | 'island' | 'telegram';
}

export interface TrustFile {
  version: 1;
  folders: Record<string, Omit<TrustRecord, 'folder'>>;
}

const TRUST_BY: readonly string[] = ['window', 'island', 'telegram'];

export function trustFilePath(home: string = parleyHome()): string {
  return path.join(home, 'trust.json');
}

/** Ключ доверия: realpath; папки нет на диске (ENOENT) — просто абсолютный путь. */
export async function trustKey(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(folder);
    throw error;
  }
}

/**
 * Читает файл согласий. Нет файла, нечитаемый, битый JSON или чужая форма — пустой файл: спросить человека
 * ещё раз безопаснее, чем уронить запуск; записи с неверными полями отбрасываются.
 */
export async function readTrust(home: string = parleyHome()): Promise<TrustFile> {
  const empty: TrustFile = { version: 1, folders: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(trustFilePath(home), 'utf8'));
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const { version, folders } = parsed as { version?: unknown; folders?: unknown };
  if (version !== 1 || typeof folders !== 'object' || folders === null || Array.isArray(folders)) return empty;
  for (const [folder, entry] of Object.entries(folders)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { grantedAt, by } = entry as { grantedAt?: unknown; by?: unknown };
    if (typeof grantedAt !== 'string' || typeof by !== 'string' || !TRUST_BY.includes(by)) continue;
    empty.folders[folder] = { grantedAt, by: by as TrustRecord['by'] };
  }
  return empty;
}

/** Временный файл + rename с правами 0600: читатель видит либо старый файл, либо новый (образец — состояние Telegram). */
async function writeTrust(home: string, file: TrustFile): Promise<void> {
  const target = trustFilePath(home);
  await mkdir(home, { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function isTrusted(folder: string, home: string = parleyHome()): Promise<boolean> {
  const key = await trustKey(folder);
  return Object.prototype.hasOwnProperty.call((await readTrust(home)).folders, key);
}

/** Выдаёт согласие на папку (повторная выдача обновляет запись). */
export async function grantTrust(folder: string, by: TrustRecord['by'], home: string = parleyHome()): Promise<TrustRecord> {
  const key = await trustKey(folder);
  const file = await readTrust(home);
  const entry = { grantedAt: new Date().toISOString(), by };
  file.folders[key] = entry;
  await writeTrust(home, file);
  return { folder: key, ...entry };
}

/** Отзывает согласие: `true`, если запись была. Живые сессии не трогаются — отзыв действует на следующий запуск. */
export async function revokeTrust(folder: string, home: string = parleyHome()): Promise<boolean> {
  const key = await trustKey(folder);
  const file = await readTrust(home);
  if (!Object.prototype.hasOwnProperty.call(file.folders, key)) return false;
  delete file.folders[key];
  await writeTrust(home, file);
  return true;
}

export async function listTrust(home: string = parleyHome()): Promise<TrustRecord[]> {
  const file = await readTrust(home);
  return Object.entries(file.folders).map(([folder, entry]) => ({ folder, ...entry }));
}
