/**
 * Согласие человека на папку проекта для агентов (спека 2026-10-21, раздел 4.1): `<parleyHome>/trust.json`.
 * Согласие живёт у Parley, а не в `~/.codex`: Parley подставляет его в запуск Codex флагом `projects=…`.
 * Ключ записи — realpath папки, чтобы `/tmp` и `/private/tmp` или путь через символическую ссылку были одной папкой.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from './store.js';
import {
  claudeStateFile,
  markClaudeFolderTrust,
  serialClaudeTrust,
  withdrawClaudeTrustMarks,
  type ClaudeTrustOptions,
  type ClaudeTrustOutcome,
} from './claude-trust.js';

export interface TrustRecord {
  /** Ключ: realpath папки проекта. */
  folder: string;
  /** Когда выдано, ISO-8601. */
  grantedAt: string;
  /** Кто дал согласие: окно, остров, Telegram или телефон. */
  by: 'window' | 'island' | 'telegram' | 'phone';
}

export interface TrustFile {
  version: 1;
  folders: Record<string, Omit<TrustRecord, 'folder'>>;
}

const TRUST_BY: readonly string[] = ['window', 'island', 'telegram', 'phone'];

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

/**
 * Отзывает согласие: `true`, если запись была. Живые сессии не трогаются — отзыв действует на следующий запуск.
 * Отметку принятия, которую Parley поставил этой папке в файлах Claude Code (`syncClaudeTrust`), отзыв снимает; занятый
 * файл не роняет отзыв — отметка снимется при следующем запуске Claude. Отметку человека из самого CLI не трогаем.
 */
export async function revokeTrust(folder: string, home: string = parleyHome()): Promise<boolean> {
  const key = await trustKey(folder);
  return serialClaudeTrust(async () => {
    const file = await readTrust(home);
    const had = Object.prototype.hasOwnProperty.call(file.folders, key);
    if (had) {
      delete file.folders[key];
      await writeTrust(home, file);
    }
    await withdrawClaudeTrustMarks(home, (mark) => mark.folder === key).catch(() => undefined);
    return had;
  });
}

/**
 * Перед запуском провайдера семейства Claude Code (спека мобильного приложения, 4.2; план A29): папка проекта с записью
 * в `trust.json` отмечается принятой в файле состояния профиля (`profile.configDir` — его `CLAUDE_CONFIG_DIR`,
 * `profile.home` — домашняя папка процесса), и отметка записывается как своя. Свои отметки уже отозванных папок, не
 * снятые при отзыве, снимаются здесь же. Без записи доверия и без своих отметок файл Claude не читается. Ошибка не
 * бросается: строки для лога — без содержимого файлов.
 */
export async function syncClaudeTrust(
  projectPath: string,
  profile: { configDir: string | undefined; home: string },
  home: string = parleyHome(),
  options: ClaudeTrustOptions = {},
): Promise<{ outcome: ClaudeTrustOutcome | 'not-trusted' | 'failed'; warnings: string[] }> {
  return serialClaudeTrust(async () => {
    const warnings: string[] = [];
    try {
      const { folders } = await readTrust(home);
      const trusted = (folder: string): boolean => Object.prototype.hasOwnProperty.call(folders, folder);
      warnings.push(...(await withdrawClaudeTrustMarks(home, (mark) => !trusted(mark.folder), options)));
      const folder = await trustKey(projectPath);
      if (!trusted(folder)) return { outcome: 'not-trusted', warnings };
      const file = await claudeStateFile(profile.configDir, profile.home);
      const outcome = await markClaudeFolderTrust(home, file, folder, options);
      if (outcome !== 'written' && outcome !== 'present') {
        warnings.push(`Parley could not mark ${folder} as trusted in ${file} (${outcome}); Claude Code may ask to trust the folder in the terminal.`);
      }
      return { outcome, warnings };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      warnings.push(`Parley could not mark the project folder as trusted for Claude Code (${code}); Claude Code may ask to trust the folder in the terminal.`);
      return { outcome: 'failed', warnings };
    }
  });
}

export async function listTrust(home: string = parleyHome()): Promise<TrustRecord[]> {
  const file = await readTrust(home);
  return Object.entries(file.folders).map(([folder, entry]) => ({ folder, ...entry }));
}
