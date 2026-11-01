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
import {
  DEFAULT_RESOURCE_LIMITS,
  RESOURCE_LIMIT_BOUNDS,
  RESOURCE_LIMIT_KEYS,
  type ResourceLimits,
} from './work/resource-policy.js';
import { parleyHome } from './work/store.js';

/**
 * Как решаются одобрения пишущих ролей Codex (спека 2026-10-21, 5.2): `auto` — авторевьюер самого Codex, `parley` — хуки
 * Parley и карточки в окне, на острове и в Telegram, `terminal` — человек отвечает в терминале сессии.
 */
export type CodexWriteApprovals = 'auto' | 'parley' | 'terminal';

export const CODEX_WRITE_APPROVALS_VALUES: readonly CodexWriteApprovals[] = ['auto', 'parley', 'terminal'];

const isCodexWriteApprovals = (value: unknown): value is CodexWriteApprovals =>
  (CODEX_WRITE_APPROVALS_VALUES as readonly unknown[]).includes(value);

const CODEX_WRITE_APPROVALS_EXPECTED = 'auto, parley or terminal';

/** Хуки Codex (`-c hooks.*`) ставятся только в режиме `parley`: в `auto` хук идёт раньше авторевьюера и ломает его. */
export function codexHooksWanted(config: Pick<ParleyConfig, 'codexWriteApprovals'>): boolean {
  return config.codexWriteApprovals === 'parley';
}

/**
 * Общий потолок живых CLI агентов на машине (спека сна агентов и ёмкости 2026-10-30, 4.2): `off` — потолок, очередь
 * и допуск выключены, `auto` — по памяти машины, число — 1…128.
 */
export type MachineConcurrent = 'off' | 'auto' | number;

/**
 * Пороги бюджета работы и комнаты (`work/resource-policy.ts`) — те же ключи, что у `ResourceLimits`: человек видит и
 * меняет их в настройках окна. Это счётчики запусков, сессий и писем, а не денежный лимит.
 */
