import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ShellEnvResult {
  env: NodeJS.ProcessEnv;
  fromShell: boolean;
  warning: string | null;
}

/**
 * Маркеры вокруг вывода `env -0`. Интерактивная login-оболочка пишет в тот же stdout всё, что
 * печатают rc-файлы и хуки выхода (баннеры, `nvm`, «instant prompt»): без границ этот шум попал
 * бы в окружение вместе с настоящими переменными.
 */
const ENV_BEGIN = '__PARLEY_ENV_BEGIN__';
const ENV_END = '__PARLEY_ENV_END__';

/**
 * Команда для `-c`: маркер, `env -0`, маркер. `env -0` печатает записи `ИМЯ=значение`, каждую с NUL
 * в конце, — значение с переводом строки или `=` внутри границу записи не ломает (построчный `env`
 * не отличил бы его продолжение от следующей переменной). `env` — по абсолютному пути: алиас,
 * функция или `PATH` из rc-файла его не подменят. Маркеры — отдельные аргументы `printf`:
 * экранирование не зависит от того, zsh это, bash или fish, а сама команда выполняется уже после
 * rc-файлов.
 */
const PRINT_ENV = `printf '%s' '${ENV_BEGIN}'; /usr/bin/env -0; printf '%s' '${ENV_END}'`;

/** `v22.18.0` → [22, 18, 0]. */
const versionParts = (name: string): number[] => name.slice(1).split('.').map(Number);

/** Сначала новые: `v22.18.0` раньше `v22.9.0`, а та — раньше `v20.11.1`. */
function newerFirst(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Каталог `bin` версии Node, которую nvm ставит по умолчанию: в нём лежат и `node`, и глобальные пакеты npm —
 * `codex` в том числе. Версия — из `alias/default`, если там номер (`22`, `22.18`, `v22.18.0`): самая новая
 * установленная с таким началом. Имена nvm (`node`, `lts/*`) без его кода не разрешить, а без `alias/default`
 * nvm в PATH ничего не ставит; нам же нужен хоть какой-то каталог глобальных пакетов — тогда самая новая.
 * nvm нет или в нём ни одной версии — `null`.
 */
async function nvmDefaultBin(nvmDir: string): Promise<string | null> {
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  let versions: string[];
  try {
    versions = (await readdir(versionsDir))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort(newerFirst);
  } catch {
    return null;
  }
  const newest = versions[0];
  if (newest === undefined) return null;
  const alias = await readFile(path.join(nvmDir, 'alias', 'default'), 'utf8').then(
    (text) => text.trim().replace(/^v/, ''),
    () => '',
  );
  const matching = /^\d+(\.\d+){0,2}$/.test(alias)
    ? versions.find((name) => name.slice(1) === alias || name.slice(1).startsWith(`${alias}.`))
    : undefined;
  return path.join(versionsDir, matching ?? newest, 'bin');
}

/**
 * Где ставят `claude`, `codex` и `node`, когда login-оболочка не ответила: каталоги самих CLI и менеджеров
 * версий Node. Через npm (`npm i -g @openai/codex`) CLI ложится в каталог версии Node — у nvm он свой у каждой
 * версии, у volta, asdf и mise вместо него shims. `NVM_DIR` берётся из окружения окна, иначе `~/.nvm`.
 */
async function fallbackDirs(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const nvm = await nvmDefaultBin(env.NVM_DIR ?? path.join(home, '.nvm'));
  return [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(nvm === null ? [] : [nvm]),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
  ];
}

const isDirectory = (dir: string): Promise<boolean> =>
  stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );

/**
 * Код выхода не смотрим: оболочка, напечатавшая маркеры и потом вышедшая с ошибкой (хук выхода),
 * своё дело сделала, а решает разбор маркеров — не успела напечатать, их просто не будет.
 *
 * Ответ уходит, как только пара маркеров пришла целиком, а не когда закрылась труба: процесс,
 * оставленный rc-файлом в фоне, наследует stdout оболочки и держит трубу открытой, пока жив сам, —
 * `close` тогда не приходит, а окружение уже напечатано. Оболочка после этого выходит сама (хуки
 * выхода отрабатывают), таймер остаётся сторожем: не вышла за срок — убита.
 */
