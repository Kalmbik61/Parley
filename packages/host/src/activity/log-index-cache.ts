import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionIndex } from '@parley/core';

/**
 * Кэш индекса логов между запусками хоста. Файл читается как недоверенный: чужой формат, чужая версия
 * хоста, оборванный или битый JSON, запись неожиданной формы — всё это пустая карта и полный разбор.
 */
export const LOG_INDEX_CACHE_FORMAT = 1;
export const LOG_INDEX_CACHE_FILE = 'log-index-cache.json';

/** Потолок размера файла кэша: больше не читаем и не пишем (оценка — 5–25 МБ на 5 000 файлов). */
export const LOG_INDEX_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export interface LogIndexCacheEntry {
  key: string;
  index: SessionIndex;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Форма, без которой потребители индекса упали бы: строки id и файла, провайдер, объект. */
function isIndexOf(file: string, value: unknown): value is SessionIndex {
  return (
    isObject(value) &&
    value['file'] === file &&
    typeof value['id'] === 'string' &&
    (value['provider'] === 'claude' || value['provider'] === 'codex')
  );
}

/** Любой сбой (нет файла, не читается, чужой формат или версия) — пустая карта. */
export async function loadLogIndexCache(file: string, version: string): Promise<Map<string, LogIndexCacheEntry>> {
  const entries = new Map<string, LogIndexCacheEntry>();
  try {
    if ((await stat(file)).size > LOG_INDEX_CACHE_MAX_BYTES) return entries;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isObject(parsed) || parsed['format'] !== LOG_INDEX_CACHE_FORMAT || parsed['version'] !== version) return entries;
    const stored = parsed['entries'];
    if (!isObject(stored)) return entries;
    for (const [logFile, entry] of Object.entries(stored)) {
      if (!isObject(entry) || typeof entry['key'] !== 'string' || !isIndexOf(logFile, entry['index'])) continue;
      entries.set(logFile, { key: entry['key'], index: entry['index'] });
    }
    return entries;
  } catch {
    return new Map();
  }
}

/** Временный файл рядом с 0600 и `rename`: читатель видит либо прежний файл, либо новый целиком. */
export async function saveLogIndexCache(
  file: string,
  version: string,
  entries: ReadonlyMap<string, LogIndexCacheEntry>,
): Promise<void> {
  const text = JSON.stringify({ format: LOG_INDEX_CACHE_FORMAT, version, entries: Object.fromEntries(entries) });
  if (Buffer.byteLength(text) > LOG_INDEX_CACHE_MAX_BYTES) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