export interface ParleyConfig extends ResourceLimits {
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
  /**
   * Через сколько минут простоя хост усыпляет агента Claude Code без процесса: письмо будит его с той же историей
   * (план сна агентов). 0 — сон выключен, это умолчание. 0…1440.
   */
  sleepAfterMinutes: number;
  /**
   * Сколько минут простоя хватает, чтобы хост усыпил агента ради памяти или свободного слота, когда машине тесно
   * (спека сна агентов и ёмкости, 4.2). Работает только при включённом сне (`sleepAfterMinutes > 0`). 1…60.
   */
  sleepUnderPressureMinutes: number;
  /**
   * Общий потолок живых CLI агентов на машине (спека сна агентов и ёмкости, 4.2): `off` — потолок, очередь и допуск
   * выключены (умолчание), `auto` — `max(1, round(ГиБ памяти × 0.75))`, число — 1…128.
   */
  machineConcurrent: MachineConcurrent;
  /**
   * Ставить ли скилл `parley` в проект и в worktree сессии при запуске (`work/skill-install.ts`): файлы
   * `.agents/skills/parley` и симлинк `.claude/skills/parley`. Выключено — хост скилл не ставит и не
   * обновляет; уже поставленное не удаляется.
   */
  agentSkills: boolean;
  /**
   * Навигатор скиллов `find_skill` у Claude, GLM и Codex (спека навигатора). Включён по умолчанию с 2026-10-06 по
   * итогам живых проверок; выключается настройкой, переключателем окна или `PARLEY_SKILL_NAVIGATOR=0`.
   */
  skillNavigator: boolean;
  /**
   * Одобрения пишущих ролей Codex (спека 2026-10-21, 5.2). Прежний булев `codexApprovals` переносится: `true` → `parley`,
   * `false` → `terminal` (файл и `PARLEY_CODEX_APPROVALS`, пока нового ключа нет).
   */
  codexWriteApprovals: CodexWriteApprovals;
  /** Канал Telegram (спека управления через помощника): включён ли он, и какие события в него идут. */
  telegramEnabled: boolean;
  telegramNeedsYou: boolean;
  telegramFinished: boolean;
  telegramMail: boolean;
  telegramCards: boolean;
  /**
   * Облегчённый запуск участников комнат, которых Parley заводит по рецепту: без плагинов,
   * чужих MCP-серверов и автопамяти пользователя (спека «меньше ходов и легче контекст», C2.2). Включён по умолчанию;
   * сессию, которую человек запускает из окна сам, решение не касается. Читается один раз, при создании сессии.
   */
  leanAgents: boolean;
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
  sleepAfterMinutes: 0,
  sleepUnderPressureMinutes: 5,
  machineConcurrent: 'off',
  agentSkills: true,
  skillNavigator: true,
  codexWriteApprovals: 'auto',
  telegramEnabled: true,
  telegramNeedsYou: true,
  telegramFinished: false,
  telegramMail: true,
  telegramCards: true,
  leanAgents: true,
  // Терминал окна (кусок 1.3 плана окна, спека 4.3).
  fontFamily: "'SF Mono', Menlo, monospace",
  fontSize: 14,
  worktreeRoot: DEFAULT_WORKTREE_ROOT,
  ...DEFAULT_RESOURCE_LIMITS,
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
  sleepAfterMinutes: 'SLEEP_AFTER_MINUTES',
  sleepUnderPressureMinutes: 'SLEEP_UNDER_PRESSURE_MINUTES',
  machineConcurrent: 'MACHINE_CONCURRENT',
  agentSkills: 'AGENT_SKILLS',
  skillNavigator: 'SKILL_NAVIGATOR',
  codexWriteApprovals: 'CODEX_WRITE_APPROVALS',
  telegramEnabled: 'TELEGRAM_ENABLED',
  telegramNeedsYou: 'TELEGRAM_NEEDS_YOU',
  telegramFinished: 'TELEGRAM_FINISHED',
  telegramMail: 'TELEGRAM_MAIL',
  telegramCards: 'TELEGRAM_CARDS',
  leanAgents: 'LEAN_AGENTS',
  fontFamily: 'FONT_FAMILY',
  fontSize: 'FONT_SIZE',
  worktreeRoot: 'WORKTREE_ROOT',
  workConcurrent: 'WORK_CONCURRENT',
  roomConcurrent: 'ROOM_CONCURRENT',
  workNewSessions: 'WORK_NEW_SESSIONS',
  roomNewSessions: 'ROOM_NEW_SESSIONS',
  workLaunches: 'WORK_LAUNCHES',
  roomLaunches: 'ROOM_LAUNCHES',
  workMessages: 'WORK_MESSAGES',
  roomMessages: 'ROOM_MESSAGES',
  fanout: 'FANOUT',
  swarmSessions: 'SWARM_SESSIONS',
  swarmConcurrent: 'SWARM_CONCURRENT',
  workSwarmSessions: 'WORK_SWARM_SESSIONS',
  workSwarms: 'WORK_SWARMS',
  swarmMinutes: 'SWARM_MINUTES',
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

/** Ноль минут — сон выключен, поэтому, как у `resumeRate`, границы начинаются с нуля. */
const SLEEP_AFTER_MINUTES_MIN = 0;
const SLEEP_AFTER_MINUTES_MAX = 1440;
const isSleepAfterMinutes = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= SLEEP_AFTER_MINUTES_MIN &&
  value <= SLEEP_AFTER_MINUTES_MAX;
const SLEEP_AFTER_MINUTES_EXPECTED = `an integer from ${SLEEP_AFTER_MINUTES_MIN} to ${SLEEP_AFTER_MINUTES_MAX}`;

/** Ноль здесь не «выключено» (сон выключает `sleepAfterMinutes`), поэтому границы начинаются с единицы. */
const SLEEP_UNDER_PRESSURE_MINUTES_MIN = 1;
const SLEEP_UNDER_PRESSURE_MINUTES_MAX = 60;
const isSleepUnderPressureMinutes = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= SLEEP_UNDER_PRESSURE_MINUTES_MIN &&
  value <= SLEEP_UNDER_PRESSURE_MINUTES_MAX;
const SLEEP_UNDER_PRESSURE_MINUTES_EXPECTED = `an integer from ${SLEEP_UNDER_PRESSURE_MINUTES_MIN} to ${SLEEP_UNDER_PRESSURE_MINUTES_MAX}`;

const MACHINE_CONCURRENT_MIN = 1;
const MACHINE_CONCURRENT_MAX = 128;
const MACHINE_CONCURRENT_EXPECTED = `"off", "auto" or an integer from ${MACHINE_CONCURRENT_MIN} to ${MACHINE_CONCURRENT_MAX}`;

/**
 * Разбор потолка машины — один для файла, окружения и `parseSetting`: `off` и `auto` без учёта регистра и пробелов по
 * краям, хранятся строчными; иначе целое от 1 до 128, числом или строкой. Пустая строка и пробелы — не число
 * (`Number('') === 0`) и вне границ, поэтому не превращаются молча ни в «выключено», ни в ноль. `null` — не разобралось.
 */
function parseMachineConcurrent(value: unknown): MachineConcurrent | null {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  if (word === 'off' || word === 'auto') return word;
  const parsed = word === undefined ? value : Number(word);
  return typeof parsed === 'number' &&
    Number.isInteger(parsed) &&
    parsed >= MACHINE_CONCURRENT_MIN &&
    parsed <= MACHINE_CONCURRENT_MAX
    ? parsed
    : null;
}

/** Порог бюджета — целое в границах своего ключа (`RESOURCE_LIMIT_BOUNDS`): ноль допустим не везде. */
const isResourceLimit = (key: keyof ResourceLimits, value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= RESOURCE_LIMIT_BOUNDS[key].min &&
  value <= RESOURCE_LIMIT_BOUNDS[key].max;
const resourceLimitExpected = (key: keyof ResourceLimits): string =>
  `an integer from ${RESOURCE_LIMIT_BOUNDS[key].min} to ${RESOURCE_LIMIT_BOUNDS[key].max}`;

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
  take('sleepAfterMinutes', isSleepAfterMinutes, SLEEP_AFTER_MINUTES_EXPECTED);
  take('sleepUnderPressureMinutes', isSleepUnderPressureMinutes, SLEEP_UNDER_PRESSURE_MINUTES_EXPECTED);
  // Потолок хранится строчным и без пробелов, а `take` кладёт значение как есть, поэтому разбор свой — общий с окружением.
  if (data.machineConcurrent !== undefined) {
    const machineConcurrent = parseMachineConcurrent(data.machineConcurrent);
    if (machineConcurrent === null) complain(`machineConcurrent: expected ${MACHINE_CONCURRENT_EXPECTED}`);
    else patch.machineConcurrent = machineConcurrent;
  }
  take('agentSkills', (value) => typeof value === 'boolean', 'true or false');
  take('skillNavigator', (value) => typeof value === 'boolean', 'true or false');
  take('codexWriteApprovals', isCodexWriteApprovals, CODEX_WRITE_APPROVALS_EXPECTED);
  // Перенос прежнего булева ключа: новый ключ, если он есть в файле (хоть и битый), сильнее.
  if (data.codexWriteApprovals === undefined && typeof data.codexApprovals === 'boolean') {
    patch.codexWriteApprovals = data.codexApprovals ? 'parley' : 'terminal';
  }
  take('telegramEnabled', (value) => typeof value === 'boolean', 'true or false');
  take('telegramNeedsYou', (value) => typeof value === 'boolean', 'true or false');
  take('telegramFinished', (value) => typeof value === 'boolean', 'true or false');
  take('telegramMail', (value) => typeof value === 'boolean', 'true or false');
  take('telegramCards', (value) => typeof value === 'boolean', 'true or false');
  take('leanAgents', (value) => typeof value === 'boolean', 'true or false');
  take('fontFamily', isFontFamily, 'a non-empty string');
  take('fontSize', isFontSize, FONT_SIZE_EXPECTED);
  take('worktreeRoot', isWorktreeRoot, 'a non-empty string');
  for (const key of RESOURCE_LIMIT_KEYS) take(key, (value) => isResourceLimit(key, value), resourceLimitExpected(key));
  return patch;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Прежняя булева переменная `PARLEY_CODEX_APPROVALS` (и `HARNAS_…`): ключа в `ENV_NAMES` у неё больше нет. */
const LEGACY_CODEX_APPROVALS_ENV = 'CODEX_APPROVALS';

/** Значения из окружения: тут всё строки, поэтому числа и флаги разбираются. */
function fromEnv(env: NodeJS.ProcessEnv, complain: Complain): ConfigPatch {
  const patch: ConfigPatch = {};

  // Пустая переменная — то же самое, что незаданная: так же ведёт себя `PARLEY_HOME` (`envValue`).
  const text = (key: keyof ParleyConfig): string | undefined => envValue(env, ENV_NAMES[key]);
  // Имя, которое назвать человеку: то, под которым значение реально пришло.
  const nameOf = (key: keyof ParleyConfig): string => envName(env, ENV_NAMES[key]) ?? ENV_NAMES[key];

  const flag = (
    key: 'channelPush' | 'agentSkills' | 'skillNavigator' | 'leanAgents'
    | 'telegramEnabled' | 'telegramNeedsYou' | 'telegramFinished' | 'telegramMail' | 'telegramCards',
  ): void => {
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
    // Пробелы вместо числа — не ноль (`Number('  ') === 0`): будильник не выключается молча, ключ не запирается.
    if (resumeRate.trim() !== '' && isResumeRate(parsed)) patch.resumeRate = parsed;
    else complain(`${nameOf('resumeRate')}: expected ${RESUME_RATE_EXPECTED}`);
  }
  const sleepAfterMinutes = text('sleepAfterMinutes');
  if (sleepAfterMinutes !== undefined) {
    const parsed = Number(sleepAfterMinutes);
    // Пробелы вместо числа — не ноль (`Number('  ') === 0`): сон не выключается молча, ключ не запирается.
    if (sleepAfterMinutes.trim() !== '' && isSleepAfterMinutes(parsed)) patch.sleepAfterMinutes = parsed;
    else complain(`${nameOf('sleepAfterMinutes')}: expected ${SLEEP_AFTER_MINUTES_EXPECTED}`);
  }
  const sleepUnderPressureMinutes = text('sleepUnderPressureMinutes');
  if (sleepUnderPressureMinutes !== undefined) {
    // Пробелы вместо числа дают `Number('  ') === 0` — вне границ 1…60, жалоба есть и без отдельной проверки.
    const parsed = Number(sleepUnderPressureMinutes);
    if (isSleepUnderPressureMinutes(parsed)) patch.sleepUnderPressureMinutes = parsed;
    else complain(`${nameOf('sleepUnderPressureMinutes')}: expected ${SLEEP_UNDER_PRESSURE_MINUTES_EXPECTED}`);
  }
  const machineConcurrent = text('machineConcurrent');
  if (machineConcurrent !== undefined) {
    const parsed = parseMachineConcurrent(machineConcurrent);
    if (parsed === null) complain(`${nameOf('machineConcurrent')}: expected ${MACHINE_CONCURRENT_EXPECTED}`);
    else patch.machineConcurrent = parsed;
  }
  flag('agentSkills');
  flag('skillNavigator');

  const codexWriteApprovals = text('codexWriteApprovals');
  if (codexWriteApprovals !== undefined) {
    if (isCodexWriteApprovals(codexWriteApprovals)) patch.codexWriteApprovals = codexWriteApprovals;
    else complain(`${nameOf('codexWriteApprovals')}: expected ${CODEX_WRITE_APPROVALS_EXPECTED}`);
  } else {
    // Прежняя переменная работает, только пока новая не задана: 1 → parley, 0 → terminal.
    const legacy = envValue(env, LEGACY_CODEX_APPROVALS_ENV);
    if (legacy !== undefined) {
      const lower = legacy.toLowerCase();
      if (TRUE.has(lower)) patch.codexWriteApprovals = 'parley';
      else if (FALSE.has(lower)) patch.codexWriteApprovals = 'terminal';
      else complain(`${envName(env, LEGACY_CODEX_APPROVALS_ENV) ?? LEGACY_CODEX_APPROVALS_ENV}: expected 0 or 1`);
    }
  }
  flag('telegramEnabled');
  flag('telegramNeedsYou');
  flag('telegramFinished');
  flag('telegramMail');
  flag('telegramCards');
  flag('leanAgents');

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
  for (const key of RESOURCE_LIMIT_KEYS) {
    const raw = text(key);
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (isResourceLimit(key, parsed)) patch[key] = parsed;
    else complain(`${nameOf(key)}: expected ${resourceLimitExpected(key)}`);
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
  'agentSkills',
  'skillNavigator',
  'leanAgents',
  'telegramEnabled',
  'telegramNeedsYou',
  'telegramFinished',
  'telegramMail',
  'telegramCards',
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
  if (key === 'codexWriteApprovals') {
    if (isCodexWriteApprovals(text)) return { value: text as ParleyConfig[K] };
    return { error: `${key}: expected ${CODEX_WRITE_APPROVALS_EXPECTED}` };
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
    // Пустая строка — не ноль (`Number('') === 0`): очищенное поле не должно молча выключать возобновление.
    const parsed = Number(text);
    if (text.trim() !== '' && isResumeRate(parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${RESUME_RATE_EXPECTED}` };
  }
  if (key === 'sleepAfterMinutes') {
    // Отдельная ветка, как у `resumeRate`: общая для чисел отвергла бы допустимый ноль — «сон выключен».
    // Пустая строка — не ноль (`Number('') === 0`): очищенное поле не должно молча выключать сон.
    const parsed = Number(text);
    if (text.trim() !== '' && isSleepAfterMinutes(parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${SLEEP_AFTER_MINUTES_EXPECTED}` };
  }
  if (key === 'sleepUnderPressureMinutes') {
    // Отдельная ветка: общая для чисел не знает ни верхней границы, ни своего текста ошибки. Пустая строка — не ноль:
    // `Number('') === 0` вне границ 1…60.
    const parsed = Number(text);
    if (isSleepUnderPressureMinutes(parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${SLEEP_UNDER_PRESSURE_MINUTES_EXPECTED}` };
  }
  if (key === 'machineConcurrent') {
    const parsed = parseMachineConcurrent(text);
    if (parsed !== null) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${MACHINE_CONCURRENT_EXPECTED}` };
  }
  if ((RESOURCE_LIMIT_KEYS as readonly string[]).includes(key)) {
    const limit = key as keyof ResourceLimits;
    const parsed = Number(text);
    if (text.trim() !== '' && isResourceLimit(limit, parsed)) return { value: parsed as ParleyConfig[K] };
    return { error: `${key}: expected ${resourceLimitExpected(limit)}` };
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
