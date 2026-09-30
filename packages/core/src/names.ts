/**
 * Имена продукта — единственный источник (план переименования harnas → parley, R1).
 *
 * Новое имя — `Parley`; прежнее, `harnas`, остаётся читаемым: живые данные человека (`~/.harnas`,
 * `.harnas/` в проектах) и его окружение (`HARNAS_*` в rc-файлах, старые скрипты) не должны
 * пропасть. Поэтому у каждого имени здесь пара «новое и прежнее», а чтение идёт сначала по новому.
 *
 * Модуль чистый: ни Node, ни файловой системы, ни импортов. Его тянут скрипты, которые
 * запускаются после каждого хода агента (строка статуса, `notify` Codex), и окно (рендерер
 * берёт отсюда имя каталога состояния через подпуть `@parley/core/names`). Всё, что ходит на диск
 * (каталог состояния проекта, дом), лежит в `work/state-dir.ts` и `work/store.ts`.
 *
 * Литералы `.harnas`, `HARNAS_` и `'harnas'` вне этого модуля остаются только там, где это
 * осознанное наследие (R7), тест совместимости или текст, который меняет следующий шаг плана.
 */

/** Имя продукта снаружи. */
export const PRODUCT = 'Parley';

/** Домашний каталог (`~/.parley`) и прежний (`~/.harnas`). */
export const HOME_DIR = '.parley';
export const LEGACY_HOME_DIR = '.harnas';

/** Каталог состояния в папке проекта (`<проект>/.parley`) и прежний (`<проект>/.harnas`). */
export const STATE_DIR = '.parley';
export const LEGACY_STATE_DIR = '.harnas';
/** Оба имени: новое первым. Стражи (pathspec, дерево файлов, запрет записи) знают оба. */
export const STATE_DIRS: readonly string[] = [STATE_DIR, LEGACY_STATE_DIR];

/** Префикс переменных окружения и прежний. */
export const ENV_PREFIX = 'PARLEY_';
export const LEGACY_ENV_PREFIX = 'HARNAS_';

/**
 * Имена для агентов (R8, R9) — подключаются шагом «Имена для агентов»: до него поведение берёт прежние
 * значения из `work/mcp-config.ts` (`MCP_SERVER_NAME`), `work/skill.ts` (`SKILL_NAME`),
 * `work/worktree.ts` (префикс ветки) и `config.ts` (корень worktree).
 */
export const MCP_SERVER_NAME = 'parley';
export const SKILL_NAME = 'parley';
export const LEGACY_SKILL_NAME = 'harnas';
export const BRANCH_PREFIX = 'parley/';
export const DEFAULT_WORKTREE_ROOT = '~/parley/worktrees';

/** Окружение процесса: `process.env` и любой его слепок. Свой тип, а не `NodeJS.ProcessEnv` — модуль идёт и в рендерер. */
export type Env = Readonly<Record<string, string | undefined>>;

const filled = (value: string | undefined): value is string => value !== undefined && value !== '';

/**
 * Значение переменной по ключу без префикса (`HOME`, `WORK_DIR`, `CLAUDE_BIN`): сначала
 * `PARLEY_<ключ>`, потом `HARNAS_<ключ>`. Пустая строка — то же, что не задано: она не перекрывает
 * запасное имя, как не перекрывала бы и отсутствие переменной.
 */
export function envValue(env: Env, key: string): string | undefined {
  const current = env[ENV_PREFIX + key];
  if (filled(current)) return current;
  const legacy = env[LEGACY_ENV_PREFIX + key];
  return filled(legacy) ? legacy : undefined;
}

/**
 * Какое имя реально задано (то, под которым `envValue` нашёл значение); `undefined` — ни одно.
 * Нужно там, где человеку называют переменную: замок настройки в `settings.get`, жалоба на
 * неверное значение.
 */
export function envName(env: Env, key: string): string | undefined {
  if (filled(env[ENV_PREFIX + key])) return ENV_PREFIX + key;
  if (filled(env[LEGACY_ENV_PREFIX + key])) return LEGACY_ENV_PREFIX + key;
  return undefined;
}

/**
 * Сырое значение: то же чтение в том же порядке, но пустая строка остаётся значением. Так читаются
 * подмены бинарей (`PARLEY_<КОМАНДА>_BIN`): пустая подмена — явное «бинаря нет», и первым из двух имён
 * считается то, что вообще определено.
 */
export function envRaw(env: Env, key: string): string | undefined {
  return env[ENV_PREFIX + key] ?? env[LEGACY_ENV_PREFIX + key];
}

/**
 * Одни и те же значения под обоими именами: детям (агент, сервер MCP, хук, скрипты) уходят оба
 * набора сессионных переменных (R3), чтобы старый хост и старые скрипты продолжали работать.
 * Сначала все новые имена, потом все прежние.
 */
export function bothEnv(entries: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prefix of [ENV_PREFIX, LEGACY_ENV_PREFIX]) {
    for (const [key, value] of Object.entries(entries)) result[prefix + key] = value;
  }
  return result;
}
