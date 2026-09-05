/**
 * Настройки харнесса: необязательный `HARNAS_HOME/config.json`, поверх него —
 * переменные окружения `HARNAS_*` (дизайн TUI v2, раздел 3.4).
 *
 * Загрузчик один и живёт в core: настройки читает и TUI, и CLI. Ни один битый
 * файл не должен мешать запуску, поэтому вместо ошибки возвращается пара
 * «дефолты + текст предупреждения», которое строка статуса покажет как `⚑`
 * (раздел 10). `HARNAS_ESCAPE_KEY` больше не читается: его заменил `prefix`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { harnasHome } from './work/store.js';

export interface HarnasConfig {
  /** Буква префикса: `q` значит `Ctrl+Q` (раздел 3.1). */
  prefix: string;
  sidebarWidth: number;
  /** Ловит ли харнесс мышь сам; выключенная мышь остаётся у гостя (3.3). */
  mouseCapture: boolean;
  /** Запасной набор глифов вместо Unicode (раздел 7). */
  ascii: boolean;
  /** Порог молчания лога для страховочной `activity` (раздел 4.3). */
  silenceThresholdMs: number;
}

export const DEFAULT_CONFIG: Readonly<HarnasConfig> = {
  prefix: 'q',
  sidebarWidth: 26,
  mouseCapture: true,
  ascii: false,
  silenceThresholdMs: 30_000,
};

export interface LoadedConfig {
  config: HarnasConfig;
  /** Что не прочиталось. `null` — вопросов к настройкам нет. */
  warning: string | null;
}

/** Файл настроек. Его может не быть — тогда работают дефолты. */
export function configPath(): string {
  return path.join(harnasHome(), 'config.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Часть настроек: только те поля, которые прочитались без вопросов. */
type ConfigPatch = Partial<HarnasConfig>;

/** Собирает жалобы, чтобы показать их одной строкой: битых полей может быть несколько. */
type Complain = (message: string) => void;

const isPrefix = (value: unknown): value is string =>
  typeof value === 'string' && [...value].length === 1;

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Значения из файла: тут JSON, поэтому типы проверяются как есть. */
function fromFile(data: Record<string, unknown>, complain: Complain): ConfigPatch {
  const patch: ConfigPatch = {};
  const take = <K extends keyof HarnasConfig>(
    key: K,
    ok: (value: unknown) => boolean,
    expected: string,
  ): void => {
    const value = data[key];
    if (value === undefined) return;
    if (!ok(value)) {
      complain(`${key}: ожидается ${expected}`);
      return;
    }
    patch[key] = value as HarnasConfig[K];
  };

  take('prefix', isPrefix, 'один знак');
  take('sidebarWidth', isPositiveInt, 'целое больше нуля');
  take('mouseCapture', (value) => typeof value === 'boolean', 'true или false');
  take('ascii', (value) => typeof value === 'boolean', 'true или false');
  take('silenceThresholdMs', isPositiveInt, 'целое больше нуля');
  return patch;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Значения из окружения: тут всё строки, поэтому числа и флаги разбираются. */
function fromEnv(env: NodeJS.ProcessEnv, complain: Complain): ConfigPatch {
  const patch: ConfigPatch = {};

  const text = (name: string): string | undefined => {
    const value = env[name];
    // Пустая переменная — то же самое, что незаданная: так же ведёт себя HARNAS_HOME.
    return value === undefined || value === '' ? undefined : value;
  };

  const flag = (name: string, key: 'mouseCapture' | 'ascii'): void => {
    const value = text(name);
    if (value === undefined) return;
    const lower = value.toLowerCase();
    if (TRUE.has(lower)) patch[key] = true;
    else if (FALSE.has(lower)) patch[key] = false;
    else complain(`${name}: ожидается 0 или 1`);
  };

  const count = (name: string, key: 'sidebarWidth' | 'silenceThresholdMs'): void => {
    const value = text(name);
    if (value === undefined) return;
    const parsed = Number(value);
    if (isPositiveInt(parsed)) patch[key] = parsed;
    else complain(`${name}: ожидается целое больше нуля`);
  };

  const prefix = text('HARNAS_PREFIX');
  if (prefix !== undefined) {
    if (isPrefix(prefix)) patch.prefix = prefix;
    else complain('HARNAS_PREFIX: ожидается один знак');
  }
  count('HARNAS_SIDEBAR_WIDTH', 'sidebarWidth');
  flag('HARNAS_MOUSE', 'mouseCapture');
  flag('HARNAS_ASCII', 'ascii');
  count('HARNAS_SILENCE_MS', 'silenceThresholdMs');
  return patch;
}

/**
 * Настройки: дефолты, поверх — файл, поверх — окружение. Битый файл или битое
 * значение не отменяют остальные: непонятое поле остаётся дефолтным, а причина
 * уезжает в `warning`.
 */
export async function loadConfig(
  file: string = configPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const problems: string[] = [];
  const complain: Complain = (message) => problems.push(message);

  let filePatch: ConfigPatch = {};
  let raw: string | null = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // Файла нет — это норма: настройки необязательные.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      complain(`${file} не читается: ${(error as Error).message}`);
    }
  }

  if (raw !== null) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      data = undefined;
      complain(`${file} не парсится: ${(error as Error).message}`);
    }
    if (data !== undefined) {
      if (isRecord(data)) filePatch = fromFile(data, complain);
      else complain(`${file} не парсится: ожидается объект`);
    }
  }

  return {
    config: { ...DEFAULT_CONFIG, ...filePatch, ...fromEnv(env, complain) },
    warning: problems.length === 0 ? null : problems.join('; '),
  };
}
