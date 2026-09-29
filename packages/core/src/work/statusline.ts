/**
 * Скрипт строки статуса Claude Code (спека комнат Organic, 3.5, «Лимиты подписок»). Харнесс
 * кладёт его в файл настроек работы (`statusLine` рядом с хуками, `--settings`), и Claude Code
 * зовёт его после каждого ответа модели: JSON сессии на stdin, первая строка stdout — строка
 * статуса в терминале (code.claude.com/docs/en/statusline).
 *
 * Скрипт делает две вещи:
 * 1. Если во входе есть `rate_limits` (подписки Pro и Max, после первого ответа модели), атомарно
 *    пишет `{ at, rateLimits }` в `limits/<сессия>.json` каталога работы. Оттуда лимиты
 *    берёт хост. Нет `rate_limits` — файла нет.
 * 2. Печатает строку терминала. Своя строка статуса у человека есть в настройках Claude Code —
 *    вызывает её команду с тем же stdin и тем же окружением и печатает вывод как есть, так что в
 *    терминале ничего не меняется. Нет — короткая строка: модель и процент контекста.
 *
 * Границы: настройки Claude Code только читаются, в каталог агента ничего не пишется — рамочный
 * тест проверяет и это. Сети скрипт не касается. Он быстрый, потому что зовётся часто, поэтому
 * тянет только встроенные модули и лист `../limits.js`. Любая ошибка (битый stdin, нет
 * каталога, упала команда человека) даёт строку и код выхода 0: при ненулевом коде или пустом
 * выводе Claude Code гасит строку статуса совсем.
 *
 * Команда человека запускается в своей группе процессов. По таймауту и по отмене (Claude Code
 * вытесняет идущий вызов новым — точка входа получает SIGTERM) убивается вся группа: у составной
 * команды `sleep` пережил бы одну убитую оболочку и держал бы унаследованный stderr.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeLimits, isFileSafeId, LIMITS_DIR, limitsFile } from '../limits.js';

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

/**
 * Наша ли это команда: в ней стоит полный путь нашего скрипта — как есть или в кавычках для
 * оболочки. По имени файла нельзя: свой скрипт человека тоже может зваться `statusline-bin`, и
 * его строку мы бы молча подменили короткой.
 */
export function isOwnCommand(command: string): boolean {
  return command.includes(STATUSLINE_ENTRY) || command.includes(shellQuote(STATUSLINE_ENTRY));
}

/**
 * Сколько ждём команду человека. В документации Claude Code предела у строки статуса нет
 * (медленный скрипт просто задерживает обновление, а новый вызов его отменяет), поэтому предел
 * свой: зависшая команда не оставит терминал без строки. Щедрый, чтобы не резать тяжёлые
 * скрипты человека с git и подсчётом расходов.
 */
export const HUMAN_TIMEOUT_MS = 5000;

/** Каталог настроек Claude Code — и в проекте, и в домашней папке. Только чтение. */
const AGENT_DIR = '.claude';

