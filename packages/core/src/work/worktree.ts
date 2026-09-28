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
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { mapLimited } from '../map-limited.js';
import type { WorktreeInfo } from './types.js';

const run = promisify(execFile);

/**
 * Во всех вызовах git здесь (раунд fix-final-a, C1): `core.fsmonitor` — программа из
 * конфигурации репозитория, и её исполняют `status`, `diff` против рабочего дерева и
 * `ls-files`. Ключ из командной строки главнее конфигурации и по `GIT_CONFIG_PARAMETERS`
 * доходит до дочерних git (подмодули, проверка чистоты `worktree remove`).
 */
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'];

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
    const { stdout } = await run('git', [...NO_FSMONITOR, '-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
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
  const { stdout } = await run('git', [...NO_FSMONITOR, '-C', checkoutPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  if (branch !== 'HEAD') return branch;
  return (await run('git', [...NO_FSMONITOR, '-C', checkoutPath, 'rev-parse', 'HEAD'])).stdout.trim();
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
    ...NO_FSMONITOR,
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

/**
 * `worktree-corrupt` — файл `.git` рабочей копии не ведёт в зарегистрированный worktree
 * проекта (`checkoutGitDir`): git в ней не запускается (раунд fix-final-a, C1).
 */
export type GitStateReason = 'git-missing' | 'not-a-repo' | 'no-commits' | 'worktree-corrupt';

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
    probe = run('git', [...NO_FSMONITOR, '--version']).then(({ stdout }) => {
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
    const { stdout } = await run('git', [...NO_FSMONITOR, '-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') return 'not-a-repo';
  } catch (probeError) {
    return isSpawnMissing(probeError) ? 'git-missing' : 'not-a-repo';
  }
  try {
    await run('git', [...NO_FSMONITOR, '-C', projectPath, 'rev-parse', '--verify', '-q', 'HEAD']);
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
    if (error instanceof NothingToCommitError || error instanceof InvalidRevisionError || error instanceof GitStateError) {
      throw error;
    }
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

/**
 * Дифф чтения показывает сами байты: внешний дифф (`diff.external`, `diff.<драйвер>.command`)
 * и textconv — программы из конфигурации, а драйвер к файлу привязывает `.gitattributes`
 * агента (C1).
 */
const DIFF_READ = ['--no-ext-diff', '--no-textconv'];

/**
 * `status` и `diff` против рабочего дерева заходят в подмодули дочерним `git status`, а
 * файл `.git` подмодуля лежит в рабочей копии агента — подложенный gitdir исполнил бы свои
 * фильтры (проба на git 2.53). `dirty` оставляет только сдвиг коммита подмодуля — его git
 * читает сам, без дочернего процесса.
 */
const NO_SUBMODULE_WALK = '--ignore-submodules=dirty';

/**
 * Где читает git: `cwd` и глобальные флаги после `-C` — закреплённый gitdir рабочей копии
 * (`pinnedCheckout`) и выключенные фильтры (`filterOverrides`).
 */
interface GitAt {
  cwd: string;
  flags: string[];
}

/**
 * Clean- и process-фильтры исполняют `status` (файл со сдвинутым mtime), `diff` против
 * рабочего дерева и `diff --no-index`, а к файлу их привязывает `.gitattributes` — его
 * агент кладёт в свою копию (C1). Ключом без имени драйвера фильтр не выключить, поэтому
 * имена берутся из той же конфигурации, что увидит чтение, и каждому ставится пустая
 * команда; `required=false` — иначе пустой обязательный фильтр был бы отказом. Чтение без
 * фильтра сравнивает сырые байты: у LFS файл со сдвинутым mtime покажется изменённым.
 */
async function filterOverrides(cwd: string, pin: string[]): Promise<string[]> {
  const { code, stdout } = await exitCode([
    '-C',
    cwd,
    ...pin,
    'config',
    '--null',
    '--name-only',
    '--get-regexp',
    '^filter\\..+\\.(clean|process)$',
  ]);
  // Код 1 — таких ключей нет.
  if (code === 1) return [];
  if (code !== 0) throw new Error(`git config --get-regexp filter: код ${code}`);
  const drivers = new Set(zFields(stdout).map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))));
  return [...drivers].flatMap((driver) => [
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.required=false`,
  ]);
}

/** Чтения одного каталога — с флагами, собранными один раз на операцию. */
async function readerAt(cwd: string, pin: string[] = []): Promise<GitAt> {
  return { cwd, flags: [...pin, ...(await filterOverrides(cwd, pin))] };
}

async function readGit(at: GitAt, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...NO_FSMONITOR, ...READ_FLAGS, '-C', at.cwd, ...at.flags, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function readGitBuffer(at: GitAt, args: string[]): Promise<Buffer> {
  const { stdout } = await run('git', [...NO_FSMONITOR, ...READ_FLAGS, '-C', at.cwd, ...at.flags, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Код выхода и stdout без броска: у `--no-index` и `merge-tree` код 1 — ответ, а не сбой. */
async function gitWithCode(at: GitAt, args: string[]): Promise<{ code: number; stdout: string }> {
  return exitCode([...READ_FLAGS, '-C', at.cwd, ...at.flags, ...args]);
}

/** Общий каталог git проекта (`.git` основной копии) по realpath — опора проверки worktree. */
async function projectCommonDir(projectPath: string): Promise<string> {
  const { stdout } = await run('git', [...NO_FSMONITOR, '-C', projectPath, 'rev-parse', '--git-common-dir']);
  // Относительный ответ git — от cwd, то есть от `-C`.
  return realpath(path.resolve(projectPath, stdout.trim()));
}

/**
 * gitdir рабочей копии `checkoutPath`, если это настоящая копия репозитория с общим
 * каталогом `commonDir` (realpath): у основной `.git` — каталог, и он и есть `commonDir`;
 * у worktree `.git` — обычный файл `gitdir: <commonDir>/worktrees/<имя>`, а файл `gitdir`
 * там ведёт обратно в эту же копию (так `git worktree` связывает их сам). Иначе — `null`:
 * `.git` подменён (C1, спека 10.8 — агент кладёт в worktree что угодно, в том числе файл
 * `.git`), и его конфигурация исполнила бы свои программы. Разбор без git: запуск git для
 * проверки уже читал бы подложенную конфигурацию. Каталог `<commonDir>/worktrees` — в
 * `.git` проекта, вне копии агента.
 */
export async function checkoutGitDir(commonDir: string, checkoutPath: string): Promise<string | null> {
  try {
    const dotGit = path.join(checkoutPath, '.git');
    const kind = await lstat(dotGit);
    if (kind.isDirectory()) {
      const gitDir = await realpath(dotGit);
      return gitDir === commonDir ? gitDir : null;
    }
    if (!kind.isFile()) return null;
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(dotGit, 'utf8'));
    if (match?.[1] === undefined) return null;
    const gitDir = await realpath(path.resolve(checkoutPath, match[1]));
    if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) return null;
    const back = (await readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
    const registered = await realpath(path.dirname(path.resolve(gitDir, back)));
    return registered === (await realpath(checkoutPath)) ? gitDir : null;
  } catch {
    return null;
  }
}

/**
 * Рабочая копия проекта для git: путь (от `projectPath`, как у `-C` проекта) и флаги —
 * gitdir проверен `checkoutGitDir` и закреплён `--git-dir`/`--work-tree`: файл `.git`,
 * подменённый агентом после проверки, git уже не читает. Не прошла проверку —
 * `GitStateError('worktree-corrupt')`, git в ней не запускается. Проверка — на каждую
 * операцию, без кэша: агент меняет `.git` когда угодно. Нет самого каталога — ошибка
 * `stat` как есть: это не подмена.
 */
async function pinnedCheckout(projectPath: string, checkoutPath: string): Promise<{ cwd: string; pin: string[] }> {
  const cwd = path.resolve(projectPath, checkoutPath);
  await stat(cwd);
  const gitDir = await checkoutGitDir(await projectCommonDir(projectPath), cwd);
  if (gitDir === null) {
    throw new GitStateError('worktree-corrupt', `${cwd}: .git не ведёт в worktree проекта ${projectPath}`);
  }
  return { cwd, pin: ['--git-dir', gitDir, '--work-tree', cwd] };
}

/** Чтения рабочей копии проекта — после проверки её `.git`. */
async function checkoutReader(projectPath: string, checkoutPath: string): Promise<GitAt> {
  const { cwd, pin } = await pinnedCheckout(projectPath, checkoutPath);
  return readerAt(cwd, pin);
}

async function exitCode(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    return { code: 0, stdout: (await run('git', [...NO_FSMONITOR, ...args], { maxBuffer: MAX_BUFFER })).stdout };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (typeof failed.code === 'number' && typeof failed.stdout === 'string') {
      return { code: failed.code, stdout: failed.stdout };
    }
    throw error;
  }
}

/** Неотслеживаемые файлы от `cwd`; `pathspec` — у `changes.*` без `.harnas/`. */
async function untrackedFiles(at: GitAt, pathspec: string[] = []): Promise<string[]> {
  return zFields(await readGitBuffer(at, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]));
}

/**
 * Числа неотслеживаемого файла — `git diff --no-index` от пустоты, а не
 * `git add -N`: чтение индекс не трогает. Код 1 — «отличаются», не сбой.
 */
async function untrackedCounts(at: GitAt, filePath: string): Promise<DiffFile> {
  const { code, stdout } = await gitWithCode(at, [
    'diff',
    ...DIFF_READ,
    '--no-index',
    '--numstat',
    '-z',
    '--',
    '/dev/null',
    filePath,
  ]);
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
async function workingTreeFiles(at: GitAt, diffArgs: string[], untracked: string[]): Promise<DiffFile[]> {
  const [status, numstat] = await Promise.all([
    readGitBuffer(at, ['diff', ...DIFF_READ, NO_SUBMODULE_WALK, '-M', '--name-status', '-z', ...diffArgs]),
    readGitBuffer(at, ['diff', ...DIFF_READ, NO_SUBMODULE_WALK, '-M', '--numstat', '-z', ...diffArgs]),
  ]);
  const counts = parseNumstat(numstat);
  // Без пары в numstat — только сдвинутый stat без правки содержимого (см. READ_FLAGS).
  const counted = new Set(counts.map((entry) => entry.path));
  const changed = parseNameStatusZ(status).filter((entry) => counted.has(entry.path));
  const tracked = joinDiffFiles(changed, counts);
  const fresh = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) => untrackedCounts(at, filePath));
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
  const { stdout } = await run('git', [...NO_FSMONITOR, '-C', projectPath, 'worktree', 'list', '--porcelain']);
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
async function untrackedPatch(at: GitAt, filePath: string): Promise<string> {
  const { code, stdout } = await gitWithCode(at, ['diff', ...DIFF_READ, '--no-index', '--', '/dev/null', filePath]);
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
async function projectPrefix(project: GitAt): Promise<string> {
  return (await readGit(project, ['rev-parse', '--show-prefix'])).trim();
}

/**
 * Есть ли незакоммиченное в каталоге, не считая `.harnas/` проекта — там сам
 * гарнес хранит своё состояние прямо внутри проекта, и без `.gitignore` на этот
 * каталог `git status` в нём всегда грязный: `base_dirty` тогда получали бы
 * всегда и слияние никогда бы не проходило. `prefix` — путь проекта от корня
 * рабочей копии (`projectPrefix`). Синтаксис exclude-пасспеки работает с git 1.9.
 */
async function isDirty(checkout: GitAt, prefix: string): Promise<boolean> {
  const stdout = await readGit(checkout, [
    'status',
    '--porcelain',
    NO_SUBMODULE_WALK,
    '--',
    '.',
    `:(exclude)${prefix}.harnas`,
  ]);
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
    const worktree = await checkoutReader(projectPath, info.path);
    const project = await readerAt(projectPath);
    const mergeBase = (
      await readGit(project, ['merge-base', '--end-of-options', info.base, info.branch])
    ).trim();

    // Список и числа — одной парой сторон: общий предок против рабочего дерева.
    const untracked = await untrackedFiles(worktree, WORKTREE_PATHSPEC);
    const files = await workingTreeFiles(worktree, [mergeBase, ...WORKTREE_PATHSPEC], untracked);

    const uncommittedPaths = parsePorcelainPaths(
      await readGitBuffer(worktree, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        NO_SUBMODULE_WALK,
        ...WORKTREE_PATHSPEC,
      ]),
    );

    const commits = parseCommits(
      await readGit(project, [
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
      baseCheckout === null
        ? false
        : await isDirty(await checkoutReader(projectPath, baseCheckout), await projectPrefix(project));

    let patch = '';
    if (options.patch !== false) {
      const committedPatch = await readGit(project, [
        'diff',
        ...DIFF_READ,
        '--end-of-options',
        `${mergeBase}..${info.branch}`,
      ]);
      const uncommittedPatch =
        uncommittedPaths.length === 0
          ? ''
          : await readGit(worktree, ['diff', ...DIFF_READ, NO_SUBMODULE_WALK, 'HEAD', ...WORKTREE_PATHSPEC]);
      // `git diff HEAD` untracked-файлы не показывает вовсе (их нет в индексе,
      // сравнивать нечего) — их содержимое дифф от пустоты добирает отдельно, файл
      // за файлом, не трогая сам индекс (EXTRA, кусок 4.2).
      const untrackedPatches = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) =>
        untrackedPatch(worktree, filePath),
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
    const { code, stdout } = await gitWithCode(await readerAt(projectPath), [
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
    const project = await readerAt(projectPath);
    const untracked = await untrackedFiles(project, HARNAS_PATHSPEC);
    const files = await workingTreeFiles(project, ['--relative', 'HEAD', ...HARNAS_PATHSPEC], untracked);

    const head = (await readGit(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    let patch = '';
    if (options.patch !== false) {
      const trackedPatch = await readGit(project, [
        'diff',
        ...DIFF_READ,
        NO_SUBMODULE_WALK,
        '-M',
        '--relative',
        'HEAD',
        ...HARNAS_PATHSPEC,
      ]);
      const untrackedPatches = await mapLimited(untracked, UNTRACKED_CONCURRENCY, (filePath) =>
        untrackedPatch(project, filePath),
      );
      patch = `${trackedPatch}${untrackedPatches.join('')}`;
    }

    return { patch, files, stats: sumStats(files), branch: head === 'HEAD' ? null : head };
  });
}

/**
 * Pathspec-исключения записей подмодулей (gitlink, режим 160000 в индексе) для `add -A` коммита
 * из окна (раунд fix-final-c, п. 5). `add` заходит в изменённый подмодуль дочерним `git status`,
 * а файл `.git` подмодуля лежит в копии агента: подложенный gitdir исполнил бы свои фильтры
 * (проба на git 2.53). Выключателя у `add` нет — ни `--ignore-submodules`, ни
 * `diff.ignoreSubmodules`, — поэтому пути подмодулей в `add` не попадают: их изменения человек
 * коммитит сам (спека 10.8). `ls-files -s` читает только индекс — рабочую копию и подмодули не
 * трогает. Пути — от `cwd`, как и pathspec `add`; `literal` — имя со `*` не глоб.
 */
async function submoduleExcludes(at: GitAt): Promise<string[]> {
  const excludes: string[] = [];
  for (const entry of zFields(await readGitBuffer(at, ['ls-files', '-s', '-z']))) {
    // «<режим> <объект> <стадия>\t<путь>»
    const tab = entry.indexOf('\t');
    if (tab !== -1 && entry.startsWith('160000 ')) excludes.push(`:(exclude,literal)${entry.slice(tab + 1)}`);
  }
  return excludes;
}

/**
 * «Закоммитить всё в папке» — только по кнопке человека. Pathspec и у `add`, и
 * у `commit`: без него `git commit` взял бы весь индекс — подготовленное
 * человеком вне папки проекта и `.harnas/`, если его кто-то добавил; так чужое
 * подготовленное остаётся в индексе нетронутым.
 */
export async function commitProject(projectPath: string, message: string): Promise<{ commit: string }> {
  return withGitState(projectPath, async () => {
    const project = await readerAt(projectPath);
    const added = await exitCode(['-C', projectPath, 'add', '-A', ...HARNAS_PATHSPEC, ...(await submoduleExcludes(project))]);
    // Код 1 у `add` — и когда `.harnas/` в .gitignore: исключение в pathspec
    // называет игнорируемый путь, остальное при этом подготовлено. Отличаем
    // пробой `check-ignore`, а не по stderr — у человека git локализован.
    if (added.code !== 0) {
      const ignored = (await gitWithCode(project, ['check-ignore', '-q', '--', '.harnas'])).code === 0;
      if (added.code !== 1 || !ignored) throw new Error(`git add -A: код ${added.code}`);
    }
    const { code } = await gitWithCode(project, ['diff', ...DIFF_READ, '--cached', '--quiet', ...HARNAS_PATHSPEC]);
    if (code === 0) throw new NothingToCommitError(`в ${projectPath} нечего коммитить`);
    if (code !== 1) throw new Error(`git diff --cached --quiet: код ${code}`);
    await run('git', [...NO_FSMONITOR, '-C', projectPath, 'commit', '-m', message, ...HARNAS_PATHSPEC]);
    return { commit: (await readGit(project, ['rev-parse', 'HEAD'])).trim() };
  });
}

/**
 * Коммитит всё незакоммиченное в worktree одной записью — «сохранить прогресс» из окна.
 * `projectPath` — опора проверки `.git` копии: хуки и `gpg.program` подложенного gitdir
 * исполнил бы уже сам коммит.
 */
export async function commitWorktree(projectPath: string, info: WorktreeInfo, message: string): Promise<string> {
  const { cwd, pin } = await pinnedCheckout(projectPath, info.path);
  const inWorktree = [...NO_FSMONITOR, '-C', cwd, ...pin];
  const excludes = await submoduleExcludes(await readerAt(cwd, pin));
  await run('git', [...inWorktree, 'add', '-A', ...WORKTREE_PATHSPEC, ...excludes]);
  await run('git', [...inWorktree, 'commit', '-m', message]);
  return (await run('git', [...inWorktree, 'rev-parse', 'HEAD'])).stdout.trim();
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

  // Обе копии — до любого git в них: база бывает веткой родителя, то есть его worktree.
  const own = await pinnedCheckout(projectPath, info.path);
  const base = await pinnedCheckout(projectPath, baseCheckout);
  const prefix = await projectPrefix(await readerAt(projectPath));
  if (await isDirty(await readerAt(base.cwd, base.pin), prefix)) return { ok: false, reason: 'base_dirty', files: [] };

  if (await isDirty(await readerAt(own.cwd, own.pin), prefix)) return { ok: false, reason: 'uncommitted', files: [] };

  const inBase = [...NO_FSMONITOR, '-C', base.cwd, ...base.pin];
  try {
    await run('git', [...inBase, 'merge', '--no-ff', '-m', message, '--end-of-options', info.branch]);
  } catch {
    // Конфликт: список файлов из индекса, затем откат — база не остаётся
    // наполовину слитой ни при каком исходе (правило куска 4.1).
    // `-z`: без него путь с кириллицей пришёл бы в кавычках с восьмеричными кодами.
    const conflicted = zFields(
      (await run('git', [...inBase, 'diff', '--no-ext-diff', '--name-only', '-z', '--diff-filter=U'])).stdout,
    );
    await run('git', [...inBase, 'merge', '--abort']);
    return { ok: false, reason: 'conflict', files: conflicted };
  }

  const commit = (await run('git', [...inBase, 'rev-parse', 'HEAD'])).stdout.trim();
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
  // Подменённый `.git` — не отбрасываем: `worktree remove` и так откажет, а проверка
  // чистоты ниже запустила бы git в копии агента.
  const own = await pinnedCheckout(projectPath, info.path);
  if (options.force !== true) {
    const worktree = await readerAt(own.cwd, own.pin);
    const dirty = (await readGit(worktree, ['status', '--porcelain', NO_SUBMODULE_WALK])).trim() !== '';
    if (dirty) {
      throw new DirtyWorktreeError(
        `worktree ${info.path} не отброшен: есть незакоммиченные изменения`,
      );
    }
  }

  const removeArgs = ['-C', projectPath, 'worktree', 'remove'];
  if (options.force === true) removeArgs.push('--force');
  // Путь из карты, как и ревизии, может переписать агент: «--» не даёт ему
  // стать опцией `worktree remove`.
  removeArgs.push('--', info.path);
  await run('git', [...NO_FSMONITOR, ...removeArgs]);
  await run('git', [...NO_FSMONITOR, '-C', projectPath, 'branch', '-D', '--end-of-options', info.branch]);
}
