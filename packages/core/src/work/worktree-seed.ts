/**
 * Клон путей `.worktreeinclude` из основной копии в новую копию (worktree).
 *
 * Только copy-on-write: обычной копии как запасного пути нет, потому что `cp -c` сам
 * откатывается к ней, когда клон невозможен. Поэтому без пройденной проверки тома `cp`
 * не запускается вовсе. Цель в копии никогда не перезаписывается и никогда не бывает
 * неполной: клон идёт во временный каталог внутри gitdir копии и переносится на место
 * одним `rename` (каталог) или `link` (файл). Сбой пути или шага наружу не бросается.
 */
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveIncludePaths } from './worktree-include.js';
import { NO_FSMONITOR } from './worktree.js';

export const SEED_MAX_ENTRIES = 300_000;
export const SEED_TIMEOUT_MS = 120_000;
export const LOCK_FILE_NAMES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

export type SeedSkipReason = 'entries' | 'timeout' | 'failed';
export interface SeedSkip {
  path: string;
  reason: SeedSkipReason;
}
export interface SeedReport {
  sourceRoot: string;
  cloned: string[];
  skipped: SeedSkip[];
  lockMismatch: string[];
  stale: boolean;
  /** Клон невозможен: не macOS, другой том или не APFS. Тогда cloned и skipped пусты. */
  unavailable: boolean;
}
export interface SeedDeps {
  platform?: NodeJS.Platform;
  sameCloneVolume?: (source: string, targetDir: string) => Promise<boolean>;
  /** Клонирует source в stage (пути не существует); каталог — рекурсивно. */
  clonePath?: (
    source: string,
    stage: string,
    isDirectory: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
  maxEntries?: number;
  timeoutMs?: number;
}

/** Срок одного вызова git и служебных команд проверки тома. */
const COMMAND_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 30_000;
const STAGE_DIR = 'parley-seed';

/** stdout вызова git без оболочки; сбой, в том числе срок, — исключение. */
function gitOut(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...NO_FSMONITOR, ...args],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGTERM' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function runCommand(file: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout, killSignal: 'SIGTERM', ...(signal ? { signal } : {}) },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Устройство, на котором лежит путь: первая колонка второй строки `df -P`. */
async function deviceOf(target: string): Promise<string> {
  const out = await runCommand('/bin/df', ['-P', target], COMMAND_TIMEOUT_MS);
  const line = out.split('\n')[1] ?? '';
  const device = line.trim().split(/\s+/)[0] ?? '';
  if (device === '') throw new Error('no device');
  return device;
}

async function filesystemName(device: string): Promise<string> {
  const out = await runCommand('/usr/sbin/diskutil', ['info', '-plist', device], COMMAND_TIMEOUT_MS);
  const match = /<key>FilesystemName<\/key>\s*<string>([^<]*)<\/string>/.exec(out);
  return match?.[1] ?? '';
}

async function defaultSameCloneVolume(source: string, targetDir: string): Promise<boolean> {
  const [a, b] = await Promise.all([deviceOf(source), deviceOf(targetDir)]);
  if (a !== b) return false;
  const [nameA, nameB] = await Promise.all([filesystemName(a), filesystemName(b)]);
  return nameA === 'APFS' && nameB === 'APFS';
}

async function defaultClonePath(
  source: string,
  stage: string,
  isDirectory: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (isDirectory) {
    await mkdir(stage);
    await runCommand('/bin/cp', ['-c', '-R', `${source}/.`, stage], SEED_TIMEOUT_MS, signal);
  } else {
    await runCommand('/bin/cp', ['-c', source, stage], SEED_TIMEOUT_MS, signal);
  }
}

/** Число записей пути (сам путь и всё внутри; симлинки не раскрываются); обход встаёт, когда счёт превысил limit. */
async function countEntries(abs: string, limit: number): Promise<number> {
  const info = await lstat(abs);
  let count = 1;
  if (!info.isDirectory()) return count;
  const stack = [abs];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const child of await readdir(dir, { withFileTypes: true })) {
      count += 1;
      if (count > limit) return count;
      if (child.isDirectory()) stack.push(path.join(dir, child.name));
    }
  }
  return count;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Отслеживаемые в копии lock-файлы, которых нет в основной копии или чьи байты там другие. */
async function lockMismatchOf(sourceRoot: string, worktreePath: string): Promise<string[]> {
  const specs = LOCK_FILE_NAMES.map((name) => `:(glob)**/${name}`);
  const listed = await gitOut(['-C', worktreePath, 'ls-files', '-z', '--', ...specs]);
  const mismatch: string[] = [];
  for (const rel of listed.split('\0').filter((entry) => entry !== '')) {
    const here = await readOrNull(path.join(worktreePath, rel));
    if (!here) continue;
    const there = await readOrNull(path.join(sourceRoot, rel));
    if (!there || !there.equals(here)) mismatch.push(rel);
  }
  return mismatch.sort();
}

