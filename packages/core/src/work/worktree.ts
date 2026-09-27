/**
 * Worktree сессии — своя рабочая копия git поверх той же истории (спецификация
 * 8.1, 8.2). Все функции здесь — чистые обёртки над git CLI: сам процесс
 * запуска и хранение планов в карте живут в `launch.ts` и `mcp/tools.ts`, а
 * создание worktree перед стартом — в хосте (кусок 4.2).
 *
 * Команды всегда идут через `execFile` с массивом аргументов, без `shell:
 * true` — путь проекта или ветки с пробелом иначе ломал бы команду молча.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeInfo } from './types.js';

const run = promisify(execFile);

/** Сколько знаков хэша пути проекта идёт в имя каталога — как короткий git-хэш. */
const HASH_LENGTH = 6;

/** `~` и `~/…` раскрываются в домашнюю папку; произвольный путь остаётся как есть. */
function expandRoot(root: string): string {
  if (root === '~') return homedir();
  if (root.startsWith('~/') || root.startsWith(`~${path.sep}`)) {
    return path.join(homedir(), root.slice(2));
  }
  return root;
}

/**
 * План worktree: путь `<root>/<имя проекта>-<хеш6>/<workId>-<sessionId>`, ветка
 * `harnas/<workId>/<sessionId>` (спецификация 8.1). Хеш от полного пути проекта
 * защищает от коллизий одноимённых проектов в разных каталогах.
 */
export function plannedWorktree(
  projectPath: string,
  workId: string,
  sessionId: string,
  base: string,
  root: string,
): WorktreeInfo {
  const hash = createHash('sha1').update(projectPath).digest('hex').slice(0, HASH_LENGTH);
  const projectDir = `${path.basename(projectPath)}-${hash}`;
  return {
    path: path.join(expandRoot(root), projectDir, `${workId}-${sessionId}`),
    branch: `harnas/${workId}/${sessionId}`,
    base,
    createdAt: null,
  };
}

/** Проект (или его подкаталог) внутри рабочего дерева git — не голый и не отсутствующий репозиторий. */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Ветка каталога; при отсоединённой голове ветки нет — берём SHA коммита,
 * чтобы worktree всё равно мог отвестись от чего-то конкретного.
 */
export async function baseBranchOf(checkoutPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', checkoutPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  if (branch !== 'HEAD') return branch;
  return (await run('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'])).stdout.trim();
}

/**
 * Заводит worktree на диске: каталог создаёт сама команда, родителя — на всякий случай мы.
 * База и ветка — из карты (база бывает веткой родителя): проверка до git и до
 * mkdir, `--end-of-options` — чтобы база вида `--upload-pack=…` не стала флагом.
 */
export async function createWorktree(projectPath: string, info: WorktreeInfo): Promise<void> {
  await assertRevisions(projectPath, [info.base, info.branch]);
  await mkdir(path.dirname(info.path), { recursive: true });
  await run('git', [
    '-C',
    projectPath,
    'worktree',
    'add',
    '-b',
    info.branch,
    '--end-of-options',
    info.path,
    info.base,
  ]);
}

export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  /** Прежний путь у переименования; у прочих — `null`. */
  oldPath: string | null;
  /** `null` — двоичный файл (numstat отдаёт `-`). */
  additions: number | null;
  deletions: number | null;
}

export interface BranchCommit {
  hash: string;
  subject: string;
  author: string;
  /** Время автора, ISO 8601 (`%aI`). */
  at: string;
}

/** Сколько коммитов ветки отдаёт дифф — окну хватает, а лог длинной ветки не раздувает ответ. */
const MAX_COMMITS = 200;

/** Сколько `git diff --no-index` по неотслеживаемым идёт одновременно: сотня новых файлов не порождает сотню процессов разом. */
const UNTRACKED_CONCURRENCY = 8;

/** Предел вывода git: у `execFile` по умолчанию 1 МБ, а патч с lock-файлами больше. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Каталог состояния харнесса в папке проекта (карта, журналы, письма) — не изменения проекта. */
const HARNAS_PATHSPEC = ['--', '.', ':(exclude).harnas'];

/**
 * В worktree своего `.harnas/` по спеке нет, но агент с cwd в worktree может его
 * завести — это не работа ветки. Глоб на любой глубине: префикс проекта-подкаталога
 * не нужен, и `add` с таким исключением не выходит с кодом 1 при `.harnas/` в
 * `.gitignore` (проба на git 2.53) — в отличие от `:(exclude).harnas`.
 */
