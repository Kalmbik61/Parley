/**
 * Git и поиск файлового API main (спека 10.1–10.3, 10.7, 10.8, 13; кусок 7.1b):
 * `lsFiles` для ⌘P, `grep` для ⌘⇧F, `gitStatus` и `checkIgnored` для дерева, `gitShow`
 * для сравнения. Git у человека локализован: причины решаются только по коду выхода и
 * `ENOENT`, текст stderr не разбирается. Не-git корень (git нет в PATH login-shell или
 * папка не под git) работает обходом `walkFiles` и поиском в воркере.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { checkoutGitDir, joinDiffFiles, parseNameStatusZ, parseNumstat, STATE_DIRS } from '@parley/core';
import type { DiffFile, FileList, FileRoot, GitStatusLetter, GrepQuery, GrepResult, TextFile } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { HostError } from '../host-connection.js';
import type { RootsRegistry } from '../roots.js';
import { detectText, LIMITS } from './fs-api.js';
import { clipHit, GREP_LIMITS, type GrepJob, type GrepWorkerMessage, type RawGrepFile, type RawGrepHit } from './grep-worker.js';

export type { GrepJob } from './grep-worker.js';

export interface GitRunner {
  /**
   * git в cwd с PATH login-shell. onStdout — вывод по мере прихода: false — процесс гасится
   * (предел grep); maxBytes — предел накопленного stdout: выше — процесс гасится, truncated.
   * git нет в PATH — отказ с code 'ENOENT'. stdin — сверх брифа: `check-ignore --stdin`.
   */
  run(
    args: string[],
    cwd: string,
    options?: { signal?: AbortSignal; maxBytes?: number; onStdout?(chunk: Buffer): boolean; stdin?: Buffer },
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string; truncated: boolean }>;
}

/**
 * Флаги чтения, как у `core/work/worktree.ts#READ_FLAGS` (урок 8.1): фоновый статус раз в
 * 2 с не берёт `index.lock` рядом с агентом и не переписывает индекс человека.
 */
const READ_FLAGS = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false'];
/**
 * Первыми в каждом вызове git main (раунд fix-final-a, C1): `core.fsmonitor` — программа из
 * конфигурации репозитория, её исполняют `status` и `ls-files` фонового статуса.
 */
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'];
/**
 * `status` заходит в подмодули дочерним `git status`, а файл `.git` подмодуля лежит в копии
 * агента: подложенный gitdir исполнил бы свои фильтры. `dirty` — только сдвиг коммита
 * подмодуля, его git читает сам (как `NO_SUBMODULE_WALK` в core).
 */
const NO_SUBMODULE_WALK = '--ignore-submodules=dirty';
/** Ключи фильтров, которые исполняют чтения (`filterOverrides`). */
const FILTER_KEYS = '^filter\\..+\\.(clean|process)$';
/** Каталог состояния проекта (`.parley/`, прежний `.harnas/`) — карты, почта и журналы core: ни ⌘P, ни поиска, ни статуса (спека 10.1). */
const PATHSPEC = ['--', '.', ...STATE_DIRS.map((dir) => `:(exclude)${dir}`)];
/** Обход не-git корня: до 50 000 файлов (таблица чисел). */
export const WALK_LIMIT = 50_000;
/** Предел воркера поиска (план). */
export const GREP_TIMEOUT_MS = 10_000;
/**
 * Пределы сырого вывода git grep в main (решение по 7.1b): строка попадания держится до воркера
 * целиком, и без них пик памяти main при многомегабайтных строках ничем не ограничен. От строки
 * остаётся окно 64 КБ вокруг совпадения (`--column`, раунд fix-7.4, п. 2); весь вывод сверх 32 МБ —
 * git гасится, ответ truncated.
 */
export const GREP_LINE_BYTES = 64 * 1024;
export const GREP_TOTAL_BYTES = 32 * 1024 * 1024;
/** stderr git нужен только для консоли — дальше не копим. */
const STDERR_LIMIT = 64 * 1024;
/** Каталоги, в которые обход не заходит: зависимости, git и карты core (оба имени каталога состояния). */
const WALK_SKIP = new Set(['node_modules', '.git', ...STATE_DIRS]);

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