/** Склонированный `node_modules` старше lock-файла копии: `.pnpm/lock.yaml` отличается от `pnpm-lock.yaml`. */
async function isStalePnpm(worktreePath: string, cloned: string[]): Promise<boolean> {
  if (!cloned.includes('node_modules')) return false;
  const installed = await readOrNull(path.join(worktreePath, 'node_modules', '.pnpm', 'lock.yaml'));
  const wanted = await readOrNull(path.join(worktreePath, 'pnpm-lock.yaml'));
  return installed !== null && wanted !== null && !installed.equals(wanted);
}

/** Перенос из временного каталога на место; существующая непустая цель остаётся нетронутой (rename и link не затирают). */
async function moveIntoPlace(stage: string, target: string, isDirectory: boolean): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  if (isDirectory) {
    await rename(stage, target);
    return;
  }
  await link(stage, target);
  await rm(stage, { force: true });
}

/** null — списка нет или в нём нет подходящих путей. Не бросает из-за сбоя отдельного пути. */
export async function seedWorktree(
  projectPath: string,
  worktreePath: string,
  deps: SeedDeps = {},
): Promise<SeedReport | null> {
  const platform = deps.platform ?? process.platform;
  const sameCloneVolume = deps.sameCloneVolume ?? defaultSameCloneVolume;
  const clonePath = deps.clonePath ?? defaultClonePath;
  const maxEntries = deps.maxEntries ?? SEED_MAX_ENTRIES;
  const timeoutMs = deps.timeoutMs ?? SEED_TIMEOUT_MS;

  let sourceRoot: string;
  let entries: string[];
  let stageRoot = '';
  let unavailable = false;
  try {
    sourceRoot = (await gitOut(['-C', projectPath, 'rev-parse', '--show-toplevel'])).trim();
    if (sourceRoot === '') return null;
    const [realSource, realCopy] = await Promise.all([realpath(sourceRoot), realpath(worktreePath)]);
    if (realSource === realCopy) return null;
    entries = await resolveIncludePaths(sourceRoot, worktreePath);
    if (entries.length === 0) return null;

    if (platform !== 'darwin') {
      unavailable = true;
    } else {
      unavailable = !(await sameCloneVolume(sourceRoot, worktreePath).catch(() => false));
    }
    if (!unavailable) {
      const gitDir = (await gitOut(['-C', worktreePath, 'rev-parse', '--absolute-git-dir'])).trim();
      if (gitDir === '') return null;
      stageRoot = path.join(gitDir, STAGE_DIR);
      // Остаток оборванного запуска не мешает и не выдаётся за готовое.
      await rm(stageRoot, { recursive: true, force: true });
      await mkdir(stageRoot, { recursive: true });
    }
  } catch {
    return null;
  }

  const report: SeedReport = {
    sourceRoot,
    cloned: [],
    skipped: [],
    lockMismatch: [],
    stale: false,
    unavailable,
  };
  if (unavailable) return report;

  const deadline = Date.now() + timeoutMs;
  let used = 0;
  try {
    for (const [index, entry] of entries.entries()) {
      const source = path.join(sourceRoot, entry);
      const target = path.join(worktreePath, entry);
      const stage = path.join(stageRoot, String(index));
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        // Цель уже есть (свой каталог агента, прежний запуск): не трогаем, в отчёт не пишем.
        if (await lstat(target).then(() => true, () => false)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          report.skipped.push({ path: entry, reason: 'timeout' });
          continue;
        }
        const count = await countEntries(source, maxEntries - used);
        if (count > maxEntries - used) {
          report.skipped.push({ path: entry, reason: 'entries' });
          continue;
        }
        const isDirectory = (await lstat(source)).isDirectory();
        timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        timer.unref();
        await clonePath(source, stage, isDirectory, controller.signal);
        if (controller.signal.aborted) throw new Error('timeout');
        await moveIntoPlace(stage, target, isDirectory);
        used += count;
        report.cloned.push(entry);
      } catch {
        report.skipped.push({ path: entry, reason: controller.signal.aborted ? 'timeout' : 'failed' });
      } finally {
        if (timer) clearTimeout(timer);
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Сбой самого обхода: итог по уже обработанным путям всё равно отдаётся.
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }

  try {
    report.lockMismatch = await lockMismatchOf(sourceRoot, worktreePath);
  } catch {
    report.lockMismatch = [];
  }
  try {
    report.stale = await isStalePnpm(worktreePath, report.cloned);
  } catch {
    report.stale = false;
  }
  return report;
}
