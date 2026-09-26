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

/** Заводит worktree на диске: каталог создаёт сама команда, родителя — на всякий случай мы. */
export async function createWorktree(projectPath: string, info: WorktreeInfo): Promise<void> {
  await mkdir(path.dirname(info.path), { recursive: true });
  await run('git', ['-C', projectPath, 'worktree', 'add', info.path, '-b', info.branch, info.base]);
}

interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
}

/** `git diff --name-status`: переименование — три поля, нам нужен новый путь. */
function parseNameStatus(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const letter = code[0] ?? '';
    const status: DiffFile['status'] =
      letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'R' || letter === 'C' ? 'R' : 'M';
    const filePath = status === 'R' ? (parts[2] ?? parts[1] ?? '') : (parts[1] ?? '');
    if (filePath !== '') files.push({ path: filePath, status });
  }
  return files;
}

/** Пути файлов, которых нет в индексе вовсе (`??` в `git status --porcelain`). */
function parseUntrackedPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    if (line[0] === '?' && line[1] === '?') paths.push(line.slice(3));
  }
  return paths;
}

/**
 * `git status --porcelain`: незакоммиченное, включая untracked-файлы — их
 * `git diff` без индекса не видит вовсе, а трогать индекс ради чтения не
 * нужно.
 */
function parsePorcelain(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const filePath = arrow === -1 ? rest : rest.slice(arrow + 4);
    const status: DiffFile['status'] =
      x === '?' || y === '?' || x === 'A' || y === 'A'
        ? 'A'
        : x === 'D' || y === 'D'
          ? 'D'
          : x === 'R' || y === 'R'
            ? 'R'
            : 'M';
    files.push({ path: filePath, status });
  }
  return files;
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
async function untrackedPatch(worktreePath: string, filePath: string): Promise<string> {
  try {
    const { stdout } = await run('git', [
      '-C',
      worktreePath,
      'diff',
      '--no-index',
      '--',
      '/dev/null',
      filePath,
    ]);
    return stdout;
  } catch (error) {
    const withOutput = error as { code?: number; stdout?: string };
    if (withOutput.code === 1 && typeof withOutput.stdout === 'string') return withOutput.stdout;
    throw error;
  }
}

/** Где выгружена ветка `base` — основной каталог или чужой worktree; `null` — нигде. */
async function findBaseCheckout(projectPath: string, base: string): Promise<string | null> {
  const entries = await listWorktrees(projectPath);
  const match = entries.find((entry) => entry.branch === base || entry.head === base);
  return match?.path ?? null;
}

/**
 * Есть ли незакоммиченное в каталоге, не считая `.harnas/` — там сам гарнес
 * хранит своё состояние прямо внутри проекта, и без `.gitignore` на этот
 * каталог `git status` в нём всегда грязный: `base_dirty` тогда получали бы
 * всегда и слияние никогда бы не проходило. Синтаксис exclude-пасспеки
 * работает с git 1.9.
 */
async function isDirty(checkoutPath: string): Promise<boolean> {
  const { stdout } = await run('git', [
    '-C',
    checkoutPath,
    'status',
    '--porcelain',
    '--',
    '.',
    ':(exclude).harnas',
  ]);
  return stdout.trim() !== '';
}

export interface WorktreeDiff {
  /** Коммиты ветки от общего предка с базой, плюс незакоммиченное поверх них. */
  patch: string;
  files: DiffFile[];
  uncommitted: boolean;
  /** Каталог, где сейчас выгружена ветка `base`; `null` — нигде. */
  baseCheckout: string | null;
  baseDirty: boolean;
}

/**
 * Дифф worktree относительно базы: история ветки от общего предка плюс то, что
 * в рабочем дереве ещё не закоммичено (спецификация 8.2).
 */
export async function worktreeDiff(projectPath: string, info: WorktreeInfo): Promise<WorktreeDiff> {
  const mergeBase = (
    await run('git', ['-C', projectPath, 'merge-base', info.base, info.branch])
  ).stdout.trim();

  const range = `${mergeBase}..${info.branch}`;
  const committedPatch = (await run('git', ['-C', projectPath, 'diff', range])).stdout;
  const committedFiles = parseNameStatus(
    (await run('git', ['-C', projectPath, 'diff', '--name-status', range])).stdout,
  );

  const porcelain = (
    await run('git', ['-C', info.path, 'status', '--porcelain=v1', '--untracked-files=all'])
  ).stdout;
  const uncommittedFiles = parsePorcelain(porcelain);
  const uncommittedPatch =
    uncommittedFiles.length === 0 ? '' : (await run('git', ['-C', info.path, 'diff', 'HEAD'])).stdout;

  // `git diff HEAD` untracked-файлы не показывает вовсе (их нет в индексе,
  // сравнивать нечего) — их содержимое дифф от пустоты добирает отдельно, файл
  // за файлом, не трогая сам индекс (EXTRA, кусок 4.2).
  const untrackedPaths = parseUntrackedPaths(porcelain);
  const untrackedPatches = await Promise.all(
    untrackedPaths.map((filePath) => untrackedPatch(info.path, filePath)),
  );

  // Уже закоммиченное в ветке и то, что ещё в рабочем дереве, — один и тот же
  // путь может встретиться в обоих списках; актуальнее второй.
  const files = new Map(committedFiles.map((file) => [file.path, file]));
  for (const file of uncommittedFiles) files.set(file.path, file);

  const baseCheckout = await findBaseCheckout(projectPath, info.base);
  const baseDirty = baseCheckout === null ? false : await isDirty(baseCheckout);

  const workingTreePatch = uncommittedPatch + untrackedPatches.join('');
  return {
    patch: workingTreePatch === '' ? committedPatch : `${committedPatch}${workingTreePatch}`,
    files: [...files.values()],
    uncommitted: uncommittedFiles.length > 0,
    baseCheckout,
    baseDirty,
  };
}

/** Коммитит всё незакоммиченное в worktree одной записью — «сохранить прогресс» из окна. */
export async function commitWorktree(info: WorktreeInfo, message: string): Promise<string> {
  await run('git', ['-C', info.path, 'add', '-A']);
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
  const baseCheckout = await findBaseCheckout(projectPath, info.base);
  if (baseCheckout === null) return { ok: false, reason: 'base_not_checked_out', files: [] };

  if (await isDirty(baseCheckout)) return { ok: false, reason: 'base_dirty', files: [] };

  if (await isDirty(info.path)) return { ok: false, reason: 'uncommitted', files: [] };

  try {
    await run('git', ['-C', baseCheckout, 'merge', '--no-ff', info.branch, '-m', message]);
  } catch {
    // Конфликт: список файлов из индекса, затем откат — база не остаётся
    // наполовину слитой ни при каком исходе (правило куска 4.1).
    const conflicted = (
      await run('git', ['-C', baseCheckout, 'diff', '--name-only', '--diff-filter=U'])
    ).stdout.trim();
    await run('git', ['-C', baseCheckout, 'merge', '--abort']);
    return { ok: false, reason: 'conflict', files: conflicted === '' ? [] : conflicted.split('\n') };
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
  await run('git', ['-C', projectPath, 'branch', '-D', info.branch]);
}
