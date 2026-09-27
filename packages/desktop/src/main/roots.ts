/**
 * Реестр корней файлов (спека 10.8, кусок 5.2): папки, внутри которых окну можно
 * читать, писать, открывать и показывать файлы, — проект каждой работы и worktree
 * её сессий. Агент может положить в worktree что угодно, в том числе симлинки
 * наружу, поэтому сравниваются только `realpath` обеих сторон.
 */
import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorksSnapshot } from '@harnas/protocol';
import type { FileRoot } from '../shared/files-types.js';
import type { FileRootSpec } from '../shared/layout-types.js';
import { rootKey, workKey as makeWorkKey } from '../shared/work-keys.js';
import { HostError } from './host-connection.js';

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
  /** realpath корня — cwd для git (7.1b) и сверка каталога записи; нет корня — FilesDeniedError. */
  rootPath(root: FileRoot): string;
}

interface RootEntry extends RootPath {
  root: FileRoot;
}

/** Корень для сравнения путей: realpath и признак тома без учёта регистра. */
export interface RootPath {
  /** realpath корня. */
  absPath: string;
  /** Том корня не различает регистр: stat корня и его пути в другом регистре — один dev/ino. */
  caseInsensitive: boolean;
}

/** Каталоги, запись в которые из окна обошла бы git и `map.lock` хоста (спека 10.8, п. 4). */
const WRITE_FORBIDDEN_SEGMENTS = new Set(['.git', '.harnas']);

/**
 * Путь цели относительно корня, если цель внутри него (сам корень — ''), иначе null.
 * Байтовое сравнение ошиблось бы на macOS: имя с диска и имя из запроса бывают в
 * разных формах Unicode (NFC/NFD) и, на томе без учёта регистра, в разном регистре.
 * Регистр сглаживается только у такого тома: на чувствительном `proj` рядом с `Proj` —
 * другой каталог. Сравнение по звеньям, а не по префиксу строки: `Proj2` не внутри `Proj`.
 */
export function relativeInside(root: RootPath, target: string): string | null {
  const fold = (p: string): string[] => {
    const nfc = p.normalize('NFC');
    return (root.caseInsensitive ? nfc.toLowerCase() : nfc).split(path.sep).filter((s) => s !== '');
  };
  const base = fold(root.absPath);
  const full = fold(target);
  if (full.length < base.length || base.some((segment, i) => segment !== full[i])) return null;
  // Хвост — из NFC-формы исходного регистра: число звеньев сглаживание не меняет.
  return target.normalize('NFC').split(path.sep).filter((s) => s !== '').slice(base.length).join(path.sep);
}

/** Регистр каждой буквы наоборот: путь «в другом регистре» для пробы тома. */
function swapCase(p: string): string {
  return [...p].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
}

/** Проба тома корня: путь в другом регистре ведёт в тот же каталог. Без букв или при ошибке — с учётом регистра (строже). */
async function probeCaseInsensitive(absPath: string): Promise<boolean> {
  const swapped = swapCase(absPath);
  if (swapped === absPath) return false;
  try {
    const [a, b] = await Promise.all([stat(absPath), stat(swapped)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function hasForbiddenSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => WRITE_FORBIDDEN_SEGMENTS.has(segment.toLowerCase()));
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Ошибка диска в resolve: нет пути — `not_found` (окно отличает его от отказа), прочее
 * (ENAMETOOLONG, ENOTDIR, ELOOP, EACCES…) — `files:denied`: контракт resolve — только отказ.
 */
function diskError(error: unknown, relPath: string): Error {
  if (isEnoent(error)) return new HostError('not_found', `no such path: ${relPath}`);
  const code = (error as { code?: unknown } | null)?.code;
  return new FilesDeniedError(`cannot resolve ${relPath}: ${typeof code === 'string' ? code : 'error'}`);
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
        realpathOrNull(candidate.dir).then(async (absPath) =>
          absPath === null
            ? null
            : { root: { workKey: key, spec: candidate.spec }, absPath, caseInsensitive: await probeCaseInsensitive(absPath) },
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
    const target = path.resolve(entry.absPath, relPath);
    const lexical = relativeInside(entry, target);
    if (lexical === null) throw new FilesDeniedError(`path escapes root: ${relPath}`);

    if (mode === 'read') {
      const real = await realpath(target).catch((error: unknown) => {
        throw diskError(error, relPath);
      });
      if (relativeInside(entry, real) === null) throw new FilesDeniedError(`path escapes root via link: ${relPath}`);
      return real;
    }

    // Запись: лексическая проверка `.git`/`.harnas` ещё до диска — `.GIT/config` на
    // регистрозависимом диске иначе упал бы с ENOENT, а не отказом.
    if (hasForbiddenSegment(lexical)) throw new FilesDeniedError(`write into protected folder: ${relPath}`);

    let real: string;
    let link: Stats | null;
    try {
      link = await lstat(target);
    } catch (error) {
      if (!isEnoent(error)) throw diskError(error, relPath);
      link = null;
    }
    if (link === null) {
      // Файла нет: проверяем родителя, новый файл ляжет в его realpath. Нет и родителя — not_found.
      const parent = await realpath(path.dirname(target)).catch((error: unknown) => {
        throw diskError(error, relPath);
      });
      real = path.join(parent, path.basename(target));
    } else {
      try {
        real = await realpath(target);
      } catch (error) {
        // Висячая ссылка: иначе проверка ушла бы к родителю, и файл создался бы по ссылке снаружи.
        if (link.isSymbolicLink() && isEnoent(error)) throw new FilesDeniedError(`dangling link: ${relPath}`);
        throw diskError(error, relPath);
      }
    }
    const inside = relativeInside(entry, real);
    if (inside === null) throw new FilesDeniedError(`path escapes root via link: ${relPath}`);
    // Ссылка `foo → .git` и файл `.git` в корне worktree видны только по realpath.
    if (hasForbiddenSegment(inside)) throw new FilesDeniedError(`write into protected folder: ${relPath}`);
    return real;
  };

  const locate: RootsRegistry['locate'] = async (key, absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    // Только корни своей работы: у работ одного проекта корень `project` общий, и поиск
    // по всем отдал бы путь одной из них (спека 10.8).
    let best: { entry: RootEntry; relPath: string } | null = null;
    for (const entry of entries.get(key) ?? []) {
      const relPath = relativeInside(entry, real);
      if (relPath === null) continue;
      if (best === null || entry.absPath.length > best.entry.absPath.length) best = { entry, relPath };
    }
    return best === null ? null : { root: best.entry.root, relPath: best.relPath };
  };

  const insideAnyRoot: RootsRegistry['insideAnyRoot'] = async (absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    for (const list of entries.values()) {
      if (list.some((entry) => relativeInside(entry, real) !== null)) return real;
    }
    return null;
  };

  return {
    resolve,
    locate,
    insideAnyRoot,
    roots: (key) => (entries.get(key) ?? []).map((entry) => ({ spec: entry.root.spec, absPath: entry.absPath })),
    expandHome,
    rootPath: (root) => {
      const entry = findRoot(root);
      if (entry === undefined) throw new FilesDeniedError(`unknown root: ${rootKey(root)}`);
      return entry.absPath;
    },
  };
}
