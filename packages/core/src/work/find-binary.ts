import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ENV_PREFIX, envRaw } from '../names.js';

/**
 * Бинаря нет в PATH. Отдельный класс, чтобы UI мог показать внятный экран вместо
 * стектрейса: без `claude` правая панель работать не может в принципе.
 */
export class BinaryNotFoundError extends Error {
  constructor(readonly binary: string) {
    super(
      `Binary "${binary}" was not found in PATH.\n` +
        `Parley runs only the official, unmodified ${binary} — ` +
        `install it and make sure it is available in PATH.`,
    );
    this.name = 'BinaryNotFoundError';
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ищет исполняемый файл в PATH и возвращает абсолютный путь.
 *
 * Спавним ТОЛЬКО то, что стоит у пользователя в системе (specs/pty.md, юридическая
 * граница проекта): никаких скачиваний, обёрток и подмен.
 */
export async function findBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // Явный путь — проверяем как есть, PATH не при делах.
  if (binary.includes(path.sep)) {
    const resolved = path.resolve(binary);
    if (await isExecutableFile(resolved)) return resolved;
    throw new BinaryNotFoundError(binary);
  }

  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, binary);
    if (await isExecutableFile(candidate)) return candidate;
  }

  throw new BinaryNotFoundError(binary);
}

/** Ключ переменной-оверрайда без префикса: `claude` → `CLAUDE_BIN`. */
const overrideKey = (command: string): string => `${command.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`;

/** Переменная-оверрайд пути к бинарю: `claude` → `PARLEY_CLAUDE_BIN`; прежнее имя `HARNAS_CLAUDE_BIN` читается тоже. */
export function overrideVariable(command: string): string {
  return `${ENV_PREFIX}${overrideKey(command)}`;
}

/**
 * Значение оверрайда бинаря из окружения; `undefined` — подмены нет. Сначала `PARLEY_<КОМАНДА>_BIN`, потом
 * прежнее `HARNAS_<КОМАНДА>_BIN`. Пустая строка — заданное значение («бинаря нет»: так тест отключает
 * провайдера), а не отсутствие подмены.
 */
export function overrideValue(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envRaw(env, overrideKey(command));
}

/**
 * Путь к бинарю раннера. Запускается ровно то, что стоит у пользователя в PATH;
 * переменная-оверрайд нужна нестандартным установкам и тестам, где вместо
 * настоящего агента подставляется stub.
 */
export async function findRunnerBinary(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return findBinary(overrideValue(command, env) ?? command, env);
}
