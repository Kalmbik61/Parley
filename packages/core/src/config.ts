/**
 * Настройки харнесса: необязательный `HARNAS_HOME/config.json`, поверх него —
 * переменные окружения `HARNAS_*` (дизайн TUI v2, раздел 3.4).
 *
 * Загрузчик один и живёт в core: настройки читает и TUI, и CLI. Ни один битый
 * файл не должен мешать запуску, поэтому вместо ошибки возвращается пара
 * «дефолты + текст предупреждения», которое строка статуса покажет как `⚑`
 * (раздел 10). `HARNAS_ESCAPE_KEY` больше не читается: его заменил `prefix`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  /**
   * Будить ли адресата звонком через channel; без него письма живут по pull
   * (разговор агентов, 4.4). Выключается и пробой версии `claude`.
   */
  channelPush: boolean;
  /**
   * Потолок писем одной сессии за скользящий час: защита от переписки двух
   * вежливых агентов до конца лимита подписки (разговор агентов, 4.7).
   */
  messageRate: number;
  /**
   * Потолок подъёмов одной спящей сессии письмами за скользящий час: сверх него
   * письма ждут, а не жгут подписку за ночь (спецификация окна 7.4). 0…60.
   */
  resumeRate: number;
  /** Запускать ли `pending` от агента самим, в фоне, без диалога (раздел 5.2). */
  autoLaunch: boolean;
  /** Имя темы: пять палитр плюс `terminal` (дизайн темы `2026-09-22-tui-theme-design.md`, раздел 6). */
  theme: string;
  /** Шрифт панели терминала в окне (кусок 1.10 плана окна). */
  fontFamily: string;
  /** Кегль панели терминала в пунктах: 8…32 (кусок 1.10 плана окна). */
  fontSize: number;
}

/** Шесть имён тем: пять палитр плюс явный отказ от них (дизайн темы, раздел 3.3). */
export const THEME_NAMES = ['mocha', 'latte', 'gruvbox', 'nord', 'tokyo-night', 'terminal'] as const;

export const DEFAULT_CONFIG: Readonly<HarnasConfig> = {
  prefix: 'q',
  sidebarWidth: 26,
  mouseCapture: true,
  ascii: false,
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  resumeRate: 6,
  autoLaunch: true,
  theme: 'mocha',
  fontFamily: 'Menlo',
  fontSize: 13,
};

/** Имя переменной окружения для каждого ключа — один источник для загрузчика и оверлея. */
export const ENV_NAMES: Readonly<Record<keyof HarnasConfig, string>> = {
  prefix: 'HARNAS_PREFIX',
  sidebarWidth: 'HARNAS_SIDEBAR_WIDTH',
  mouseCapture: 'HARNAS_MOUSE',
  ascii: 'HARNAS_ASCII',
  silenceThresholdMs: 'HARNAS_SILENCE_MS',
  channelPush: 'HARNAS_CHANNEL_PUSH',
  messageRate: 'HARNAS_MESSAGE_RATE',
  resumeRate: 'HARNAS_RESUME_RATE',
  autoLaunch: 'HARNAS_AUTO_LAUNCH',
  theme: 'HARNAS_THEME',
  fontFamily: 'HARNAS_FONT_FAMILY',
  fontSize: 'HARNAS_FONT_SIZE',
};

export interface LoadedConfig {
  config: HarnasConfig;
  /** Что не прочиталось. `null` — вопросов к настройкам нет. */
  warning: string | null;
  /** Ключи, чьё значение пришло из окружения: файл их не перекроет. */
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
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

const isThemeName = (value: unknown): value is string =>
  typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
const THEME_EXPECTED = `одно из ${THEME_NAMES.join(', ')}`;

const isFontFamily = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Границы кегля — инвариантом по диапазону (правила проверки плана), не одним числом. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const isFontSize = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= FONT_SIZE_MIN &&
  value <= FONT_SIZE_MAX;
const FONT_SIZE_EXPECTED = `целое от ${FONT_SIZE_MIN} до ${FONT_SIZE_MAX}`;

/** Ноль подъёмов разрешён: так письма никогда не будят спящих, только ждут. */
const RESUME_RATE_MIN = 0;
const RESUME_RATE_MAX = 60;
const isResumeRate = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= RESUME_RATE_MIN &&
  value <= RESUME_RATE_MAX;
const RESUME_RATE_EXPECTED = `целое от ${RESUME_RATE_MIN} до ${RESUME_RATE_MAX}`;

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
  take('channelPush', (value) => typeof value === 'boolean', 'true или false');
  take('messageRate', isPositiveInt, 'целое больше нуля');
  take('resumeRate', isResumeRate, RESUME_RATE_EXPECTED);
  take('autoLaunch', (value) => typeof value === 'boolean', 'true или false');
  take('theme', isThemeName, THEME_EXPECTED);
  take('fontFamily', isFontFamily, 'непустая строка');
  take('fontSize', isFontSize, FONT_SIZE_EXPECTED);
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

  const flag = (key: 'mouseCapture' | 'ascii' | 'channelPush' | 'autoLaunch'): void => {
    const name = ENV_NAMES[key];
    const value = text(name);
    if (value === undefined) return;
    const lower = value.toLowerCase();
    if (TRUE.has(lower)) patch[key] = true;
    else if (FALSE.has(lower)) patch[key] = false;
    else complain(`${name}: ожидается 0 или 1`);
  };

