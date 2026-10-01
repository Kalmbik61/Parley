/**
 * Настройки харнесса: необязательный `config.json` дома (`parleyHome()`), поверх него —
 * переменные окружения `PARLEY_*` (прежние `HARNAS_*` читаются тоже: новое имя главнее).
 *
 * Загрузчик один и живёт в core: настройки читают хост и CLI. Ни один битый
 * файл не должен мешать запуску, поэтому вместо ошибки возвращается пара
 * «дефолты + текст предупреждения».
 *
 * Ключи ушедшего TUI (`prefix`, `sidebarWidth`, `mouseCapture`, `ascii`,
 * `theme`) не читаются: в старом файле они остаются как чужие — загрузчик их
 * молча пропускает, `saveConfig` сохраняет нетронутыми.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WORKTREE_ROOT, envName, envValue } from './names.js';
import { parleyHome } from './work/store.js';

export interface ParleyConfig {
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
  /**
   * Ставить ли скилл `parley` в проект и в worktree сессии при запуске (`work/skill-install.ts`): файлы
   * `.agents/skills/parley` и симлинк `.claude/skills/parley`. Выключено — хост скилл не ставит и не
   * обновляет; уже поставленное не удаляется.
   */
  agentSkills: boolean;
  /** Шрифт панели терминала в окне (кусок 1.10 плана окна). */
  fontFamily: string;
  /** Кегль панели терминала в пунктах: 8…32 (кусок 1.10 плана окна). */
  fontSize: number;
  /**
   * Корень, под которым заводятся worktree сессий: `<root>/<проект>-<хеш6>/…`
   * (спецификация 8.1). Тильда раскрывается там, где путь строится
   * (`plannedWorktree`), — здесь остаётся как есть, чтобы сохранялась в файл
   * настроек переносимой между машинами.
   */
  worktreeRoot: string;
}

export const DEFAULT_CONFIG: Readonly<ParleyConfig> = {
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  resumeRate: 6,
  autoLaunch: true,
  agentSkills: true,
  // Терминал окна (кусок 1.3 плана окна, спека 4.3).
  fontFamily: "'SF Mono', Menlo, monospace",
  fontSize: 14,
  worktreeRoot: DEFAULT_WORKTREE_ROOT,
};

/**
 * Ключ переменной окружения для каждой настройки — без префикса: значение читается как `PARLEY_<ключ>`,
 * а нет его — как прежнее `HARNAS_<ключ>` (`envValue`). Один источник для загрузчика и оверлея.
 */
export const ENV_NAMES: Readonly<Record<keyof ParleyConfig, string>> = {
  silenceThresholdMs: 'SILENCE_MS',
  channelPush: 'CHANNEL_PUSH',
  messageRate: 'MESSAGE_RATE',
  resumeRate: 'RESUME_RATE',
  autoLaunch: 'AUTO_LAUNCH',
  agentSkills: 'AGENT_SKILLS',
  fontFamily: 'FONT_FAMILY',
  fontSize: 'FONT_SIZE',
  worktreeRoot: 'WORKTREE_ROOT',
};

export interface LoadedConfig {
  config: ParleyConfig;
  /** Что не прочиталось. `null` — вопросов к настройкам нет. */
  warning: string | null;
  /** Ключи, чьё значение пришло из окружения: файл их не перекроет. */
  fromEnv: ReadonlyArray<keyof ParleyConfig>;
}

