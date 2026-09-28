/**
 * Git и поиск файлового API main (спека 10.1–10.3, 10.7, 10.8, 13; кусок 7.1b):
 * `lsFiles` для ⌘P, `grep` для ⌘⇧F, `gitStatus` и `checkIgnored` для дерева, `gitShow`
 * для сравнения. Git у человека локализован: причины решаются только по коду выхода и
 * `ENOENT`, текст stderr не разбирается. Не-git корень (git нет в PATH login-shell или
 * папка не под git) работает обходом `walkFiles` и поиском в воркере.
 */
import { spawn } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { FileList, FileRoot, GitStatusLetter, GrepQuery, GrepResult, TextFile } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { HostError } from '../host-connection.js';
import type { RootsRegistry } from '../roots.js';
import { detectText, LIMITS } from './fs-api.js';
import { clipHit, GREP_LIMITS, type GrepJob, type GrepWorkerMessage } from './grep-worker.js';

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
/** `.harnas/` проекта — карты, почта и журналы core: ни ⌘P, ни поиска, ни статуса (спека 10.1). */
const PATHSPEC = ['--', '.', ':(exclude).harnas'];
/** Обход не-git корня: до 50 000 файлов (таблица чисел). */
export const WALK_LIMIT = 50_000;
/** Предел воркера поиска (план). */
export const GREP_TIMEOUT_MS = 10_000;
/** stderr git нужен только для консоли — дальше не копим. */
const STDERR_LIMIT = 64 * 1024;
/** Каталоги, в которые обход не заходит: зависимости, git и карты core. */
const WALK_SKIP = new Set(['node_modules', '.git', '.harnas']);

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