export interface StatuslineOptions {
  /** Окружение процесса агента: адрес работы и сессии; то же уходит команде человека. */
  env?: NodeJS.ProcessEnv;
  /** Домашняя папка человека; по умолчанию `os.homedir()`. */
  home?: string;
  now?: () => number;
  humanTimeoutMs?: number;
  /**
   * Отмена: Claude Code вытесняет идущий вызов новым, и точка входа получает SIGTERM. По отмене
   * команда человека убивается вместе со своей группой процессов, строка остаётся короткой.
   */
  signal?: AbortSignal;
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
 * Пишет `{ at, rateLimits }` в файл сессии: временный файл рядом и `rename`, чтобы хост не
 * прочитал недописанное. Каталог `limits` заводится, а каталог работы — нет: удалённую работу
 * (её стёрли под живым агентом) скрипт не воскрешает. Адрес — из окружения агента, как у хуков.
 */
async function saveLimits(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const at = new Date(now()).toISOString();
  const rateLimits = input?.['rate_limits'];
  // Окон подписки во входе нет (шлюз, API-ключ, первый ход) — хранить нечего.
  if (claudeLimits(rateLimits, at) === null) return;
  const workDir = env['HARNAS_WORK_DIR'];
  const sessionId = env['HARNAS_SESSION_ID'];
  if (workDir === undefined || !path.isAbsolute(workDir)) return;
  if (sessionId === undefined || !isFileSafeId(sessionId)) return;

  try {
    await mkdir(path.join(workDir, LIMITS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
  }
  const file = limitsFile(workDir, sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ at, rateLimits })}\n`, 'utf8');
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * Каталог проекта — `project_dir` из входа: куда запущен Claude Code и где он сам ищет настройки
 * проекта, после того как человек принял доверие к этой папке. `current_dir` (куда агент ушёл
 * потом) не годится: там может оказаться чужой репозиторий, клон или пакет со своей строкой
 * статуса, и мы исполнили бы её в обход доверия. Он берётся только у старого Claude Code без
 * `project_dir`, где совпадает с каталогом запуска; как и верхнее поле `cwd`.
 */
function projectDir(input: Record<string, unknown> | null): string | null {
  const workspace = isRecord(input?.['workspace']) ? input['workspace'] : null;
  const candidates = [workspace?.['project_dir'], workspace?.['current_dir'], input?.['cwd']];
  for (const dir of candidates) {
    if (typeof dir === 'string' && path.isAbsolute(dir)) return dir;
  }
  return null;
}

/**
 * Файлы настроек Claude Code, где может лежать строка статуса человека, в порядке старшинства
 * (docs/en/settings): локальные настройки проекта, общие настройки проекта, настройки
 * пользователя. Каталога проекта во входе нет — только настройки пользователя: каталог самого
 * процесса не угадывается.
 */
function settingsFiles(input: Record<string, unknown> | null, home: string): string[] {
  const dir = projectDir(input);
  const project =
    dir === null
      ? []
      : [
          path.join(dir, AGENT_DIR, 'settings.local.json'),
          path.join(dir, AGENT_DIR, 'settings.json'),
        ];
  return [...project, path.join(home, AGENT_DIR, 'settings.json')];
}

/**
 * Команда строки статуса человека — из первого файла настроек, где она есть. Наша собственная
 * не считается: звать себя же — бесконечная рекурсия, а не строка человека. Только чтение.
 */
async function humanCommand(
  input: Record<string, unknown> | null,
  home: string,
): Promise<string | null> {
  for (const file of settingsFiles(input, home)) {
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const line = isRecord(settings) ? settings['statusLine'] : undefined;
    if (!isRecord(line) || line['type'] !== 'command') continue;
    const command = text(line['command']);
    if (command === null) continue;
    return isOwnCommand(command) ? null : command;
  }
  return null;
}

/**
 * Убивает команду человека вместе с её группой процессов. Одной оболочки мало: у составной
 * команды (`sleep 12; echo hi`) убитую оболочку пережил бы `sleep`, а он держит унаследованные
 * stdout и stderr, и Claude Code ждёт их закрытия. Группа своя — команда запущена с `detached`,
 * и её id равен pid оболочки.
 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Группа уже ушла (или платформа без групп) — хотя бы оболочку.
    child.kill('SIGKILL');
  }
}

/**
 * Запускает команду человека так же, как Claude Code: оболочкой, с тем же stdin и окружением.
 * Вывод — как есть. Не ответила за `timeoutMs`, отменена `signal`, упала или не запустилась —
 * `null`, строку тогда печатает сам скрипт. По таймауту и по отмене убивается вся группа команды.
 */
function runHuman(
  command: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let child: ChildProcess | undefined;
    let done = false;
    const finish = (result: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    // Таймаут и отмена — одно и то же: убить команду с группой и отдать короткую строку.
    const stop = (): void => {
      if (child !== undefined && !done) killGroup(child);
      finish(null);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    try {
      // stderr команды идёт в наш stderr: `claude --debug` показывает его человеку.
      child = spawn(command, {
        shell: true,
        detached: true,
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
    } catch {
      finish(null);
      return;
    }
    child.on('error', () => finish(null));
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
    // Команда, не читающая stdin, закрывает его раньше, чем мы дописали, — это не ошибка.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });
}

/** Короткая строка без своей у человека: модель и процент контекста (`Opus · ctx 8%`). */
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
 * Одна отработка строки статуса: JSON со stdin → (файл лимитов, вывод для терминала). Не
 * бросает: сбой любой части оставляет остальные.
 */
export async function runStatusline(raw: string, options: StatuslineOptions = {}): Promise<Buffer> {
  const env = options.env ?? process.env;
  const input = parseInput(raw);

  // Файл — до команды человека: строку, убитую Claude Code на полуслове, данные не теряют.
  await saveLimits(input, env, options.now ?? Date.now).catch(() => undefined);

  const command = await humanCommand(input, options.home ?? homedir()).catch(() => null);
  const human =
    command === null
      ? null
      : await runHuman(
          command,
          raw,
          env,
          options.humanTimeoutMs ?? HUMAN_TIMEOUT_MS,
          options.signal,
        );
  return human ?? Buffer.from(shortLine(input), 'utf8');
}