const WORKTREE_PATHSPEC = ['--', '.', ':(exclude,glob)**/.harnas/**'];

type NumstatEntry = { path: string; oldPath: string | null; additions: number | null; deletions: number | null };
type NameStatusEntry = { path: string; oldPath: string | null; status: DiffFile['status'] };

/**
 * Поля вывода `-z`. Байт NUL не встречается внутри многобайтовых символов
 * UTF-8, поэтому режем уже раскодированную строку.
 */
function zFields(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const fields = text.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  return fields;
}

function count(value: string): number | null {
  return value === '-' ? null : Number(value);
}

/** --numstat -z: у R и у --no-index путь — второй из пары (первый у --no-index — /dev/null). */
export function parseNumstat(raw: Buffer): NumstatEntry[] {
  const fields = zFields(raw);
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const [added = '', deleted = '', ...rest] = (fields[i] ?? '').split('\t');
    const inline = rest.join('\t');
    const additions = count(added);
    const deletions = count(deleted);
    if (inline !== '') {
      entries.push({ path: inline, oldPath: null, additions, deletions });
      continue;
    }
    // Двухпутевая запись: пустой путь в строке чисел, затем «старый\0новый\0».
    const from = fields[i + 1] ?? '';
    const to = fields[i + 2] ?? '';
    i += 2;
    entries.push({ path: to, oldPath: from === '/dev/null' ? null : from, additions, deletions });
  }
  return entries;
}

/** `--name-status -z -M`: статус и старый путь; с parseNumstat собирает DiffFile — ими же пользуется files.gitCommitFiles (8.3). */
export function parseNameStatusZ(raw: Buffer): NameStatusEntry[] {
  const fields = zFields(raw);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const letter = (fields[i] ?? '')[0] ?? '';
    if (letter === 'R' || letter === 'C') {
      const from = fields[i + 1] ?? '';
      const to = fields[i + 2] ?? '';
      i += 2;
      entries.push({ path: to, oldPath: from, status: 'R' });
      continue;
    }
    const filePath = fields[i + 1] ?? '';
    i += 1;
    const status: DiffFile['status'] = letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M';
    entries.push({ path: filePath, oldPath: null, status });
  }
  return entries;
}

/** `status --porcelain=v1 -z`: пути записей; у R и C старый путь — следующее поле без XY, пропускается. */
export function parsePorcelainPaths(raw: Buffer): string[] {
  const fields = zFields(raw);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] ?? '';
    const x = entry[0];
    const y = entry[1];
    paths.push(entry.slice(3));
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
  }
  return paths;
}

/** Статус и старый путь — из name-status, числа — из numstat того же пути. */
export function joinDiffFiles(status: NameStatusEntry[], numstat: NumstatEntry[]): DiffFile[] {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]));
  return status.map((entry) => {
    const numbers = counts.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      oldPath: entry.oldPath,
      additions: numbers?.additions ?? null,
      deletions: numbers?.deletions ?? null,
    };
  });
}

/** `--format=%H%x00%s%x00%an%x00%aI`, записи через \n. */
export function parseCommits(raw: string): BranchCommit[] {
  const commits: BranchCommit[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const [hash = '', subject = '', author = '', at = ''] = line.split('\0');
    commits.push({ hash, subject, author, at });
  }
  return commits;
}

export type MergeCheck =
  | { status: 'clean' }
  | { status: 'conflicts'; files: string[] }
  | { status: 'unsupported' };

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Код и stdout `git merge-tree --write-tree --name-only --no-messages -z`: 0 и id дерева первым полем — clean;
 * 1 и id дерева — conflicts (поля после id, без пустых и дублей). Прочее, в том числе код 1 без id дерева
 * (ветки нет) и 129, — null: mergeCheck бросает ошибку. 129 — любой сбой разбора параметров, не только
 * «git старше 2.38»: старый git mergeCheck распознаёт пробой версии до вызова.
 */
export function parseMergeTree(code: number, stdout: string): MergeCheck | null {
  const [tree = '', ...rest] = zFields(stdout);
  if (!OBJECT_ID.test(tree)) return null;
  if (code === 0) return { status: 'clean' };
  if (code === 1) return { status: 'conflicts', files: [...new Set(rest.filter((field) => field !== ''))] };
  return null;
}