  const count = (key: 'sidebarWidth' | 'silenceThresholdMs' | 'messageRate'): void => {
    const name = ENV_NAMES[key];
    const value = text(name);
    if (value === undefined) return;
    const parsed = Number(value);
    if (isPositiveInt(parsed)) patch[key] = parsed;
    else complain(`${name}: ожидается целое больше нуля`);
  };

  const prefix = text(ENV_NAMES.prefix);
  if (prefix !== undefined) {
    if (isPrefix(prefix)) patch.prefix = prefix;
    else complain(`${ENV_NAMES.prefix}: ожидается один знак`);
  }
  const theme = text(ENV_NAMES.theme);
  if (theme !== undefined) {
    if (isThemeName(theme)) patch.theme = theme;
    else complain(`${ENV_NAMES.theme}: ожидается ${THEME_EXPECTED}`);
  }
  count('sidebarWidth');
  flag('mouseCapture');
  flag('ascii');
  count('silenceThresholdMs');
  flag('channelPush');
  count('messageRate');
  const resumeRate = text(ENV_NAMES.resumeRate);
  if (resumeRate !== undefined) {
    const parsed = Number(resumeRate);
    if (isResumeRate(parsed)) patch.resumeRate = parsed;
    else complain(`${ENV_NAMES.resumeRate}: ожидается ${RESUME_RATE_EXPECTED}`);
  }
  flag('autoLaunch');

  const fontFamily = text(ENV_NAMES.fontFamily);
  if (fontFamily !== undefined) {
    if (isFontFamily(fontFamily)) patch.fontFamily = fontFamily;
    else complain(`${ENV_NAMES.fontFamily}: ожидается непустая строка`);
  }
  const fontSize = text(ENV_NAMES.fontSize);
  if (fontSize !== undefined) {
    const parsed = Number(fontSize);
    if (isFontSize(parsed)) patch.fontSize = parsed;
    else complain(`${ENV_NAMES.fontSize}: ожидается ${FONT_SIZE_EXPECTED}`);
  }
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

  const envPatch = fromEnv(env, complain);

  return {
    config: { ...DEFAULT_CONFIG, ...filePatch, ...envPatch },
    warning: problems.length === 0 ? null : problems.join('; '),
    // Битая переменная ключ не перекрывает, в патч не попадает — и в список тоже.
    fromEnv: Object.keys(envPatch) as ReadonlyArray<keyof HarnasConfig>,
  };
}

/** Ключи, значение которых вводится текстом; булевы переключаются без ввода. */
export type TypedSettingKey = 'prefix' | 'sidebarWidth' | 'silenceThresholdMs' | 'messageRate';

/** Булевы ключи настроек — те же множества «да/нет», что у загрузчика окружения. */
const BOOLEAN_KEYS: ReadonlySet<keyof HarnasConfig> = new Set([
  'mouseCapture',
  'ascii',
  'channelPush',
  'autoLaunch',
]);

/**
 * Разбор введённого значения теми же правилами, что и у файла и у окружения:
 * `settings.set` хоста (кусок 1.4) не должен расходиться с загрузчиком. Раньше
 * понимал только числовые ключи и `prefix` — теперь любой ключ `HarnasConfig`.
 */
export function parseSetting<K extends keyof HarnasConfig>(
  key: K,
  text: string,
): { value: HarnasConfig[K] } | { error: string } {
  if (key === 'prefix') {
    if (isPrefix(text)) return { value: text as HarnasConfig[K] };
    return { error: `${key}: ожидается один знак` };
  }
  if (key === 'theme') {
    if (isThemeName(text)) return { value: text as HarnasConfig[K] };
    return { error: `${key}: ожидается ${THEME_EXPECTED}` };
  }
  if (key === 'fontFamily') {
    if (isFontFamily(text)) return { value: text as HarnasConfig[K] };
    return { error: `${key}: ожидается непустая строка` };
  }
  if (key === 'fontSize') {
    const parsed = Number(text);
    if (isFontSize(parsed)) return { value: parsed as HarnasConfig[K] };
    return { error: `${key}: ожидается ${FONT_SIZE_EXPECTED}` };
  }
  if (key === 'resumeRate') {
    // Отдельная ветка: общая для чисел отвергла бы допустимый ноль.
    const parsed = Number(text);
    if (isResumeRate(parsed)) return { value: parsed as HarnasConfig[K] };
    return { error: `${key}: ожидается ${RESUME_RATE_EXPECTED}` };
  }
  if (BOOLEAN_KEYS.has(key)) {
    const lower = text.toLowerCase();
    if (TRUE.has(lower)) return { value: true as HarnasConfig[K] };
    if (FALSE.has(lower)) return { value: false as HarnasConfig[K] };
    return { error: `${key}: ожидается 0 или 1` };
  }
  const parsed = Number(text);
  if (isPositiveInt(parsed)) return { value: parsed as HarnasConfig[K] };
  return { error: `${key}: ожидается целое больше нуля` };
}

/**
 * Пишет часть настроек в файл, сохраняя чужие ключи. Каталог создаёт. Битый файл
 * перезаписывается целиком: пользователь правит настройку, а не чинит JSON.
 */
export async function saveConfig(
  patch: Partial<HarnasConfig>,
  file: string = configPath(),
): Promise<void> {
  let kept: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isRecord(data)) kept = data;
  } catch {
    // Файла нет, он не читается или не парсится — пишем с нуля.
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...kept, ...patch }, null, 2)}\n`, 'utf8');
}
