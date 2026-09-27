/**
 * Реестр корней файлов (спека 10.8, кусок 5.2): папки, внутри которых окну можно
 * читать, писать, открывать и показывать файлы, — проект каждой работы и worktree
 * её сессий. Агент может положить в worktree что угодно, в том числе симлинки
 * наружу, поэтому сравниваются только `realpath` обеих сторон.
 */
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorksSnapshot } from '@harnas/protocol';
import type { FileRoot } from '../shared/files-types.js';
import type { FileRootSpec } from '../shared/layout-types.js';
import { rootKey, workKey as makeWorkKey } from '../shared/work-keys.js';

export interface RootsSource {
  /** `connection.call('works.list', {})`. */
  list(): Promise<WorksSnapshot>;
  /** Событие `works.changed`. */
  onChange(listener: (snapshot: WorksSnapshot) => void): () => void;
  /** Каждое (пере)подключение к хосту: connection.onStatus → connected. Снимок работ новому клиенту хост не шлёт. */
  onConnected(listener: () => void): () => void;
}

/** Код files:denied. Текст — английский технический, для консоли: человеку окно показывает S.files.denied по коду. */
export class FilesDeniedError extends Error {
  readonly code = 'files:denied';

  constructor(message: string) {
    super(message);
    this.name = 'FilesDeniedError';
  }
}

export interface RootsRegistry {
  /** realpath цели внутри realpath корня; для записи — правила спеки 10.8; иначе FilesDeniedError. */
  resolve(root: FileRoot, relPath: string, mode: 'read' | 'write'): Promise<string>;
  /** Корень работы workKey, которому принадлежит путь: самый длинный realpath среди её корней (проект и worktree её сессий). */
  locate(workKey: string, absPath: string): Promise<{ root: FileRoot; relPath: string } | null>;
  /** realpath пути, если он внутри корня любой работы (openPath, showInFinder); иначе null. */
  insideAnyRoot(absPath: string): Promise<string | null>;
  roots(workKey: string): Array<{ spec: FileRootSpec; absPath: string }>;
  /**
   * `~` и `~/…` по дому реестра; прочее — как есть. Сверх интерфейса брифа: `openPath` и
   * `showInFinder` раскрывают путь тем же домом, что `locate`, а не своим.
   */
  expandHome(p: string): string;
}

interface RootEntry {
  root: FileRoot;
  /** realpath корня. */
  absPath: string;
}

/** Каталоги, запись в которые из окна обошла бы git и `map.lock` хоста (спека 10.8, п. 4). */
const WRITE_FORBIDDEN_SEGMENTS = new Set(['.git', '.harnas']);

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

function hasForbiddenSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => WRITE_FORBIDDEN_SEGMENTS.has(segment.toLowerCase()));
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Корни снимка с realpath; корень, чей realpath не читается (worktree удалён), пропускается. */
async function buildEntries(snapshot: WorksSnapshot): Promise<Map<string, RootEntry[]>> {
  const pending: Array<Promise<RootEntry | null>> = [];
  for (const entry of snapshot.entries) {
    const key = makeWorkKey(entry.projectPath, entry.map.work.id);
    const candidates: Array<{ spec: FileRootSpec; dir: string }> = [{ spec: { kind: 'project' }, dir: entry.projectPath }];
    for (const session of entry.map.sessions) {
      // Запланированный worktree (`createdAt: null`) ещё не создан — корнем он станет позже.
      if (session.worktree !== null && session.worktree.createdAt !== null) {
        candidates.push({ spec: { kind: 'worktree', sessionId: session.id }, dir: session.worktree.path });
      }
    }
    for (const candidate of candidates) {
      pending.push(
        realpathOrNull(candidate.dir).then((absPath) =>
          absPath === null ? null : { root: { workKey: key, spec: candidate.spec }, absPath },
        ),
      );
    }
  }
  const byWork = new Map<string, RootEntry[]>();
  for (const entry of await Promise.all(pending)) {
    if (entry === null) continue;
    const list = byWork.get(entry.root.workKey);
    if (list === undefined) byWork.set(entry.root.workKey, [entry]);
    else list.push(entry);
  }
  return byWork;
}