export type GitStateReason = 'git-missing' | 'not-a-repo' | 'no-commits';

/** Отказ функций ниже, когда причина — состояние git папки; сообщение — для консоли. */
export class GitStateError extends Error {
  readonly reason: GitStateReason;

  constructor(reason: GitStateReason, message: string) {
    super(message);
    this.name = 'GitStateError';
    this.reason = reason;
  }
}

/** Изменён только .harnas/ или ничего: commitProject не коммитит, хост отвечает conflict. */
export class NothingToCommitError extends Error {}

/** База или ветка из параметров — не имя ревизии (флаг, диапазон, мусор из карты): git с ней не вызывается. */
export class InvalidRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRevisionError';
  }
}

/**
 * `base`/`branch` приходят из `map.json` внутри проекта — его может переписать
 * агент. Ведущий `-` отсекаем без git: `check-ref-format` принял бы его за
 * свой флаг. Остальное — правилами имён веток git; SHA отсоединённой головы
 * (`baseBranchOf`) им тоже удовлетворяет, диапазон `a..b` — нет.
 */
async function assertRevisions(projectPath: string, revisions: string[]): Promise<void> {
  for (const revision of revisions) {
    if (revision === '' || revision.startsWith('-')) {
      throw new InvalidRevisionError(`не имя ревизии: ${JSON.stringify(revision)}`);
    }
    const { code } = await exitCode(['-C', projectPath, 'check-ref-format', '--branch', revision]);
    if (code !== 0) throw new InvalidRevisionError(`не имя ревизии: ${JSON.stringify(revision)}`);
  }
}

/** `merge-tree --write-tree` — с git 2.38. */
const MERGE_TREE_MIN: [number, number] = [2, 38];

/**
 * Проба версии по PATH: тесты подменяют git через PATH. Отказ пробы (git
 * нет) не кешируется — его разберёт `withGitState`. Строку `git version X.Y`
 * git не переводит.
 */
const mergeTreeSupport = new Map<string, Promise<boolean>>();

function supportsMergeTree(): Promise<boolean> {
  const key = process.env.PATH ?? '';
  let probe = mergeTreeSupport.get(key);
  if (probe === undefined) {
    probe = run('git', ['--version']).then(({ stdout }) => {
      const match = /(\d+)\.(\d+)/.exec(stdout);
      if (match === null) throw new Error(`git --version: ${stdout.trim()}`);
      const [major, minor] = [Number(match[1]), Number(match[2])];
      return major > MERGE_TREE_MIN[0] || (major === MERGE_TREE_MIN[0] && minor >= MERGE_TREE_MIN[1]);
    });
    probe.catch(() => mergeTreeSupport.delete(key));
    mergeTreeSupport.set(key, probe);
  }
  return probe;
}

function isSpawnMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Причина отказа git-вызова без разбора stderr (у человека git локализован): ENOENT запуска — git-missing;
 * `rev-parse --is-inside-work-tree` в projectPath не true — not-a-repo; `rev-parse --verify -q HEAD` не
 * прошёл — no-commits; иначе null — отказ по другой причине, он и бросается.
 */
export async function gitStateReason(projectPath: string, error: unknown): Promise<GitStateReason | null> {
  if (isSpawnMissing(error)) return 'git-missing';
  try {
    const { stdout } = await run('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') return 'not-a-repo';
  } catch (probeError) {
    return isSpawnMissing(probeError) ? 'git-missing' : 'not-a-repo';
  }
  try {
    await run('git', ['-C', projectPath, 'rev-parse', '--verify', '-q', 'HEAD']);
  } catch (probeError) {
    return isSpawnMissing(probeError) ? 'git-missing' : 'no-commits';
  }
  return null;
}

/** Отказ git → GitStateError с причиной, если она в состоянии папки; иначе исходная ошибка. */
async function withGitState<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof NothingToCommitError || error instanceof InvalidRevisionError) throw error;
    const reason = await gitStateReason(projectPath, error);
    if (reason === null) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GitStateError(reason, `git в ${projectPath}: ${reason} (${message})`);
  }
}

/**
 * Чтение git: фоновые `status` и `diff` раз в 2 с не берут `index.lock` рядом с
 * агентом и человеком и не переписывают индекс. `--no-optional-locks` гасит
 * это у `status`, но не у `git diff` против рабочего дерева: тот, найдя файл с
 * одним лишь сдвинутым mtime, сам освежает индекс (`diff.autoRefreshIndex`,
 * проба на git 2.53). Выключаем и это — такой файл name-status тогда
 * показывает изменённым, а numstat нет; `workingTreeFiles` его отбрасывает.
 */