async function runShell(shell: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    // Декодер с состоянием: символ не из ASCII (путь) не рвётся на границе чанков.
    child.stdout.setEncoding('utf8');
    let out = '';
    let answered = false;
    const answer = (finish: () => void): void => {
      if (answered) return;
      answered = true;
      finish();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      answer(() => reject(new Error(`shell did not respond within ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk: string) => {
      // Ответ отдан, а фоновый процесс всё пишет в ту же трубу: вывод не копим, но и читать не бросаем.
      if (answered) return;
      out += chunk;
      if (betweenMarkers(out) !== null) answer(() => resolve(out));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      answer(() => reject(err));
    });
    child.on('close', () => {
      clearTimeout(timer);
      answer(() => resolve(out));
    });
  });
}

/** Оборачивает любой `run` (в том числе подставной, из теста) внешним таймаутом. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shell did not respond within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Текст между первым маркером начала и следующим за ним маркером конца; `null` — пара не пришла целиком. */
function betweenMarkers(output: string): string | null {
  const begin = output.indexOf(ENV_BEGIN);
  if (begin === -1) return null;
  const from = begin + ENV_BEGIN.length;
  const end = output.indexOf(ENV_END, from);
  return end === -1 ? null : output.slice(from, end);
}

/**
 * Окружение из текста между маркерами: записи `ИМЯ=значение`, разделённые NUL; значение — всё после
 * первого `=`. Запись без `=` или с пустым именем не переменная, её пропускаем.
 */
function parseEnv(block: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of block.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** Прежний `PATH` как есть плюс существующие каталоги, которых в нём ещё нет. */
async function withFallbackDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  isDir: (dir: string) => Promise<boolean>,
): Promise<string> {
  const base = env.PATH ?? '';
  const present = new Set(base.split(path.delimiter));
  const extra: string[] = [];
  for (const dir of await fallbackDirs(home, env)) {
    if (!present.has(dir) && (await isDir(dir))) extra.push(dir);
  }
  return [base, ...extra].filter((part) => part !== '').join(path.delimiter);
}

/**
 * Собранное окно, открытое из Finder, наследует от launchd урезанное окружение: `PATH` там
 * `/usr/bin:/bin:/usr/sbin:/sbin`, и без `~/.local/bin` и каталогов nvm хост не находит ни `claude`,
 * ни `codex`, ни системный `node`, а переменные, которые человек экспортирует в rc-файлах (прокси,
 * `CLAUDE_CONFIG_DIR`, `PARLEY_*` и прежние `HARNAS_*`), не приходят вовсе. Поэтому на старте, один раз и до запуска хоста,
 * окно снимает окружение login-оболочки человека (спека окна 3.2): `$SHELL -ilc` с `env -0` между
 * маркерами. rc-файлы читает сама оболочка, окно их не открывает.
 *
 * Результат — окружение оболочки целиком, а не его сумма с окружением окна: оболочка и так
 * унаследовала окружение окна, и всё, что она отдала, включая её `PATH`, главнее; снятое rc-файлом
 * назад не возвращается. Хост, поиск `node`, git и конфиг окна получают его как окружение запуска
 * (`spawnHost`), агенты — от хоста.
 *
 * Срок оболочки — 15 с: обычно она отвечает быстрее секунды, а долго — медленный rc (oh-my-zsh, nvm, первый
 * запуск под Rosetta). В 0.1.0 срок был 5 с, и сборка для Intel на Apple Silicon в него не уложилась: хост
 * получил запасной PATH без nvm, и `codex`, поставленный через npm, пропал из окна.
 *
 * Оболочка не ответила за таймаут, не запустилась, напечатала не то или отдала окружение без `PATH` —
 * окружение окна (`process.env`), а в его `PATH` дописаны существующие `~/.local/bin`,
 * `/opt/homebrew/bin`, `/usr/local/bin`, каталог версии Node по умолчанию у nvm и shims volta, asdf и mise;
 * причина — в `warning`.
 *
 * `skip` (E2E, `PARLEY_LOGIN_SHELL=skip`) оболочку не зовёт вовсе: окружение окна отдаётся как есть.
 */
export async function captureShellEnv(options?: {
  shell?: string;
  timeoutMs?: number;
  run?: (shell: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Окружение процесса окна: из него берутся `SHELL` и запасной результат. У окна — `process.env`, тест подставляет своё. */
  env?: NodeJS.ProcessEnv;
  /** Не звать оболочку человека: окружение окна как есть, без запасных каталогов и предупреждения. */
  skip?: boolean;
  /** Домашний каталог для запасных каталогов: `~/.local/bin`, `~/.nvm`, `~/.volta`… */
  home?: string;
  /** Существует ли каталог: запасные каталоги дописываются, только если он есть. */
  isDir?: (dir: string) => Promise<boolean>;
}): Promise<ShellEnvResult> {
  const base = options?.env ?? process.env;
  if (options?.skip === true) return { env: { ...base }, fromShell: false, warning: null };
  const shell = options?.shell ?? base.SHELL ?? '/bin/zsh';
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const run = options?.run ?? runShell;

  let warning: string;
  try {
    const output = await withTimeout(run(shell, ['-ilc', PRINT_ENV], timeoutMs), timeoutMs);
    const block = betweenMarkers(output);
    if (block === null) {
      warning = 'environment markers not found in shell output';
    } else {
      const shellEnv = parseEnv(block);
      // Окружение без PATH хосту не нужно: по нему не найти ни `node`, ни `claude`.
      if ((shellEnv.PATH ?? '').trim() !== '') {
        return { env: shellEnv, fromShell: true, warning: null };
      }
      warning = 'no PATH in the shell environment between the markers';
    }
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }

  const fallback = await withFallbackDirs(
    base,
    options?.home ?? os.homedir(),
    options?.isDir ?? isDirectory,
  );
  return { env: { ...base, PATH: fallback }, fromShell: false, warning };
}
