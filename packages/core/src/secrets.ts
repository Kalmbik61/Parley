/** Единственный секрет Parley — ключ Z.ai, который человек вставил сам. */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from './work/store.js';

export type SecretId = 'zai' | `custom:${string}`;

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

/** Очередь внутри процесса: в файле теперь несколько ключей (`zai`, `custom:*`), записи «прочитал-изменил-записал» не должны перемежаться. */
let writeQueue: Promise<unknown> = Promise.resolve();
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 15_000;

/** Замок для нескольких процессов: файл рядом с секретами, создаётся с `wx`; брошенный замок старше `LOCK_STALE_MS` снимается. */
async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, 'wx', 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('Secret store is busy');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lock, { force: true });
  }
}

function serializedWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(
    () => withFileLock(secretsPath(), task),
    () => withFileLock(secretsPath(), task),
  );
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Сохраняет введённый ключ атомарно и возвращает только подсказку. */
export async function writeSecret(id: SecretId, raw: string): Promise<string> {
  const key = normalizeSecret(raw);
  return serializedWrite(async () => {
    const file = secretsPath();
    const data = await readStore(file);
    data[id] = { ...(isRecord(data[id]) ? data[id] : {}), key };
    await writeStore(file, data);
    return secretHint(key);
  });
}

/** Чужие поля остаются; пустой файл после удаления ключа больше не нужен. */
export async function clearSecret(id: SecretId): Promise<void> {
  // Нет файла — нечего убирать, и замок не должен создавать дом Parley.
  if ((await stat(secretsPath()).catch(() => null)) === null) return;
  await serializedWrite(async () => {
    const file = secretsPath();
    const data = await readStore(file);
    const hadSecret = Object.hasOwn(data, id);
    delete data[id];
    if (Object.keys(data).length === 0) {
      await rm(file, { force: true });
    } else if (hadSecret) {
      await writeStore(file, data);
    }
  });
}

/** Id своих провайдеров, под которыми в файле лежит ключ: id нового провайдера не должен совпасть с забытым ключом. */
export async function listCustomSecretIds(): Promise<string[]> {
  return Object.keys(await readStore(secretsPath()))
    .filter((name) => name.startsWith('custom:'))
    .map((name) => name.slice('custom:'.length));
}
