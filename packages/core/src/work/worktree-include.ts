/**
 * Список путей `.worktreeinclude`: какие игнорируемые git пути основной копии
 * стоит перенести в новую копию (зависимости, сборки). Шаблоны разбирает сам git,
 * своего парсера нет. Здесь только список; клон и запись итога — в других модулях.
 *
 * Все вызовы git идут через `execFile` без оболочки, вывод с `-z`: пути могут
 * содержать пробелы и не-ASCII.
 */
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { NO_FSMONITOR } from './worktree.js';

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
export const INCLUDE_MAX_FILE_BYTES = 256 * 1024;
export const INCLUDE_MAX_ENTRIES = 1000;

/** Предел вывода git: в большом проекте игнорируемых файлов много. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Результат вызова git: код выхода и stdout; сбой запуска (нет git) — код -1. */
async function gitRaw(args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...NO_FSMONITOR, ...args],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout });
        const code =
          typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : -1;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
    // Закрытый до конца ввода канал (git упал сразу) не должен ронять процесс.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** Игнорируемые пути в основной копии, разобранные по `\0`; каталог — с завершающим «/». */
async function lsIgnored(sourceRoot: string, excludeArg: string): Promise<string[] | null> {
  const { code, stdout } = await gitRaw([
    '-C',
    sourceRoot,
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--directory',
    excludeArg,
  ]);
  if (code !== 0) return null;
  return stdout.split('\0').filter((entry) => entry !== '');
}

/**
 * Какие из путей `git check-ignore` считает игнорируемыми в `root`. Каталоги подаются с «/».
 * Код выхода 1 — ничего не игнорируется; любой другой ненулевой — сбой (null).
 */
async function ignoredIn(root: string, keys: string[]): Promise<Set<string> | null> {
  if (keys.length === 0) return new Set();
  const { code, stdout } = await gitRaw(
    ['-C', root, 'check-ignore', '-z', '--stdin'],
    keys.join('\0') + '\0',
  );
  if (code !== 0 && code !== 1) return null;
  return new Set(stdout.split('\0').filter((p) => p !== ''));
}

/** Запись годится: относительный путь без «..», пустых сегментов и без первого сегмента `.git`. */
function safeEntry(entry: string): boolean {
  if (entry === '' || entry.startsWith('/') || path.isAbsolute(entry)) return false;
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) return false;
  return segments[0] !== '.git';
}

/** Записи списка в основной копии: пути от корня без завершающего «/», по алфавиту, без вложенных в уже выбранный каталог. Сбой — []. */
export async function listIncludePaths(sourceRoot: string): Promise<string[]> {
  try {
    const listFile = path.join(sourceRoot, WORKTREE_INCLUDE_FILE);
    const info = await lstat(listFile).catch(() => null);
    if (!info || !info.isFile() || info.size === 0 || info.size > INCLUDE_MAX_FILE_BYTES) return [];

    const listed = await lsIgnored(sourceRoot, `--exclude-from=${listFile}`);
    if (!listed || listed.length === 0) return [];
    const ignored = await lsIgnored(sourceRoot, '--exclude-standard');
    if (!ignored) return [];
    const ignoredSet = new Set(ignored);

    // Ключ — запись как её отдал git (каталог с «/»): по нему проверяется игнор в самой основной копии.
    const keys = listed
      .filter((entry) => ignoredSet.has(entry))
      .filter((entry) => safeEntry(entry.endsWith('/') ? entry.slice(0, -1) : entry));
    // `--directory` отдаёт и каталог, в котором игнорируется только вложенное (`packages/a/` при правиле `dist/`):
    // сам такой каталог не игнорируется, в копию он не идёт, а его вложенная запись остаётся в списке.
    const ignoredSelf = await ignoredIn(sourceRoot, keys);
    if (!ignoredSelf) return [];
    const unique = [
      ...new Set(
        keys
          .filter((key) => ignoredSelf.has(key))
          .map((key) => (key.endsWith('/') ? key.slice(0, -1) : key)),
      ),
    ].sort();

    // Вложенной считается запись под именем выбранной записи плюс «/»: «ab» не лежит в «a».
    const kept: string[] = [];
    const keptSet = new Set<string>();
    for (const entry of unique) {
      const segments = entry.split('/');
      let nested = false;
      for (let i = 1; i < segments.length; i += 1) {
        if (keptSet.has(segments.slice(0, i).join('/'))) {
          nested = true;
          break;
        }
      }
      if (nested) continue;
      const entryInfo = await lstat(path.join(sourceRoot, entry)).catch(() => null);
      if (!entryInfo || entryInfo.isSymbolicLink()) continue;
      kept.push(entry);
      keptSet.add(entry);
      if (kept.length >= INCLUDE_MAX_ENTRIES) break;
    }
    return kept;
  } catch {
    return [];
  }
}

/** Те же записи, что игнорируются и в новой копии. Сбой — []. */
export async function resolveIncludePaths(
  sourceRoot: string,
  targetRoot: string,
): Promise<string[]> {
  try {
    const entries = await listIncludePaths(sourceRoot);
    if (entries.length === 0) return [];
    // Каталог подаётся с «/»: правило вида `node_modules/` не совпадает с каталогом, которого в копии ещё нет.
    const asked = new Map<string, string>();
    for (const entry of entries) {
      const info = await lstat(path.join(sourceRoot, entry)).catch(() => null);
      asked.set(info?.isDirectory() ? `${entry}/` : entry, entry);
    }
    const ignoredHere = await ignoredIn(targetRoot, [...asked.keys()]);
    if (!ignoredHere) return [];
    return [...asked].filter(([key]) => ignoredHere.has(key)).map(([, entry]) => entry);
  } catch {
    return [];
  }
}