const READ_FLAGS = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false'];

async function readGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...READ_FLAGS, '-C', cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

async function readGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run('git', [...READ_FLAGS, '-C', cwd, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Код выхода и stdout без броска: у `--no-index` и `merge-tree` код 1 — ответ, а не сбой. */
async function gitWithCode(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return exitCode([...READ_FLAGS, '-C', cwd, ...args]);
}

async function exitCode(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    return { code: 0, stdout: (await run('git', args, { maxBuffer: MAX_BUFFER })).stdout };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (typeof failed.code === 'number' && typeof failed.stdout === 'string') {
      return { code: failed.code, stdout: failed.stdout };
    }
    throw error;
  }
}

/** `map` с ограничением одновременных вызовов; порядок результатов — порядок входа. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Неотслеживаемые файлы от `cwd`; `pathspec` — у `changes.*` без `.harnas/`. */
async function untrackedFiles(cwd: string, pathspec: string[] = []): Promise<string[]> {
  return zFields(await readGitBuffer(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]));
}

/**
 * Числа неотслеживаемого файла — `git diff --no-index` от пустоты, а не
 * `git add -N`: чтение индекс не трогает. Код 1 — «отличаются», не сбой.
 */
async function untrackedCounts(cwd: string, filePath: string): Promise<DiffFile> {
  const { code, stdout } = await gitWithCode(cwd, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', filePath]);
  if (code !== 0 && code !== 1) throw new Error(`git diff --no-index ${filePath}: код ${code}`);
  const entry = parseNumstat(Buffer.from(stdout, 'utf8'))[0];
  // Пустой новый файл: отличий от /dev/null нет, записи нет.
  return {
    path: filePath,
    status: 'A',
    oldPath: null,
    additions: entry === undefined ? 0 : entry.additions,
    deletions: entry === undefined ? 0 : entry.deletions,
  };
}

/**
 * Файлы сравнения `against` с рабочим деревом `cwd` плюс неотслеживаемые:
 * список и числа — по одной паре сторон.
 */
async function workingTreeFiles(cwd: string, diffArgs: string[], untracked: string[]): Promise<DiffFile[]> {
  const [status, numstat] = await Promise.all([
    readGitBuffer(cwd, ['diff', '-M', '--name-status', '-z', ...diffArgs]),
    readGitBuffer(cwd, ['diff', '-M', '--numstat', '-z', ...diffArgs]),
  ]);
  const counts = parseNumstat(numstat);
  // Без пары в numstat — только сдвинутый stat без правки содержимого (см. READ_FLAGS).
  const counted = new Set(counts.map((entry) => entry.path));
  const changed = parseNameStatusZ(status).filter((entry) => counted.has(entry.path));
  const tracked = joinDiffFiles(changed, counts);
  const fresh = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) => untrackedCounts(cwd, filePath));
  return [...tracked, ...fresh];
}

function sumStats(files: DiffFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { additions, deletions };
}

interface WorktreeListEntry {
  path: string;
  /** Имя ветки без `refs/heads/`; `null` — отсоединённая голова. */
  branch: string | null;
  head: string;
}

