/** Единственный секрет Parley — ключ Z.ai, который человек вставил сам. */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from './work/store.js';

export type SecretId = 'zai';

/** Ошибка формата никогда не содержит введённый ключ. */
export class SecretFormatError extends Error {
  constructor() {
    super('Key must contain 1–512 characters without spaces or control characters');
    this.name = 'SecretFormatError';
  }
}

/** Краевые пробелы от вставки разрешены; внутри ключа — нет. */
export function normalizeSecret(raw: string): string {
  const key = raw.trim();
  if (!key || key.length > 512 || /[\s\p{Cc}\p{Cf}]/u.test(key)) throw new SecretFormatError();
  return key;
}

/** Только эту подсказку хост отдаёт окну; короткий ключ целиком скрыт. */
export function secretHint(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const secretsPath = (): string => path.join(parleyHome(), 'secrets.json');

/** Повреждённый JSON не даёт ключа; ошибки доступа к диску остаются ошибками. */
async function readStore(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

/** Ключ для запуска GLM и хостового запроса квоты Z.ai; окно получает только `secretHint`. */
export async function readSecret(id: SecretId): Promise<string | null> {
  const entry = (await readStore(secretsPath()))[id];
  if (!isRecord(entry) || typeof entry.key !== 'string') return null;
  try {
    return normalizeSecret(entry.key);
  } catch {
    return null;
  }
}

/** Новый файл получает свои 0600 даже при замене старого файла с широкими правами. */
async function writeStore(file: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Сохраняет введённый ключ атомарно и возвращает только подсказку. */
export async function writeSecret(id: SecretId, raw: string): Promise<string> {
  const key = normalizeSecret(raw);
  const file = secretsPath();
  const data = await readStore(file);
  data[id] = { ...(isRecord(data[id]) ? data[id] : {}), key };
  await writeStore(file, data);
  return secretHint(key);
}

/** Чужие поля остаются; пустой файл после удаления ключа больше не нужен. */
export async function clearSecret(id: SecretId): Promise<void> {
  const file = secretsPath();
  const data = await readStore(file);
  const hadSecret = Object.hasOwn(data, id);
  delete data[id];
  if (Object.keys(data).length === 0) {
    await rm(file, { force: true });
  } else if (hadSecret) {
    await writeStore(file, data);
  }
}