/** `~` в locate и insideAnyRoot раскрывается по home (по умолчанию os.homedir()). */
export function createRootsRegistry(source: RootsSource, options: { home?: string } = {}): RootsRegistry {
  const home = options.home ?? os.homedir();
  let entries = new Map<string, RootEntry[]>();
  /** Счётчик `works.changed`: ответ `list()`, за время которого пришло событие, устарел. */
  let changes = 0;
  /** Счётчик пересборок: применяется только самая поздняя — realpath асинхронный, пересборки обгоняют друг друга. */
  let builds = 0;

  const apply = async (snapshot: WorksSnapshot): Promise<void> => {
    const build = ++builds;
    const next = await buildEntries(snapshot);
    if (build === builds) entries = next;
  };

  source.onChange((snapshot) => {
    changes += 1;
    void apply(snapshot);
  });

  source.onConnected(() => {
    const seen = changes;
    source.list().then(
      (snapshot) => {
        // `works.changed`, пришедший, пока `list()` был в пути, свежее его ответа.
        if (changes !== seen) return;
        void apply(snapshot);
      },
      (error: unknown) => {
        // Отказ чтения оставляет прежние корни: следующее подключение перечитает.
        console.warn('[harnas] roots: works.list failed', error);
      },
    );
  });

  const expandHome = (p: string): string => {
    if (p === '~') return home;
    if (p.startsWith('~/')) return path.join(home, p.slice(2));
    return p;
  };

  /** realpath абсолютного пути (после `~`); относительный, с NUL или несуществующий — null. */
  const realAbs = async (p: string): Promise<string | null> => {
    const expanded = expandHome(p);
    if (expanded.includes('\0') || !path.isAbsolute(expanded)) return null;
    return realpathOrNull(expanded);
  };

  const findRoot = (root: FileRoot): RootEntry | undefined => {
    const key = rootKey(root);
    return entries.get(root.workKey)?.find((entry) => rootKey(entry.root) === key);
  };

  const resolve: RootsRegistry['resolve'] = async (root, relPath, mode) => {
    const entry = findRoot(root);
    if (entry === undefined) throw new FilesDeniedError(`unknown root: ${rootKey(root)}`);
    if (relPath.includes('\0')) throw new FilesDeniedError('path contains NUL');
    if (path.isAbsolute(relPath)) throw new FilesDeniedError(`absolute path: ${relPath}`);
    const base = entry.absPath;
    const target = path.resolve(base, relPath);
    if (!isInside(base, target)) throw new FilesDeniedError(`path escapes root: ${relPath}`);

    if (mode === 'read') {
      const real = await realpath(target);
      if (!isInside(base, real)) throw new FilesDeniedError(`path escapes root via link: ${relPath}`);
      return real;
    }

    // Запись: лексическая проверка `.git`/`.harnas` ещё до диска — `.GIT/config` на
    // регистрозависимом диске иначе упал бы с ENOENT, а не отказом.
    if (hasForbiddenSegment(path.relative(base, target))) throw new FilesDeniedError(`write into protected folder: ${relPath}`);

    let real: string;
    let link: Stats | null;
    try {
      link = await lstat(target);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      link = null;
    }
    if (link === null) {
      // Файла нет: проверяем родителя, новый файл ляжет в его realpath.
      const parent = await realpath(path.dirname(target));
      real = path.join(parent, path.basename(target));
    } else {
      try {
        real = await realpath(target);
      } catch (error) {
        // Висячая ссылка: иначе проверка ушла бы к родителю, и файл создался бы по ссылке снаружи.
        if (link.isSymbolicLink() && isEnoent(error)) throw new FilesDeniedError(`dangling link: ${relPath}`);
        throw error;
      }
    }
    if (!isInside(base, real)) throw new FilesDeniedError(`path escapes root via link: ${relPath}`);
    // Ссылка `foo → .git` и файл `.git` в корне worktree видны только по realpath.
    if (hasForbiddenSegment(path.relative(base, real))) throw new FilesDeniedError(`write into protected folder: ${relPath}`);
    return real;
  };

  const locate: RootsRegistry['locate'] = async (key, absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    // Только корни своей работы: у работ одного проекта корень `project` общий, и поиск
    // по всем отдал бы путь одной из них (спека 10.8).
    let best: RootEntry | null = null;
    for (const entry of entries.get(key) ?? []) {
      if (!isInside(entry.absPath, real)) continue;
      if (best === null || entry.absPath.length > best.absPath.length) best = entry;
    }
    if (best === null) return null;
    return { root: best.root, relPath: path.relative(best.absPath, real) };
  };

  const insideAnyRoot: RootsRegistry['insideAnyRoot'] = async (absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    for (const list of entries.values()) {
      if (list.some((entry) => isInside(entry.absPath, real))) return real;
    }
    return null;
  };

  return {
    resolve,
    locate,
    insideAnyRoot,
    roots: (key) => (entries.get(key) ?? []).map((entry) => ({ spec: entry.root.spec, absPath: entry.absPath })),
    expandHome,
  };
}