/** `git worktree list --porcelain`: все рабочие копии одного репозитория, включая основную. */
async function listWorktrees(projectPath: string): Promise<WorktreeListEntry[]> {
  const { stdout } = await run('git', ['-C', projectPath, 'worktree', 'list', '--porcelain']);
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: '' };
    } else if (line.startsWith('HEAD ') && current !== null) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current !== null) {
      const ref = line.slice('branch '.length);
      const match = /^refs\/heads\/(.+)$/.exec(ref);
      current.branch = match?.[1] ?? ref;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

/**
 * Содержимое untracked-файла как diff от пустоты. `git diff` без явного индекса
 * (`--no-index`) untracked-файлы не трогает вовсе — обычный `git add` перед
 * диффом пометил бы файл подготовленным для не подозревающего об этом коммита
 * следом, а этого делать нельзя (только чтение). Код выхода 1 у `--no-index` —
 * «файлы отличаются», не сбой; `execFile` иначе принял бы его за ошибку.
 */
async function untrackedPatch(cwd: string, filePath: string): Promise<string> {
  const { code, stdout } = await gitWithCode(cwd, ['diff', '--no-index', '--', '/dev/null', filePath]);
  if (code !== 0 && code !== 1) throw new Error(`git diff --no-index ${filePath}: код ${code}`);
  return stdout;
}

/** Где выгружена ветка `base` — основной каталог или чужой worktree; `null` — нигде. */
async function findBaseCheckout(projectPath: string, base: string): Promise<string | null> {
  const entries = await listWorktrees(projectPath);
  const match = entries.find((entry) => entry.branch === base || entry.head === base);
  return match?.path ?? null;
}

/**
 * Путь папки проекта от корня рабочей копии (`sub/` или пусто): у
 * проекта-подкаталога `.harnas/` лежит в `<sub>/.harnas`, а `isDirty` смотрит
 * от корня чекаута.
 */
async function projectPrefix(projectPath: string): Promise<string> {
  return (await readGit(projectPath, ['rev-parse', '--show-prefix'])).trim();
}

/**
 * Есть ли незакоммиченное в каталоге, не считая `.harnas/` проекта — там сам
 * гарнес хранит своё состояние прямо внутри проекта, и без `.gitignore` на этот
 * каталог `git status` в нём всегда грязный: `base_dirty` тогда получали бы
 * всегда и слияние никогда бы не проходило. `prefix` — путь проекта от корня
 * рабочей копии (`projectPrefix`). Синтаксис exclude-пасспеки работает с git 1.9.
 */
async function isDirty(checkoutPath: string, prefix: string): Promise<boolean> {
  const stdout = await readGit(checkoutPath, ['status', '--porcelain', '--', '.', `:(exclude)${prefix}.harnas`]);
  return stdout.trim() !== '';
}

export interface WorktreeDiff {
  /** Коммиты ветки от общего предка с базой, плюс незакоммиченное поверх них; `''` при `patch: false`. */
  patch: string;
  /** Сравнение общего предка с рабочим деревом worktree плюс неотслеживаемые. */
  files: DiffFile[];
  uncommitted: boolean;
  /** Каталог, где сейчас выгружена ветка `base`; `null` — нигде. */
  baseCheckout: string | null;
  baseDirty: boolean;
  /** Общий предок ветки и базы. */
  mergeBase: string;
  /** Сумма чисел `files` без двоичных. */
  stats: { additions: number; deletions: number };
  /** `git log mergeBase..branch`, свежие первыми, не больше 200. */
  commits: BranchCommit[];
  /** Пути с незакоммиченным в рабочем дереве worktree (porcelain -z, у R — новый путь): секция «Незакоммиченные». */
  uncommittedPaths: string[];
}

/**
 * Дифф worktree относительно базы: история ветки от общего предка плюс то, что
 * в рабочем дереве ещё не закоммичено (спецификация 8.2; этап 8, спека 11.5).
 * Всё — в `info.path`, кроме `merge-base` и `log` (они — в `projectPath`).
 */
export async function worktreeDiff(
  projectPath: string,
  info: WorktreeInfo,
  options: { patch?: boolean } = {},
): Promise<WorktreeDiff> {
  return withGitState(projectPath, async () => {
    await assertRevisions(projectPath, [info.base, info.branch]);
    const mergeBase = (
      await readGit(projectPath, ['merge-base', '--end-of-options', info.base, info.branch])
    ).trim();

    // Список и числа — одной парой сторон: общий предок против рабочего дерева.
    const untracked = await untrackedFiles(info.path, WORKTREE_PATHSPEC);
    const files = await workingTreeFiles(info.path, [mergeBase, ...WORKTREE_PATHSPEC], untracked);

    const uncommittedPaths = parsePorcelainPaths(
      await readGitBuffer(info.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        ...WORKTREE_PATHSPEC,
      ]),
    );

    const commits = parseCommits(
      await readGit(projectPath, [
        'log',
        '-n',
        String(MAX_COMMITS),
        '--format=%H%x00%s%x00%an%x00%aI',
        '--end-of-options',
        `${mergeBase}..${info.branch}`,
      ]),
    );

    const baseCheckout = await findBaseCheckout(projectPath, info.base);
    const baseDirty =
      baseCheckout === null ? false : await isDirty(baseCheckout, await projectPrefix(projectPath));

    let patch = '';
    if (options.patch !== false) {
      const committedPatch = await readGit(projectPath, [
        'diff',
        '--end-of-options',
        `${mergeBase}..${info.branch}`,
      ]);
      const uncommittedPatch =
        uncommittedPaths.length === 0 ? '' : await readGit(info.path, ['diff', 'HEAD', ...WORKTREE_PATHSPEC]);
      // `git diff HEAD` untracked-файлы не показывает вовсе (их нет в индексе,
      // сравнивать нечего) — их содержимое дифф от пустоты добирает отдельно, файл
      // за файлом, не трогая сам индекс (EXTRA, кусок 4.2).
      const untrackedPatches = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) =>
        untrackedPatch(info.path, filePath),
      );
      patch = `${committedPatch}${uncommittedPatch}${untrackedPatches.join('')}`;
    }

    return {
      patch,
      files,
      uncommitted: uncommittedPaths.length > 0,
      baseCheckout,
      baseDirty,
      mergeBase,
      stats: sumStats(files),
      commits,
      uncommittedPaths,
    };
  });
}