export function createGitRunner(env: NodeJS.ProcessEnv): GitRunner {
  return {
    run: (args, cwd, options = {}) =>
      new Promise((resolve, reject) => {
        const { signal, maxBytes, onStdout, stdin } = options;
        const child = spawn('git', [...NO_FSMONITOR, ...args], {
          cwd,
          env,
          stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let truncated = false;
        let killed = false;
        let settled = false;
        const kill = (): void => {
          if (killed) return;
          killed = true;
          child.kill('SIGKILL');
        };
        const cleanup = (): void => {
          settled = true;
          signal?.removeEventListener('abort', kill);
        };
        signal?.addEventListener('abort', kill, { once: true });
        if (signal?.aborted) kill();
        child.stdout?.on('data', (chunk: Buffer) => {
          if (killed) return;
          if (onStdout !== undefined) {
            // Разбор по мере прихода: весь вывод в памяти не копится.
            if (!onStdout(chunk)) kill();
            return;
          }
          size += chunk.length;
          if (maxBytes !== undefined && size > maxBytes) {
            truncated = true;
            kill();
            return;
          }
          chunks.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
          if (settled) return;
          cleanup();
          reject(error);
        });
        child.on('close', (code) => {
          if (settled) return;
          cleanup();
          resolve({ code: killed ? null : code, stdout: Buffer.concat(chunks), stderr, truncated });
        });
        if (stdin !== undefined && child.stdin !== null) {
          // git мог выйти, не дочитав: EPIPE здесь не ошибка вызова.
          child.stdin.on('error', () => undefined);
          child.stdin.end(stdin);
        }
      }),
  };
}

/** Кэш на раннер: подставной раннер теста не делит ответы с настоящим. */
const rootCache = new WeakMap<GitRunner, Map<string, { prefix: string } | null>>();

/**
 * git rev-parse --show-prefix в cwd = rootPath; кэш на корень. null — не git: ENOENT или ненулевой выход.
 * `pin` — закреплённый gitdir worktree (`--git-dir`/`--work-tree`), входит в ключ кэша.
 */
export async function gitRootOf(git: GitRunner, rootPath: string, pin: string[] = []): Promise<{ prefix: string } | null> {
  let cache = rootCache.get(git);
  if (cache === undefined) {
    cache = new Map();
    rootCache.set(git, cache);
  }
  const real = await realpath(rootPath).catch(() => rootPath);
  const key = [real, ...pin].join('\0');
  if (cache.has(key)) return cache.get(key) ?? null;
  let answer: { prefix: string } | null;
  try {
    const result = await git.run([...pin, 'rev-parse', '--show-prefix'], real);
    answer = result.code === 0 ? { prefix: result.stdout.toString('utf8').replace(/\n$/, '') } : null;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      // Сбой запуска (EAGAIN и т.п.) — не ответ про корень: не кэшируем.
      console.warn('[parley] files: git rev-parse failed', error);
      return null;
    }
    answer = null;
  }
  cache.set(key, answer);
  return answer;
}

/**
 * Clean- и process-фильтры исполняют `status` (файл со сдвинутым mtime) и `diff` против рабочего
 * дерева, а к файлу их привязывает `.gitattributes` агента (C1). Имена драйверов берутся из той же
 * конфигурации, что увидит чтение, и каждому ставится пустая команда; `required=false` — иначе пустой
 * обязательный фильтр был бы отказом. Так же — `filterOverrides` в core.
 */
export async function filterOverrides(git: GitRunner, cwd: string, pin: string[] = []): Promise<string[]> {
  const result = await git.run([...pin, 'config', '--null', '--name-only', '--get-regexp', FILTER_KEYS], cwd);
  // Код 1 — таких ключей нет.
  if (result.code === 1) return [];
  if (result.code !== 0) throw new Error(`git config --get-regexp filter exited with code ${String(result.code)}`);
  const drivers = new Set(
    parseLsFiles(result.stdout).map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))),
  );
  return [...drivers].flatMap((driver) => [
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.required=false`,
  ]);
}

/** Общий `.git` проекта (realpath) — опора проверки worktree; не git — null. */
export async function projectCommonDir(git: GitRunner, projectPath: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--git-common-dir'], projectPath);
  if (result.code !== 0) return null;
  // Относительный ответ git — от cwd.
  return realpath(path.resolve(projectPath, result.stdout.toString('utf8').trim()));
}

/**
 * `dir` — связанный worktree проекта: его `.git` ведёт в `<общий .git>/worktrees/<имя>`, а тот —
 * обратно в `dir` (ровно по этим файлам строит список `git worktree list`), проверка п. 1.2 —
 * `checkoutGitDir` core. Основная копия проекта — нет: корень `project` у работы уже есть, а у
 * проекта-подкаталога основная копия шире папки проекта. Сбой — нет (раунд fix-final-a, M6).
 */
export async function isProjectWorktree(git: GitRunner, projectPath: string, dir: string): Promise<boolean> {
  try {
    const common = await projectCommonDir(git, projectPath);
    if (common === null) return false;
    const gitDir = await checkoutGitDir(common, dir);
    return gitDir !== null && gitDir !== common;
  } catch {
    return false;
  }
}

export function parseLsFiles(stdout: Buffer): string[] {
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '');
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** --porcelain=v1 -z: пути от корня репозитория → от папки корня (срез prefix); вне корня — выброшены. */
export function parseGitStatus(stdout: Buffer, prefix: string): Record<string, GitStatusLetter> {
  const records = stdout.toString('utf8').split('\0');
  const out: Array<[string, GitStatusLetter]> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const file = record.slice(3);
    let letter: GitStatusLetter;
    if (xy === '??') letter = 'U';
    else if (xy === '!!') continue;
    else if (CONFLICTS.has(xy)) letter = 'M';
    else if (xy.includes('R') || xy.includes('C')) {
      letter = xy.includes('R') ? 'R' : 'A';
      // Старый путь идёт следом отдельной записью.
      i += 1;
    } else if (xy.includes('D')) letter = 'D';
    else if (xy.includes('A')) letter = 'A';
    else letter = 'M';
    if (!file.startsWith(prefix)) continue;
    const rel = file.slice(prefix.length);
    if (rel !== '') out.push([rel, letter]);
  }
  // fromEntries — собственные поля: файл `__proto__` не станет прототипом ответа.
  return Object.fromEntries(out);
}

/** Заголовок записи `путь\0строка\0колонка\0` сверх текста: путь длиннее на macOS и Linux не бывает. */
const GREP_HEADER_BYTES = 8 * 1024;

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/** Длина последовательности UTF-8 по первому байту; битый байт — 1. */
function utf8Length(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf7) return 4;
  if (byte >= 0xe0) return 3;
  if (byte >= 0xc0) return 2;
  return 1;
}

/** Кодовых единиц UTF-16 в байтах UTF-8: начало символа — 1, четырёхбайтного — пара. */
function utf16Units(bytes: Buffer): number {
  let units = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    if ((byte & 0xc0) !== 0x80) units += byte >= 0xf0 ? 2 : 1;
  }
  return units;
}

/**
 * Разбор вывода git grep --null -n --column кусками; push → false на пределе. ranges пустые — их
 * считает воркер. Колонка git — смещение совпадения в байтах от начала строки (с 1, git 2.53);
 * `column` ответа — в единицах UTF-16, как у курсора редактора: она считается по байтам до
 * совпадения на лету, без их хранения.
 *
 * От строки держится не больше двух `lineBytes` вокруг совпадения, в ответ идёт окно `lineBytes`:
 * вокруг совпадения, а у короткой строки — она вся. Край окна не режет символ UTF-8. Сверх
 * `totalBytes` сырого вывода — стоп и truncated; начатая запись на этой границе не отдаётся.
 */
export function createGrepParser(limits: { hits: number; files: number; lineBytes?: number; totalBytes?: number }): {
  push(chunk: Buffer): boolean;
  result(): { files: RawGrepFile[]; truncated: boolean };
} {
  const lineBytes = limits.lineBytes ?? GREP_LINE_BYTES;
  const totalBytes = limits.totalBytes ?? GREP_TOTAL_BYTES;
  const files = new Map<string, RawGrepHit[]>();
  let hits = 0;
  let seen = 0;
  let truncated = false;
  let stopped = false;

  // Текущая запись: заголовок, пока не пришли три NUL, затем текст строки.
  let head = Buffer.alloc(0);
  let header: { file: string; line: number; match: number } | null = null;
  let broken = false;
  let pos = 0;
  let units = 0;
  let kept: Buffer[] = [];

  const reset = (): void => {
    head = Buffer.alloc(0);
    header = null;
    broken = false;
    pos = 0;
    units = 0;
    kept = [];
  };

  const feedText = (piece: Buffer, match: number): void => {
    if (pos < match) units += utf16Units(piece.subarray(0, match - pos));
    // Держится [совпадение − lineBytes, совпадение + lineBytes): из него окно выбирается в конце строки.
    const from = Math.max(0, match - lineBytes - pos);
    const to = Math.min(piece.length, match + lineBytes - pos);
    // Копия, а не срез: срез держал бы в памяти весь кусок stdout.
    if (to > from) kept.push(Buffer.from(piece.subarray(from, to)));
    pos += piece.length;
  };

  const feed = (piece: Buffer): void => {
    if (broken) return;
    if (header !== null) {
      feedText(piece, header.match);
      return;
    }
    const before = head.length;
    head = Buffer.concat([head, piece.subarray(0, GREP_HEADER_BYTES - before)]);
    const a = head.indexOf(0);
    const b = a < 0 ? -1 : head.indexOf(0, a + 1);
    const c = b < 0 ? -1 : head.indexOf(0, b + 1);
    if (c < 0) {
      if (head.length >= GREP_HEADER_BYTES) broken = true;
      return;
    }
    const column = Number(head.subarray(b + 1, c).toString('utf8'));
    header = {
      file: head.subarray(0, a).toString('utf8'),
      line: Number(head.subarray(a + 1, b).toString('utf8')),
      match: Number.isInteger(column) && column > 0 ? column - 1 : 0,
    };
    feedText(piece.subarray(c + 1 - before), header.match);
  };

  /** Конец строки: окно в ответ. false — предел файлов или совпадений. */
  const finish = (): boolean => {
    const current = header;
    if (current === null) return true;
    let list = files.get(current.file);
    if (list === undefined) {
      if (files.size >= limits.files) return false;
      list = [];
      files.set(current.file, list);
    }
    if (hits >= limits.hits) return false;
    const length = pos;
    const match = Math.min(current.match, length);
    const keptFrom = Math.max(0, current.match - lineBytes);
    const buffer = Buffer.concat(kept);
    // Совпадение посередине окна; у конца строки окно прижимается к нему, короткая строка — вся.
    let start = Math.max(0, Math.min(match - Math.floor(lineBytes / 2), length - lineBytes));
    let end = Math.min(length, start + lineBytes);
    const byteAt = (i: number): number | undefined => buffer[i - keptFrom];
    if (start > 0) while (start < match && isContinuation(byteAt(start))) start += 1;
    if (end < length) {
      // Последний символ окна не влез целиком — окно кончается перед ним.
      let lead = end - 1;
      while (lead > start && end - lead < 4 && isContinuation(byteAt(lead))) lead -= 1;
      const leadByte = byteAt(lead);
      if (leadByte !== undefined && lead + utf8Length(leadByte) > end) end = lead;
    }
    const text = buffer.subarray(start - keptFrom, end - keptFrom).toString('utf8');
    const at = buffer.subarray(start - keptFrom, Math.max(start, match) - keptFrom).toString('utf8').length;
    list.push({ line: current.line, column: units + 1, text, ranges: [], at });
    hits += 1;
    return true;
  };

  const stop = (): false => {
    stopped = true;
    truncated = true;
    reset();
    return false;
  };

  return {
    push: (chunk) => {
      if (stopped) return false;
      const over = seen + chunk.length > totalBytes;
      const data = over ? chunk.subarray(0, totalBytes - seen) : chunk;
      seen += data.length;
      let start = 0;
      while (start < data.length) {
        const end = data.indexOf(0x0a, start);
        feed(data.subarray(start, end < 0 ? data.length : end));
        if (end < 0) break;
        const ok = finish();
        reset();
        start = end + 1;
        if (!ok) return stop();
      }
      return over ? stop() : true;
    },
    result: () => ({ files: [...files].map(([file, list]) => ({ path: file, hits: list })), truncated }),
  };
}

/** Путь внутри корня по realpath (обе стороны — realpath). */
function insideReal(base: string, real: string): string | null {
  if (real === base) return '';
  return real.startsWith(base + path.sep) ? real.slice(base.length + 1) : null;
}

/**
 * Не-git корень: обход по lstat до 50 000 обычных файлов, без node_modules, .git и каталога состояния; симлинки — правила ниже.
 * Отмена и бюджет времени проверяются на каждом каталоге и у каждой ссылки (у ссылки — realpath и stat,
 * их в одной папке бывают десятки тысяч): огромный корень иначе держал бы пул fs main без предела, а
 * `cancel` и закрытие окна не останавливали бы начатый обход. Корень читается всегда — бюджет 0 даёт
 * его файлы. truncated — остановлен отменой, временем или пределом числа файлов.
 */
export async function walkFiles(
  root: string,
  limit: number,
  options: { signal?: AbortSignal; budgetMs?: number; now?: () => number } = {},
): Promise<{ paths: string[]; truncated: boolean }> {
  const now = options.now ?? Date.now;
  const deadline = options.budgetMs === undefined ? Infinity : now() + options.budgetMs;
  const stopped = (): boolean => options.signal?.aborted === true || now() >= deadline;
  const base = await realpath(root);
  const out: string[] = [];
  const stack = [''];
  let first = true;
  while (stack.length > 0) {
    if (out.length >= limit || (!first && stopped())) return { paths: out, truncated: true };
    first = false;
    const dir = stack.pop() ?? '';
    let entries;
    try {
      // withFileTypes — вид по lstat: в каталоги-симлинки обход не заходит.
      entries = await readdir(path.join(base, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) return { paths: out, truncated: true };
      if (WALK_SKIP.has(entry.name.toLowerCase())) continue;
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile()) out.push(rel);
      else if (entry.isSymbolicLink()) {
        if (stopped()) return { paths: out, truncated: true };
        // Файл-ссылка — только если цель — обычный файл внутри корня и не в `.git` и не в каталоге состояния:
        // ссылка `docs/home → ~` иначе отдала бы окну `~/.aws/credentials`.
        try {
          const real = await realpath(path.join(base, rel));
          const inside = insideReal(base, real);
          if (inside === null || inside.split(path.sep).some((s) => WALK_SKIP.has(s.toLowerCase()))) continue;
          if ((await stat(real)).isFile()) out.push(rel);
        } catch {
          // Висячая ссылка.
        }
      }
      // FIFO, сокеты и устройства — не файлы: пропускаются.
    }
  }
  return { paths: out, truncated: false };
}

/** Одновременных lstat у фильтра ссылок: 50 000 путей — около 0,2 с, пул fs main не забит целиком. */
const LSTAT_CONCURRENCY = 16;

/**
 * Пути `git ls-files` без ссылок, чья цель (realpath) лежит в `.git` или в каталоге состояния корня: pathspec
 * исключает саму папку, но не ссылку на неё, и ⌘P показывал бы `link.json → .parley/…`, которую
 * обход без git уже прячет (раунд fix-7.1b, п.6). Вид берётся с диска (lstat), а не из индекса:
 * у новых файлов режима нет, а отслеживаемый файл агент мог заменить ссылкой.
 */
export async function dropHiddenLinks(root: string, paths: string[]): Promise<string[]> {
  const base = await realpath(root);
  const keep = paths.map(() => true);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) {
      const abs = path.join(base, paths[i] ?? '');
      try {
        if (!(await lstat(abs)).isSymbolicLink()) continue;
        const inside = insideReal(base, await realpath(abs));
        if (inside !== null && inside.split(path.sep).some((s) => s.toLowerCase() === '.git' || STATE_DIRS.includes(s.toLowerCase()))) {
          keep[i] = false;
        }
      } catch {
        // Нет файла или висячая ссылка — как отдал git.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LSTAT_CONCURRENCY, paths.length) }, worker));
  return paths.filter((_p, i) => keep[i]);
}

/** rev для gitShow: HEAD или 7–40 hex, в конце допустим ^. */
export function isSafeRev(rev: string): boolean {
  return rev === 'HEAD' || /^[0-9a-f]{7,40}\^?$/.test(rev);
}

/**
 * Файлы коммита для вкладки диффа (кусок 8.3, спека 11.3): от первого родителя, у корневого — от
 * пустого дерева. Однокоммитный `diff-tree <hash>` у merge-коммита не печатает ничего, а они в ветке
 * ожидаемы («Попросить агента разрешить» велит агенту `git merge <база>`): поэтому двухдеревная
 * форма `<hash>^ <hash>` — те же стороны, что у `loadSides`. `--relative` — пути от папки корня,
 * как у `gitShow`; `-z` — кириллица без кавычек и восьмеричных кодов.
 */
export async function gitCommitFiles(git: GitRunner, rootPath: string, hash: string, flags: string[] = []): Promise<DiffFile[]> {
  // `--output=<файл>` из рендерера иначе заставил бы git писать вне корней.
  if (!isSafeRev(hash)) throw new HostError('bad_request', 'invalid revision');
  const run = (args: string[]): ReturnType<GitRunner['run']> => git.run([...READ_FLAGS, ...flags, ...args], rootPath);
  // `rev-list --parents` одним вызовом: есть ли коммит (код выхода) и его родители («коммит
  // родитель…»). Родитель есть — двухдеревная форма; нет (корневой коммит) — `--root`.
  const listed = await run(['rev-list', '--parents', '-n', '1', '--end-of-options', hash]);
  if (listed.code !== 0) throw new HostError('not_found', `commit not found: ${hash}`);
  const hasParent = listed.stdout.toString('utf8').trim().split(' ').length > 1;
  const sides = hasParent ? ['--end-of-options', `${hash}^`, hash] : ['--root', '--no-commit-id', '--end-of-options', hash];
  const common = ['diff-tree', '-r', '-M', '-z', '--relative', '--no-ext-diff', '--no-textconv'];
  const [status, numstat] = await Promise.all([run([...common, '--name-status', ...sides]), run([...common, '--numstat', ...sides])]);
  if (status.code !== 0 || numstat.code !== 0) {
    // Текст stderr локализован — только в консоль.
    console.warn(`[parley] files: git diff-tree exited with code ${String(status.code)}/${String(numstat.code)}`, status.stderr);
    throw new Error(`git diff-tree exited with code ${String(status.code ?? numstat.code)}`);
  }
  return joinDiffFiles(parseNameStatusZ(status.stdout), parseNumstat(numstat.stdout));
}

/**
 * Понимает ли git этой машины `grep -P` (PCRE; git без libpcre выходит с 128 ещё до поиска).
 * Проба — `--no-index` в пустой временной папке: ни репозиторий человека, ни его файлы не читаются
 * и не пишутся; папка удаляется. Сбой запуска и ENOENT — «нет»: останется ERE.
 */
export async function probePcre(git: GitRunner): Promise<boolean> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'parley-pcre-'));
    const result = await git.run(['grep', '--no-index', '-P', '-e', 'x'], dir);
    return result.code === 0 || result.code === 1;
  } catch {
    return false;
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Воркер с заданием; cancel и предел времени — worker.terminate(), ответ — найденное к этому моменту с truncated. */
export function runGrepWorker(
  job: GrepJob,
  options: { signal: AbortSignal; timeoutMs: number; spawn: () => Worker },
): Promise<GrepResult> {
  return new Promise((resolve, reject) => {
    const done: GrepResult['files'] = [];
    let settled = false;
    const worker = options.spawn();
    const settle = (): void => {
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
      void worker.terminate();
    };
    const finish = (truncated: boolean): void => {
      if (settled) return;
      settle();
      // У `ranges` строки уже найдены git: неподсвеченные уходят с пустыми ranges — и тоже окном:
      // регулярку в main не исполняем, поэтому окно вокруг совпадения по колонке git.
      const rest = job.kind === 'ranges' ? job.files.slice(done.length) : [];
      const files = [
        ...done,
        ...rest.map((file) => ({
          path: file.path,
          hits: file.hits.map((hit) => ({ line: hit.line, column: hit.column, ...clipHit(hit.text, [], hit.at) })),
        })),
      ];
      resolve({ files, truncated });
    };
    const stop = (): void => finish(true);
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal.addEventListener('abort', stop, { once: true });
    worker.on('message', (message: GrepWorkerMessage) => {
      if (message.type === 'file') done.push(message.file);
      else finish(message.truncated);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settle();
      reject(error);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settle();
      reject(new Error(`grep worker exited with code ${code}`));
    });
    if (options.signal.aborted) stop();
    else worker.postMessage(job);
  });
}

export interface GitApi {
  /** truncated — обход не-git корня неполон (предел, время, отмена); список git — всегда полный. */
  lsFiles(root: FileRoot): Promise<FileList>;
  /** signalId — ключ отмены; новый grep с тем же ключом отменяет прежний. */
  grep(root: FileRoot, query: GrepQuery, signalId: string): Promise<GrepResult>;
  cancel(signalId: string): void;
  gitShow(root: FileRoot, rev: string, relPath: string): Promise<TextFile | null>;
  /** Файлы коммита от первого родителя (кусок 8.3). */
  gitCommitFiles(root: FileRoot, hash: string): Promise<DiffFile[]>;
  gitStatus(root: FileRoot): Promise<Record<string, GitStatusLetter>>;
  /** Имена папки dir, которые игнорирует git; не git или сбой — пустой набор. */
  checkIgnored(root: FileRoot, dir: string, names: string[]): Promise<Set<string>>;
  /** Сброс кэша `lsFiles` корня: его `treeChanged` или конец слежения. */
  invalidate(rootKey: string): void;
}

export interface GitApiOptions {
  git: GitRunner;
  roots: Pick<RootsRegistry, 'rootPath'>;
  spawnWorker: () => Worker;
  /** Кэш `lsFiles` — только у корня под слежением дерева: сбросить иначе нечем. */
  isTreeWatched?: (rootKey: string) => boolean;
  grepTimeoutMs?: number;
  /**
   * Бюджет обхода не-git корня (⌘P и поиск); по умолчанию 10 с, как у воркера поиска. Читается
   * на каждом вызове: тест меняет его между вызовами.
   */
  walkBudgetMs?: number;
  /** Предел вывода `gitShow`; по умолчанию 20 МБ. */
  showMaxBytes?: number;
  /** Проба `git grep -P` (раунд fix-7.4, п. 3); по умолчанию `probePcre`. Зовётся не больше раза на api. */
  probePcre?: () => Promise<boolean>;
}

/** Путь для gitShow лексически: относительный, без NUL и `..` после нормализации; на диске его может не быть. */
function lexicalPath(relPath: string): string {
  if (relPath === '' || relPath.includes('\0') || path.posix.isAbsolute(relPath)) {
    throw new HostError('bad_request', 'invalid path');
  }
  const normal = path.posix.normalize(relPath);
  if (normal === '.' || normal === '..' || normal.startsWith('../')) throw new HostError('bad_request', 'invalid path');
  return normal;
}

export function createGitApi(options: GitApiOptions): GitApi {
  const { git, roots } = options;
  const timeoutMs = options.grepTimeoutMs ?? GREP_TIMEOUT_MS;
  const showMaxBytes = options.showMaxBytes ?? LIMITS.openableBytes;
  const lsCache = new Map<string, Promise<FileList>>();
  const signals = new Map<string, AbortController>();
  /**
   * Папки, о сбое `check-ignore` в которых уже сказано: за каталогом-ссылкой git выходит с 128 на
   * каждое раскрытие, и без этого лог main шумел бы на каждом `list`. Растёт не больше числа папок.
   */
  const ignoreWarned = new Set<string>();
  /**
   * Ответ пробы PCRE — один на api, то есть на жизнь main (api создаётся раз): git человека за это
   * время не меняется, а проба — лишний процесс. Спрашивается при первой регулярке на git-корне.
   */
  let pcre: Promise<boolean> | null = null;
  const hasPcre = (): Promise<boolean> => (pcre ??= (options.probePcre ?? (() => probePcre(git)))());

  /**
   * Общий `.git` проекта (realpath) — опора проверки worktree; на путь проекта, пока жив main: это
   * каталог человека, он не переезжает. Сбой не кэшируется.
   */
  const commonDirs = new Map<string, Promise<string | null>>();
  const commonDirOf = (projectPath: string): Promise<string | null> => {
    let found = commonDirs.get(projectPath);
    if (found === undefined) {
      found = projectCommonDir(git, projectPath);
      found.catch(() => commonDirs.delete(projectPath));
      commonDirs.set(projectPath, found);
    }
    return found;
  };
  /** Корни с подменённым `.git`, о которых уже сказано: слежение спрашивает статус раз в 2 с. */
  const corruptWarned = new Set<string>();

  /**
   * git корня: `null` — корень не-git (git нет, папка не под git) или worktree, чей `.git` не ведёт
   * в зарегистрированный worktree проекта (C1, спека 10.8: агент кладёт в копию и файл `.git`) —
   * тогда git в нём не запускается вовсе, окно обходит его без git. Проверка `.git` — на каждый
   * вызов, без кэша: агент подменяет его когда угодно. Прошла — gitdir закреплён
   * `--git-dir`/`--work-tree`, и подмена между проверкой и запуском git уже не касается. `flags` —
   * закрепление и выключенные фильтры (`filterOverrides`), `prefix` — путь корня от корня копии.
   */
  const gitOf = async (root: FileRoot, rootPath: string): Promise<{ rootPath: string; prefix: string; flags: string[] } | null> => {
    let pin: string[] = [];
    if (root.spec.kind === 'worktree') {
      let gitDir: string | null = null;
      try {
        const common = await commonDirOf(await roots.rootPath({ workKey: root.workKey, spec: { kind: 'project' } }));
        if (common !== null) gitDir = await checkoutGitDir(common, rootPath);
      } catch (error) {
        console.warn('[parley] files: worktree check failed', error);
      }
      if (gitDir === null) {
        if (!corruptWarned.has(rootPath)) {
          corruptWarned.add(rootPath);
          console.warn(`[parley] files: ${rootPath}: .git is not a worktree of the project, git is not run there`);
        }
        return null;
      }
      corruptWarned.delete(rootPath);
      pin = ['--git-dir', gitDir, '--work-tree', rootPath];
    }
    const info = await gitRootOf(git, rootPath, pin);
    if (info === null) return null;
    try {
      return { rootPath, prefix: info.prefix, flags: [...pin, ...(await filterOverrides(git, rootPath, pin))] };
    } catch (error) {
      // git пропал из PATH после пробы — как не-git корень.
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  };

  /** Вызов git для корня; git пропал из PATH после пробы — null, как у не-git корня. */
  const read = async (
    args: string[],
    at: { rootPath: string; flags: string[] },
    extra: Parameters<GitRunner['run']>[2] = {},
  ): Promise<Awaited<ReturnType<GitRunner['run']>> | null> => {
    try {
      return await git.run([...READ_FLAGS, ...at.flags, ...args], at.rootPath, extra);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  };

  const walk = (rootPath: string, signal?: AbortSignal): ReturnType<typeof walkFiles> =>
    walkFiles(rootPath, WALK_LIMIT, { budgetMs: options.walkBudgetMs ?? GREP_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });

  /**
   * partial — список неполон из-за бюджета времени: такой не кэшируется, следующий ⌘P обойдёт
   * заново. Предел 50 000 — не partial: повтор дал бы тот же список.
   */
  const listFiles = async (root: FileRoot): Promise<FileList & { partial: boolean }> => {
    const rootPath = await roots.rootPath(root);
    const at = await gitOf(root, rootPath);
    if (at !== null) {
      const result = await read(['ls-files', '-co', '--exclude-standard', '-z', ...PATHSPEC], at);
      if (result !== null && result.code === 0) {
        return { paths: await dropHiddenLinks(rootPath, parseLsFiles(result.stdout)), truncated: false, partial: false };
      }
      console.warn(`[parley] files: git ls-files exited with code ${String(result?.code)}, walking instead`);
    }
    const found = await walk(rootPath);
    return { paths: found.paths, truncated: found.truncated, partial: found.truncated && found.paths.length < WALK_LIMIT };
  };

  const grepIn = async (root: FileRoot, query: GrepQuery, signal: AbortSignal): Promise<GrepResult> => {
    // Неверная регулярка — одинаково на обоих корнях: воркер иначе молча не нашёл бы ничего, а git
    // вышел бы с 128. Сборка RegExp не исполняет её — в main безопасна; прежний поиск уже отменён.
    if (query.regex) {
      try {
        new RegExp(query.text);
      } catch {
        throw new HostError('bad_request', 'invalid regular expression');
      }
    }
    const rootPath = await roots.rootPath(root);
    const walkAndGrep = async (): Promise<GrepResult> => {
      const walked = await walk(rootPath, signal);
      if (signal.aborted) return { files: [], truncated: true };
      // Бюджет обхода исчерпан — ищем в найденном: у воркера свой предел времени.
      const found = await runGrepWorker(
        { kind: 'walk', query, rootPath, paths: walked.paths },
        { signal, timeoutMs, spawn: options.spawnWorker },
      );
      return { files: found.files, truncated: found.truncated || walked.truncated };
    };
    const at = await gitOf(root, rootPath);
    if (at === null) return walkAndGrep();
    // Регулярка — PCRE (-P), если git её умеет: `\d`, `\w`, `\s` тогда работают, как у RegExp
    // не-git корня; иначе ERE (-E), и ответ говорит об этом панели.
    const posix = query.regex && !(await hasPcre());
    const flags = [
      ...(query.caseSensitive ? [] : ['-i']),
      ...(query.wholeWord ? ['-w'] : []),
      query.regex ? (posix ? '-E' : '-P') : '-F',
    ];
    const dialect = posix ? { posixRegex: true as const } : {};
    const parser = createGrepParser(GREP_LIMITS);
    // Запрос — только сразу после -e: иначе `-f/путь/вне/корней` git прочёл бы файлом шаблонов.
    // --column — окно строки вокруг совпадения и курсор на нём (раунд fix-7.4, п. 2).
    const args = ['grep', '-n', '--column', '-I', '--no-color', '--null', ...flags, '--untracked', '-e', query.text, ...PATHSPEC];
    const result = await read(args, at, { signal, onStdout: (chunk) => parser.push(chunk) });
    if (result === null) return walkAndGrep();
    const found = parser.result();
    if (signal.aborted) return { files: found.files, truncated: true, ...dialect };
    // 0 — нашлось, 1 — нет; null — погашен на пределе. Прочее — ошибка git (битая регулярка и т.п.).
    if (result.code !== 0 && result.code !== 1 && !found.truncated) {
      throw new Error(`git grep exited with code ${String(result.code)}`);
    }
    if (found.files.length === 0) return { ...found, ...dialect };
    const ranged = await runGrepWorker(
      { kind: 'ranges', query, files: found.files },
      { signal, timeoutMs, spawn: options.spawnWorker },
    );
    return { files: ranged.files, truncated: found.truncated || ranged.truncated, ...dialect };
  };

  return {
    lsFiles: (root) => {
      const key = rootKey(root);
      const answer = (found: FileList): FileList => ({ paths: found.paths, truncated: found.truncated });
      if (options.isTreeWatched?.(key) !== true) return listFiles(root).then(answer);
      const cached = lsCache.get(key);
      if (cached !== undefined) return cached;
      const listed = listFiles(root);
      const pending = listed.then(answer);
      lsCache.set(key, pending);
      const forget = (): void => {
        if (lsCache.get(key) === pending) lsCache.delete(key);
      };
      listed.then((found) => {
        if (found.partial) forget();
      }, forget);
      return pending;
    },

    grep: async (root, query, signalId) => {
      signals.get(signalId)?.abort();
      const controller = new AbortController();
      signals.set(signalId, controller);
      try {
        return await grepIn(root, query, controller.signal);
      } finally {
        if (signals.get(signalId) === controller) signals.delete(signalId);
      }
    },

    cancel: (signalId) => {
      signals.get(signalId)?.abort();
      signals.delete(signalId);
    },

    gitShow: async (root, rev, relPath) => {
      // `--output=<файл>` из рендерера иначе заставил бы git писать вне корней.
      if (!isSafeRev(rev)) throw new HostError('bad_request', 'invalid revision');
      const normal = lexicalPath(relPath);
      const rootPath = await roots.rootPath(root);
      const at = await gitOf(root, rootPath);
      if (at === null) return null;
      // `./` — путь от cwd, а не от корня репозитория: папка проекта бывает подкаталогом.
      // --no-textconv: сравнение показывает байты блоба, а не вывод фильтра из конфигурации.
      const result = await read(['show', '--no-textconv', '--end-of-options', `${rev}:./${normal}`], at, {
        maxBytes: showMaxBytes,
      });
      if (result === null) return null;
      if (result.truncated) throw new HostError('files:too-large', `blob exceeds ${showMaxBytes} bytes: ${normal}`);
      // Нет файла в ревизии, нет ревизии (`hash^` у корневого коммита) или не git — null.
      if (result.code !== 0) return null;
      const { binary, utf8 } = detectText(result.stdout);
      return {
        text: result.stdout.toString('utf8'),
        mtimeMs: 0,
        size: result.stdout.length,
        binary,
        utf8,
        readOnlyReason: result.stdout.length > LIMITS.editableBytes ? 'too-large' : utf8 ? null : 'not-utf8',
      };
    },

    gitCommitFiles: async (root, hash) => {
      if (!isSafeRev(hash)) throw new HostError('bad_request', 'invalid revision');
      const rootPath = await roots.rootPath(root);
      const at = await gitOf(root, rootPath);
      // Не-git корень или подменённый `.git` — коммита здесь нет, как у отказа `rev-list`.
      if (at === null) throw new HostError('not_found', `commit not found: ${hash}`);
      return gitCommitFiles(git, rootPath, hash, at.flags);
    },

    gitStatus: async (root) => {
      const rootPath = await roots.rootPath(root);
      const info = await gitOf(root, rootPath);
      if (info === null) return {};
      // -uall: новая папка иначе пришла бы одной строкой `?? dir/`, без U у файлов.
      const result = await read(['status', '--porcelain=v1', '-z', '-uall', NO_SUBMODULE_WALK, ...PATHSPEC], info);
      if (result === null) return {};
      if (result.code !== 0) {
        console.warn(`[parley] files: git status exited with code ${String(result.code)}`);
        return {};
      }
      return parseGitStatus(result.stdout, info.prefix);
    },

    checkIgnored: async (root, dir, names) => {
      if (names.length === 0) return new Set();
      const rootPath = await roots.rootPath(root);
      const rels = names.map((name) => path.posix.join(dir, name));
      let result: Awaited<ReturnType<GitRunner['run']>> | null;
      try {
        const at = await gitOf(root, rootPath);
        if (at === null) return new Set();
        result = await read(['check-ignore', '--stdin', '-z'], at, { stdin: Buffer.from(`${rels.join('\0')}\0`) });
      } catch (error) {
        console.warn('[parley] files: git check-ignore failed', error);
        return new Set();
      }
      if (result === null) return new Set();
      // Выход 1 — «ничего не игнорируется», не ошибка.
      if (result.code === 1) return new Set();
      if (result.code !== 0) {
        const key = `${rootPath}\0${dir}`;
        if (!ignoreWarned.has(key)) {
          ignoreWarned.add(key);
          console.warn(`[parley] files: git check-ignore exited with code ${String(result.code)} in ${dir || '.'}`);
        }
        return new Set();
      }
      const ignored = new Set(parseLsFiles(result.stdout));
      return new Set(names.filter((_name, i) => ignored.has(rels[i] ?? '')));
    },

    invalidate: (key) => {
      lsCache.delete(key);
    },
  };
}