/** Файл настроек. Его может не быть — тогда работают дефолты. */
export function configPath(): string {
  return path.join(parleyHome(), 'config.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Часть настроек: только те поля, которые прочитались без вопросов. */
type ConfigPatch = Partial<ParleyConfig>;

/** Собирает жалобы, чтобы показать их одной строкой: битых полей может быть несколько. */
type Complain = (message: string) => void;

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isFontFamily = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isWorktreeRoot = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Границы кегля — инвариантом по диапазону (правила проверки плана), не одним числом. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const isFontSize = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= FONT_SIZE_MIN &&
  value <= FONT_SIZE_MAX;
const FONT_SIZE_EXPECTED = `an integer from ${FONT_SIZE_MIN} to ${FONT_SIZE_MAX}`;

/** Ноль подъёмов разрешён: так письма никогда не будят спящих, только ждут. */
const RESUME_RATE_MIN = 0;
const RESUME_RATE_MAX = 60;
const isResumeRate = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= RESUME_RATE_MIN &&
  value <= RESUME_RATE_MAX;
const RESUME_RATE_EXPECTED = `an integer from ${RESUME_RATE_MIN} to ${RESUME_RATE_MAX}`;

/** Значения из файла: тут JSON, поэтому типы проверяются как есть. */
function fromFile(data: Record<string, unknown>, complain: Complain): ConfigPatch {
  const patch: ConfigPatch = {};
  const take = <K extends keyof ParleyConfig>(
    key: K,
    ok: (value: unknown) => boolean,
    expected: string,
  ): void => {
    const value = data[key];
    if (value === undefined) return;
    if (!ok(value)) {
      complain(`${key}: expected ${expected}`);
      return;
    }
    patch[key] = value as ParleyConfig[K];
  };

  take('silenceThresholdMs', isPositiveInt, 'a positive integer');
  take('channelPush', (value) => typeof value === 'boolean', 'true or false');
  take('messageRate', isPositiveInt, 'a positive integer');
  take('resumeRate', isResumeRate, RESUME_RATE_EXPECTED);
  take('autoLaunch', (value) => typeof value === 'boolean', 'true or false');
  take('agentSkills', (value) => typeof value === 'boolean', 'true or false');
  take('fontFamily', isFontFamily, 'a non-empty string');
  take('fontSize', isFontSize, FONT_SIZE_EXPECTED);
  take('worktreeRoot', isWorktreeRoot, 'a non-empty string');
  return patch;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Значения из окружения: тут всё строки, поэтому числа и флаги разбираются. */
function fromEnv(env: NodeJS.ProcessEnv, complain: Complain): ConfigPatch {
  const patch: ConfigPatch = {};

  // Пустая переменная — то же самое, что незаданная: так же ведёт себя `PARLEY_HOME` (`envValue`).
  const text = (key: keyof ParleyConfig): string | undefined => envValue(env, ENV_NAMES[key]);
  // Имя, которое назвать человеку: то, под которым значение реально пришло.
  const nameOf = (key: keyof ParleyConfig): string => envName(env, ENV_NAMES[key]) ?? ENV_NAMES[key];

  const flag = (key: 'channelPush' | 'autoLaunch' | 'agentSkills'): void => {
    const value = text(key);
    if (value === undefined) return;
    const lower = value.toLowerCase();
    if (TRUE.has(lower)) patch[key] = true;
    else if (FALSE.has(lower)) patch[key] = false;
    else complain(`${nameOf(key)}: expected 0 or 1`);
  };

  const count = (key: 'silenceThresholdMs' | 'messageRate'): void => {
    const value = text(key);
    if (value === undefined) return;
    const parsed = Number(value);
    if (isPositiveInt(parsed)) patch[key] = parsed;
    else complain(`${nameOf(key)}: expected a positive integer`);
  };

  count('silenceThresholdMs');
  flag('channelPush');
  count('messageRate');
  const resumeRate = text('resumeRate');
  if (resumeRate !== undefined) {
    const parsed = Number(resumeRate);
    if (isResumeRate(parsed)) patch.resumeRate = parsed;
    else complain(`${nameOf('resumeRate')}: expected ${RESUME_RATE_EXPECTED}`);
  }
  flag('autoLaunch');
  flag('agentSkills');

  const fontFamily = text('fontFamily');
  if (fontFamily !== undefined) {
    if (isFontFamily(fontFamily)) patch.fontFamily = fontFamily;
    else complain(`${nameOf('fontFamily')}: expected a non-empty string`);
  }
  const fontSize = text('fontSize');
  if (fontSize !== undefined) {
    const parsed = Number(fontSize);
    if (isFontSize(parsed)) patch.fontSize = parsed;
    else complain(`${nameOf('fontSize')}: expected ${FONT_SIZE_EXPECTED}`);
  }
  const worktreeRoot = text('worktreeRoot');
  if (worktreeRoot !== undefined) {
    if (isWorktreeRoot(worktreeRoot)) patch.worktreeRoot = worktreeRoot;
    else complain(`${nameOf('worktreeRoot')}: expected a non-empty string`);
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
      complain(`${file} cannot be read: ${(error as Error).message}`);
    }
  }

  if (raw !== null) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      data = undefined;
      complain(`${file} cannot be parsed: ${(error as Error).message}`);
    }
    if (data !== undefined) {
      if (isRecord(data)) filePatch = fromFile(data, complain);
      else complain(`${file} cannot be parsed: expected an object`);
    }
  }

  const envPatch = fromEnv(env, complain);

  return {
    config: { ...DEFAULT_CONFIG, ...filePatch, ...envPatch },
    warning: problems.length === 0 ? null : problems.join('; '),
    // Битая переменная ключ не перекрывает, в патч не попадает — и в список тоже.
    fromEnv: Object.keys(envPatch) as ReadonlyArray<keyof ParleyConfig>,
  };
}

/** Булевы ключи настроек — те же множества «да/нет», что у загрузчика окружения. */
const BOOLEAN_KEYS: ReadonlySet<keyof ParleyConfig> = new Set([
  'channelPush',
  'autoLaunch',
  'agentSkills',
]);

/**
 * Разбор введённого значения теми же правилами, что и у файла и у окружения:
 * `settings.set` хоста (кусок 1.4) не должен расходиться с загрузчиком. Раньше
 * понимал только числовые ключи и `prefix` — теперь любой ключ `ParleyConfig`.
 */
export function parseSetting<K extends keyof ParleyConfig>(
  key: K,
  text: string,
): { value: ParleyConfig[K] } | { error: string } {
  if (key === 'fontFamily') {
    if (isFontFamily(text)) return { value: text as ParleyConfig[K] };
    return { error: `${key}: expected a non-empty string` };
  }
  if (key === 'worktreeRoot') {
    if (isWorktreeRoot(text)) return { value: text as ParleyConfig[K] };
    return { error: `${key}: expected a non-empty string` };
  }
  if (key === 'fontSize') {
    const parsed = Number(text);
    if (isFontSize(parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${FONT_SIZE_EXPECTED}` };
  }
  if (key === 'resumeRate') {
    // Отдельная ветка: общая для чисел отвергла бы допустимый ноль.
    const parsed = Number(text);
    if (isResumeRate(parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${RESUME_RATE_EXPECTED}` };
  }
  if (BOOLEAN_KEYS.has(key)) {
    const lower = text.toLowerCase();
    if (TRUE.has(lower)) return { value: true as ParleyConfig[K] };
    if (FALSE.has(lower)) return { value: false as ParleyConfig[K] };
    return { error: `${key}: expected 0 or 1` };
  }
  const parsed = Number(text);
  if (isPositiveInt(parsed)) return { value: parsed as ParleyConfig[K] };
  return { error: `${key}: expected a positive integer` };
}

/**
 * Пишет часть настроек в файл, сохраняя чужие ключи. Каталог создаёт. Битый файл
 * перезаписывается целиком: пользователь правит настройку, а не чинит JSON.
 */
export async function saveConfig(
  patch: Partial<ParleyConfig>,
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