/**
 * Будут ли конфликты у слияния ветки в базу — без касания рабочих копий:
 * `merge-tree --write-tree` сливает в объектах, не в чекауте.
 */
export async function mergeCheck(projectPath: string, info: WorktreeInfo): Promise<MergeCheck> {
  return withGitState(projectPath, async () => {
    await assertRevisions(projectPath, [info.base, info.branch]);
    // Старый git — по версии, не по коду 129: тот же код дал бы и флаг вместо ветки.
    if (!(await supportsMergeTree())) return { status: 'unsupported' };
    const { code, stdout } = await gitWithCode(projectPath, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      '--end-of-options',
      info.base,
      info.branch,
    ]);
    const result = parseMergeTree(code, stdout);
    // Код 1 без id дерева — ветки нет (база переименована): не «конфликт без файлов».
    if (result === null) throw new Error(`git merge-tree ${info.base} ${info.branch}: код ${code}`);
    return result;
  });
}

export interface ProjectChanges {
  /** `''` при `patch: false`. */
  patch: string;
  files: DiffFile[];
  stats: { additions: number; deletions: number };
  /** Текущая ветка папки проекта; `null` — отсоединённая голова. */
  branch: string | null;
}

/**
 * Изменения папки проекта против HEAD — для сессии без своего worktree (спека
 * 11.5). `--relative` даёт пути от папки проекта: она может быть подкаталогом
 * репозитория. `.harnas/` не входит — это состояние харнесса.
 */
export async function projectChanges(
  projectPath: string,
  options: { patch?: boolean } = {},
): Promise<ProjectChanges> {
  return withGitState(projectPath, async () => {
    const untracked = await untrackedFiles(projectPath, HARNAS_PATHSPEC);
    const files = await workingTreeFiles(projectPath, ['--relative', 'HEAD', ...HARNAS_PATHSPEC], untracked);

    const head = (await readGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    let patch = '';
    if (options.patch !== false) {
      const trackedPatch = await readGit(projectPath, ['diff', '-M', '--relative', 'HEAD', ...HARNAS_PATHSPEC]);
      const untrackedPatches = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) =>
        untrackedPatch(projectPath, filePath),
      );
      patch = `${trackedPatch}${untrackedPatches.join('')}`;
    }

    return { patch, files, stats: sumStats(files), branch: head === 'HEAD' ? null : head };
  });
}

/**
 * «Закоммитить всё в папке» — только по кнопке человека. Pathspec и у `add`, и
 * у `commit`: без него `git commit` взял бы весь индекс — подготовленное
 * человеком вне папки проекта и `.harnas/`, если его кто-то добавил; так чужое
 * подготовленное остаётся в индексе нетронутым.
 */
export async function commitProject(projectPath: string, message: string): Promise<{ commit: string }> {
  return withGitState(projectPath, async () => {
    const added = await exitCode(['-C', projectPath, 'add', '-A', ...HARNAS_PATHSPEC]);
    // Код 1 у `add` — и когда `.harnas/` в .gitignore: исключение в pathspec
    // называет игнорируемый путь, остальное при этом подготовлено. Отличаем
    // пробой `check-ignore`, а не по stderr — у человека git локализован.
    if (added.code !== 0) {
      const ignored = (await gitWithCode(projectPath, ['check-ignore', '-q', '--', '.harnas'])).code === 0;
      if (added.code !== 1 || !ignored) throw new Error(`git add -A: код ${added.code}`);
    }
    const { code } = await gitWithCode(projectPath, ['diff', '--cached', '--quiet', ...HARNAS_PATHSPEC]);
    if (code === 0) throw new NothingToCommitError(`в ${projectPath} нечего коммитить`);
    if (code !== 1) throw new Error(`git diff --cached --quiet: код ${code}`);
    await run('git', ['-C', projectPath, 'commit', '-m', message, ...HARNAS_PATHSPEC]);
    return { commit: (await readGit(projectPath, ['rev-parse', 'HEAD'])).trim() };
  });
}

