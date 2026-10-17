/**
 * Скрипт строки статуса Claude Code (спека комнат Organic, 3.5, «Лимиты подписок»). Харнесс
 * кладёт его в файл настроек работы (`statusLine` рядом с хуками, `--settings`), и Claude Code
 * зовёт его после каждого ответа модели: JSON сессии на stdin, первая строка stdout — строка
 * статуса в терминале (code.claude.com/docs/en/statusline).
 *
 * Скрипт делает две вещи с файлами и печатает короткую строку:
 * 1. Если во входе есть `rate_limits` (подписки Pro и Max, после первого ответа модели), атомарно
 *    пишет `{ at, rateLimits }` в `limits/<сессия>.json` каталога работы. Оттуда лимиты
 *    берёт хост. Нет `rate_limits` — файла нет.
 * 2. Если во входе есть `context_window` с числовым `used_percentage`, так же атомарно пишет заполненность контекста
 *    в `context/<сессия>.json` (спека 2026-10-15, 4.1). Нет — файла нет.
 * Строка терминала всегда короткая: модель и процент контекста. Строку статуса человека из
 * настроек Claude Code скрипт не ищет и не запускает: Claude Code зовёт команду после каждого
 * ответа, и у многих агентов комнаты тяжёлая команда человека (git, node, jq на каждый вызов)
 * держала бы заметную долю ядра постоянно.
 *
 * Границы: в каталог агента ничего не пишется, настройки Claude Code не читаются — рамочный тест
 * проверяет и это. Сети скрипт не касается. Он быстрый, потому что зовётся часто, поэтому
 * тянет только встроенные модули и лист `../limits.js`. Любая ошибка (битый stdin, нет
 * каталога) даёт строку и код выхода 0: при ненулевом коде или пустом выводе Claude Code гасит
 * строку статуса совсем.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeContextFill, CONTEXT_DIR, contextFile } from '../context-fill.js';
import { claudeLimits, isFileSafeId, LIMITS_DIR, limitsFile } from '../limits.js';
import { envValue } from '../names.js';

/** Имя файла точки входа без расширения: `statusline-bin.js` лежит рядом с этим модулем. */
export const STATUSLINE_BIN = 'statusline-bin';

/**
 * Скрипт строки статуса — абсолютный путь к собранному файлу рядом с этим модулем, в `work/`, тем
 * же способом, что и сервер MCP (`mcp-config.ts`), а не имя из PATH.
 */
export const STATUSLINE_ENTRY = fileURLToPath(new URL(`./${STATUSLINE_BIN}.js`, import.meta.url));

/** Строка для оболочки: Claude Code запускает команду через неё, а в путях бывают пробелы. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Команда строки статуса: node текущего процесса (хост запущен системным node, и тот же стоит у
 * агента) и скрипт по абсолютному пути — без надежды на PATH, как у сервера MCP. Адрес работы и
 * сессии скрипт берёт из окружения агента, как хуки.
 */
export const statusLineCommand = (): string =>
  `${shellQuote(process.execPath)} ${shellQuote(STATUSLINE_ENTRY)}`;

export interface StatuslineOptions {
  /** Окружение процесса агента: адрес работы и сессии. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function parseInput(raw: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(raw);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Атомарная запись файла сессии в подкаталог работы (`limits/`, `context/`): временный файл и `rename`. Каталог
 * работы не создаётся (`mkdir` без recursive): удалённую под живым агентом работу скрипт не воскрешает.
 */
async function writeSessionFile(
  env: NodeJS.ProcessEnv,
  dirName: string,
  fileOf: (workDir: string, sessionId: string) => string,
  body: unknown,
): Promise<void> {
  const workDir = envValue(env, 'WORK_DIR');
  const sessionId = envValue(env, 'SESSION_ID');
  if (workDir === undefined || !path.isAbsolute(workDir)) return;
  if (sessionId === undefined || !isFileSafeId(sessionId)) return;

  try {
    await mkdir(path.join(workDir, dirName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
  }
  const file = fileOf(workDir, sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(body)}\n`, 'utf8');
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function saveLimits(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const at = new Date(now()).toISOString();
  const rateLimits = input?.['rate_limits'];
  // Окон подписки во входе нет (шлюз, API-ключ, первый ход) — хранить нечего.
  if (claudeLimits(rateLimits, at) === null) return;
  await writeSessionFile(env, LIMITS_DIR, limitsFile, { at, rateLimits });
}

/** Заполненность контекста (спека 2026-10-15, 4.1): `context/<сессия>.json`; нет `context_window` — файла нет. */
async function saveContext(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const fill = claudeContextFill(input?.['context_window'], new Date(now()).toISOString());
  if (fill === null) return;
  await writeSessionFile(env, CONTEXT_DIR, contextFile, fill);
}

/** Строка терминала: модель и процент контекста (`Opus · ctx 8%`). */
function shortLine(input: Record<string, unknown> | null): string {
  const model = isRecord(input?.['model']) ? input['model'] : null;
  const name = text(model?.['display_name']) ?? text(model?.['id']) ?? 'Claude';
  const context = isRecord(input?.['context_window']) ? input['context_window'] : null;
  const used = context?.['used_percentage'];
  return typeof used === 'number' && Number.isFinite(used)
    ? `${name} · ctx ${Math.round(used)}%\n`
    : `${name}\n`;
}

/**
 * Одна отработка строки статуса: JSON со stdin → (файлы лимитов и контекста, короткая строка для
 * терминала). Не бросает: сбой любой части оставляет остальные.
 */
export async function runStatusline(raw: string, options: StatuslineOptions = {}): Promise<Buffer> {
  const env = options.env ?? process.env;
  const input = parseInput(raw);

  // Файлы — до вывода: строку, убитую Claude Code на полуслове, данные не теряют.
  await saveLimits(input, env, options.now ?? Date.now).catch(() => undefined);
  await saveContext(input, env, options.now ?? Date.now).catch(() => undefined);

  return Buffer.from(shortLine(input), 'utf8');
}