export function createGitRunner(env: NodeJS.ProcessEnv): GitRunner {
  return {
    run: (args, cwd, options = {}) =>
      new Promise((resolve, reject) => {
        const { signal, maxBytes, onStdout, stdin } = options;
        const child = spawn('git', args, { cwd, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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

/** git rev-parse --show-prefix в cwd = rootPath; кэш на корень. null — не git: ENOENT или ненулевой выход. */
export async function gitRootOf(git: GitRunner, rootPath: string): Promise<{ prefix: string } | null> {
  let cache = rootCache.get(git);
  if (cache === undefined) {
    cache = new Map();
    rootCache.set(git, cache);
  }
  const key = await realpath(rootPath).catch(() => rootPath);
  if (cache.has(key)) return cache.get(key) ?? null;
  let answer: { prefix: string } | null;
  try {
    const result = await git.run(['rev-parse', '--show-prefix'], key);
    answer = result.code === 0 ? { prefix: result.stdout.toString('utf8').replace(/\n$/, '') } : null;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      // Сбой запуска (EAGAIN и т.п.) — не ответ про корень: не кэшируем.
      console.warn('[harnas] files: git rev-parse failed', error);
      return null;
    }
    answer = null;
  }
  cache.set(key, answer);
  return answer;
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

/** Разбор вывода git grep --null -n кусками; push → false на пределе. ranges пустые — их считает воркер. */
export function createGrepParser(limits: { hits: number; files: number }): {
  push(chunk: Buffer): boolean;
  result(): GrepResult;
} {
  const files = new Map<string, GrepResult['files'][number]['hits']>();
  let hits = 0;
  let truncated = false;
  let stopped = false;
  let tail = Buffer.alloc(0);

  const take = (record: Buffer): boolean => {
    const a = record.indexOf(0);
    const b = a < 0 ? -1 : record.indexOf(0, a + 1);
    if (b < 0) return true;
    const file = record.subarray(0, a).toString('utf8');
    const line = Number(record.subarray(a + 1, b).toString('utf8'));
    let list = files.get(file);
    if (list === undefined) {
      if (files.size >= limits.files) return false;
      list = [];
      files.set(file, list);
    }
    if (hits >= limits.hits) return false;
    list.push({ line, text: record.subarray(b + 1).toString('utf8'), ranges: [] });
    hits += 1;
    return true;
  };

  return {
    push: (chunk) => {
      if (stopped) return false;
      const buffer = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
      let start = 0;
      for (let end = buffer.indexOf(0x0a, start); end >= 0; end = buffer.indexOf(0x0a, start)) {
        const ok = take(buffer.subarray(start, end));
        start = end + 1;
        if (!ok) {
          stopped = true;
          truncated = true;
          tail = Buffer.alloc(0);
          return false;
        }
      }
      tail = Buffer.from(buffer.subarray(start));
      return true;
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
 * Не-git корень: обход по lstat до 50 000 обычных файлов, без node_modules, .git и .harnas; симлинки — правила ниже.
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
        // Файл-ссылка — только если цель — обычный файл внутри корня и не в `.git`/`.harnas`:
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
 * Пути `git ls-files` без ссылок, чья цель (realpath) лежит в `.git` или `.harnas` корня: pathspec
 * исключает саму папку, но не ссылку на неё, и ⌘P показывал бы `link.json → .harnas/…`, которую
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
        if (inside !== null && inside.split(path.sep).some((s) => s.toLowerCase() === '.git' || s.toLowerCase() === '.harnas')) {
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
      // регулярку в main не исполняем, поэтому окно с начала строки.
      const rest = job.kind === 'ranges' ? job.files.slice(done.length) : [];
      const files = [
        ...done,
        ...rest.map((file) => ({ path: file.path, hits: file.hits.map((hit) => ({ ...hit, ...clipHit(hit.text, []) })) })),
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

  /** Вызов git для корня; git пропал из PATH после пробы — null, как у не-git корня. */
  const read = async (
    args: string[],
    cwd: string,
    extra: Parameters<GitRunner['run']>[2] = {},
  ): Promise<Awaited<ReturnType<GitRunner['run']>> | null> => {
    try {
      return await git.run([...READ_FLAGS, ...args], cwd, extra);
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
    const rootPath = roots.rootPath(root);
    if ((await gitRootOf(git, rootPath)) !== null) {
      const result = await read(['ls-files', '-co', '--exclude-standard', '-z', ...PATHSPEC], rootPath);
      if (result !== null && result.code === 0) {
        return { paths: await dropHiddenLinks(rootPath, parseLsFiles(result.stdout)), truncated: false, partial: false };
      }
      console.warn(`[harnas] files: git ls-files exited with code ${String(result?.code)}, walking instead`);
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
    const rootPath = roots.rootPath(root);
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
    if ((await gitRootOf(git, rootPath)) === null) return walkAndGrep();
    const flags = [
      ...(query.caseSensitive ? [] : ['-i']),
      ...(query.wholeWord ? ['-w'] : []),
      query.regex ? '-E' : '-F',
    ];
    const parser = createGrepParser(GREP_LIMITS);
    // Запрос — только сразу после -e: иначе `-f/путь/вне/корней` git прочёл бы файлом шаблонов.
    const args = ['grep', '-n', '-I', '--no-color', '--null', ...flags, '--untracked', '-e', query.text, ...PATHSPEC];
    const result = await read(args, rootPath, { signal, onStdout: (chunk) => parser.push(chunk) });
    if (result === null) return walkAndGrep();
    const found = parser.result();
    if (signal.aborted) return { files: found.files, truncated: true };
    // 0 — нашлось, 1 — нет; null — погашен на пределе. Прочее — ошибка git (битая регулярка и т.п.).
    if (result.code !== 0 && result.code !== 1 && !found.truncated) {
      throw new Error(`git grep exited with code ${String(result.code)}`);
    }
    if (found.files.length === 0) return found;
    const ranged = await runGrepWorker(
      { kind: 'ranges', query, files: found.files },
      { signal, timeoutMs, spawn: options.spawnWorker },
    );
    return { files: ranged.files, truncated: found.truncated || ranged.truncated };
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
      const rootPath = roots.rootPath(root);
      // `./` — путь от cwd, а не от корня репозитория: папка проекта бывает подкаталогом.
      // --no-textconv: сравнение показывает байты блоба, а не вывод фильтра из конфигурации.
      const result = await read(['show', '--no-textconv', '--end-of-options', `${rev}:./${normal}`], rootPath, {
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

    gitStatus: async (root) => {
      const rootPath = roots.rootPath(root);
      const info = await gitRootOf(git, rootPath);
      if (info === null) return {};
      // -uall: новая папка иначе пришла бы одной строкой `?? dir/`, без U у файлов.
      const result = await read(['status', '--porcelain=v1', '-z', '-uall', ...PATHSPEC], rootPath);
      if (result === null) return {};
      if (result.code !== 0) {
        console.warn(`[harnas] files: git status exited with code ${String(result.code)}`);
        return {};
      }
      return parseGitStatus(result.stdout, info.prefix);
    },

    checkIgnored: async (root, dir, names) => {
      if (names.length === 0) return new Set();
      const rootPath = roots.rootPath(root);
      if ((await gitRootOf(git, rootPath)) === null) return new Set();
      const rels = names.map((name) => path.posix.join(dir, name));
      let result: Awaited<ReturnType<GitRunner['run']>> | null;
      try {
        result = await read(['check-ignore', '--stdin', '-z'], rootPath, { stdin: Buffer.from(`${rels.join('\0')}\0`) });
      } catch (error) {
        console.warn('[harnas] files: git check-ignore failed', error);
        return new Set();
      }
      if (result === null) return new Set();
      // Выход 1 — «ничего не игнорируется», не ошибка.
      if (result.code === 1) return new Set();
      if (result.code !== 0) {
        const key = `${rootPath}\0${dir}`;
        if (!ignoreWarned.has(key)) {
          ignoreWarned.add(key);
          console.warn(`[harnas] files: git check-ignore exited with code ${String(result.code)} in ${dir || '.'}`);
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