/** Коммитит всё незакоммиченное в worktree одной записью — «сохранить прогресс» из окна. */
export async function commitWorktree(info: WorktreeInfo, message: string): Promise<string> {
  await run('git', ['-C', info.path, 'add', '-A', ...WORKTREE_PATHSPEC]);
  await run('git', ['-C', info.path, 'commit', '-m', message]);
  return (await run('git', ['-C', info.path, 'rev-parse', 'HEAD'])).stdout.trim();
}

export type MergeResult =
  | { ok: true; commit: string }
  | {
      ok: false;
      reason: 'base_not_checked_out' | 'base_dirty' | 'uncommitted' | 'conflict';
      files: string[];
    };

/**
 * Вливает ветку worktree в базу через `git merge --no-ff` (решение спеки 14 —
 * без squash). Отказывает раньше, чем тронуть базу, если её нельзя мержить
 * чисто; конфликт откатывается сам — база остаётся чистой в любом исходе.
 */
export async function mergeWorktree(
  projectPath: string,
  info: WorktreeInfo,
  message: string,
): Promise<MergeResult> {
  // Как в mergeCheck: база и ветка из карты — до любого git, иначе флаг вместо
  // ветки ушёл бы в `git merge` параметром.
  await assertRevisions(projectPath, [info.base, info.branch]);
  const baseCheckout = await findBaseCheckout(projectPath, info.base);
  if (baseCheckout === null) return { ok: false, reason: 'base_not_checked_out', files: [] };

  const prefix = await projectPrefix(projectPath);
  if (await isDirty(baseCheckout, prefix)) return { ok: false, reason: 'base_dirty', files: [] };

  if (await isDirty(info.path, prefix)) return { ok: false, reason: 'uncommitted', files: [] };

  try {
    await run('git', ['-C', baseCheckout, 'merge', '--no-ff', '-m', message, '--end-of-options', info.branch]);
  } catch {
    // Конфликт: список файлов из индекса, затем откат — база не остаётся
    // наполовину слитой ни при каком исходе (правило куска 4.1).
    // `-z`: без него путь с кириллицей пришёл бы в кавычках с восьмеричными кодами.
    const conflicted = zFields(
      (await run('git', ['-C', baseCheckout, 'diff', '--name-only', '-z', '--diff-filter=U'])).stdout,
    );
    await run('git', ['-C', baseCheckout, 'merge', '--abort']);
    return { ok: false, reason: 'conflict', files: conflicted };
  }

  const commit = (await run('git', ['-C', baseCheckout, 'rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, commit };
}

/** Worktree с незакоммиченным нельзя молча выбросить — грязная копия и есть работа. */
export class DirtyWorktreeError extends Error {}

/** Отбрасывает worktree целиком: каталог и ветку. Без `force` грязный worktree не трогает. */
export async function discardWorktree(
  projectPath: string,
  info: WorktreeInfo,
  options: { force?: boolean } = {},
): Promise<void> {
  // Ветка из карты — проверка раньше `worktree remove`: иначе каталог уже
  // удалён, а `branch -D` с флагом вместо имени падает на полпути.
  await assertRevisions(projectPath, [info.branch]);
  if (options.force !== true) {
    const dirty =
      (await run('git', ['-C', info.path, 'status', '--porcelain'])).stdout.trim() !== '';
    if (dirty) {
      throw new DirtyWorktreeError(
        `worktree ${info.path} не отброшен: есть незакоммиченные изменения`,
      );
    }
  }

  const removeArgs = ['-C', projectPath, 'worktree', 'remove'];
  if (options.force === true) removeArgs.push('--force');
  removeArgs.push(info.path);
  await run('git', removeArgs);
  await run('git', ['-C', projectPath, 'branch', '-D', '--end-of-options', info.branch]);
}
