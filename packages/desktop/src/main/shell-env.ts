import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ShellEnvResult {
  env: NodeJS.ProcessEnv;
  fromShell: boolean;
  warning: string | null;
}

/**
 * Маркеры вокруг значения `PATH`. Интерактивная login-оболочка пишет в тот же stdout всё, что
 * печатают rc-файлы и хуки выхода (баннеры, `nvm`, «instant prompt»): без границ этот шум попал
 * бы в `PATH`.
 */
const PATH_BEGIN = '__HARNAS_PATH_BEGIN__';
const PATH_END = '__HARNAS_PATH_END__';

/**
 * Команда для `-c`. Маркеры и `$PATH` — отдельные аргументы `printf`: экранирование не зависит от
 * того, zsh это, bash или fish, а сама команда выполняется уже после rc-файлов.
 */
const PRINT_PATH = `printf '%s%s%s' '${PATH_BEGIN}' "$PATH" '${PATH_END}'`;

/** Где ставят `claude` и `codex`, когда login-оболочка не ответила. */
const fallbackDirs = (home: string): string[] => [
  path.join(home, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

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
 * `close` тогда не приходит, а `PATH` уже напечатан. Оболочка после этого выходит сама (хуки выхода
 * отрабатывают), таймер остаётся сторожем: не вышла за срок — убита.
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
  const begin = output.indexOf(PATH_BEGIN);
  if (begin === -1) return null;
  const from = begin + PATH_BEGIN.length;
  const end = output.indexOf(PATH_END, from);
  return end === -1 ? null : output.slice(from, end);
}

/**
 * Значение между маркерами; `null` — маркеров нет, между ними пусто или лежит не `PATH`
 * (перевод строки и NUL в нём означают, что чужой вывод вклинился в печать).
 */
function pathFromOutput(output: string): string | null {
  const value = betweenMarkers(output);
  if (value === null || value.trim() === '' || /[\n\0]/.test(value)) return null;
  return value;
}

/** Прежний `PATH` как есть плюс существующие каталоги, которых в нём ещё нет. */
async function withFallbackDirs(
  current: string | undefined,
  home: string,
  isDir: (dir: string) => Promise<boolean>,
): Promise<string> {
  const base = current ?? '';
  const present = new Set(base.split(path.delimiter));
  const extra: string[] = [];
  for (const dir of fallbackDirs(home)) {
    if (!present.has(dir) && (await isDir(dir))) extra.push(dir);
  }
  return [base, ...extra].filter((part) => part !== '').join(path.delimiter);
}

/**
 * Собранное окно, открытое из Finder, наследует от launchd урезанный `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin`): без `~/.local/bin` и каталогов nvm хост не находит ни
 * `claude`, ни `codex`, ни системный `node`. Поэтому на старте, один раз и до запуска хоста,
 * спрашиваем `PATH` у login-оболочки человека: `$SHELL -ilc` с маркерами вокруг значения. rc-файлы
 * читает сама оболочка, окно их не открывает.
 *
 * Берётся только `PATH`: остальное окружение остаётся окружением процесса окна. Прежняя версия
 * тащила за собой всё окружение оболочки, включая то, чего хосту и агентам знать не нужно.
 * Хост и его агенты получают результат как окружение запуска хоста (`spawnHost`).
 *
 * Оболочка не ответила за таймаут, не запустилась или напечатала не то — прежний `PATH` плюс
 * существующие `~/.local/bin`, `/opt/homebrew/bin` и `/usr/local/bin`; причина — в `warning`.
 */
export async function captureShellEnv(options?: {
  shell?: string;
  timeoutMs?: number;
  run?: (shell: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Окружение, из которого строится результат; у окна — `process.env`, тест подставляет своё. */
  env?: NodeJS.ProcessEnv;
  /** Домашний каталог для `~/.local/bin`. */
  home?: string;
  /** Существует ли каталог: запасные каталоги дописываются, только если он есть. */
  isDir?: (dir: string) => Promise<boolean>;
}): Promise<ShellEnvResult> {
  const base = options?.env ?? process.env;
  const shell = options?.shell ?? base.SHELL ?? '/bin/zsh';
  const timeoutMs = options?.timeoutMs ?? 5000;
  const run = options?.run ?? runShell;

  let warning: string;
  try {
    const output = await withTimeout(run(shell, ['-ilc', PRINT_PATH], timeoutMs), timeoutMs);
    const shellPath = pathFromOutput(output);
    if (shellPath !== null) {
      return { env: { ...base, PATH: shellPath }, fromShell: true, warning: null };
    }
    warning = 'no PATH between the markers in shell output';
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }

  const fallback = await withFallbackDirs(
    base.PATH,
    options?.home ?? os.homedir(),
    options?.isDir ?? isDirectory,
  );
  return { env: { ...base, PATH: fallback }, fromShell: false, warning };
}
