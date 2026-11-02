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
import { STATE_DIRS } from '@parley/core';
import type { WorksSnapshot, WorksSyncRootsChange, WorksSyncSurfaceStatus, WorksSyncView } from '@parley/protocol';
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
  /**
   * realpath цели внутри realpath корня; для записи — правила спеки 10.8; иначе FilesDeniedError.
   * Корень `external` (⌘-клик по пути вне корней, 2026-10-31: только чтение): путь абсолютный или `~/…`,
   * отдаётся его realpath без сверки с корнями; запись — всегда отказ.
   */
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
  /** realpath корня — cwd для git (7.1b) и сверка каталога записи; нет корня (и у `external`) — FilesDeniedError. */
  rootPath(root: FileRoot): Promise<string>;
}

interface RootEntry extends RootPath {
  root: FileRoot;
  declaredPath: string;
  projectPath: string;
}

/** Корень для сравнения путей: realpath и признак тома без учёта регистра. */
export interface RootPath {
  /** realpath корня. */
  absPath: string;
  /** Том корня не различает регистр: stat корня и его пути в другом регистре — один dev/ino. */
  caseInsensitive: boolean;
}

/** Каталоги, запись в которые из окна обошла бы git и базу хоста (спека 10.8, п. 4). */
const WRITE_FORBIDDEN_SEGMENTS = new Set(['.git', ...STATE_DIRS]);

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

/**
 * Можно ли каталог `dir` (realpath) сделать корнем worktree работы в `projectPath`. `worktree.path`
 * берётся из карты в каталоге состояния проекта (`.parley/`, прежний `.harnas/`), а её переписывает и агент без своего worktree — путь `~`
 * иначе сделал бы корнем работы весь дом: дерево, ⌘P, поиск, запись из окна (раунд fix-final-a, M6).
 */
export type AcceptWorktree = (projectPath: string, dir: string) => Promise<boolean>;

/**
 * Политика main: каталог внутри каталога worktree харнесса (`worktreeRoot` настроек core — там их
 * заводит хост, `plannedWorktree`), не сам он; иначе — только зарегистрированный worktree проекта
 * (`isRegistered`: настройку могли сменить после создания). `worktreeRoot` читается на каждую
 * проверку: его меняют в настройках на ходу.
 */
export function worktreeRootPolicy(options: {
  home: string;
  worktreeRoot: () => Promise<string>;
  isRegistered: AcceptWorktree;
}): AcceptWorktree {
  return async (projectPath, dir) => {
    const configured = await options.worktreeRoot();
    const expanded =
      configured === '~' ? options.home : configured.startsWith('~/') ? path.join(options.home, configured.slice(2)) : configured;
    const root = await realpathOrNull(expanded);
    const inside = root === null ? null : relativeInside({ absPath: root, caseInsensitive: false }, dir);
    if (inside !== null && inside !== '') return true;
    return options.isRegistered(projectPath, dir);
  };
}

/** Отвергнутые корни worktree, о которых main уже сказал: реестр пересобирается на каждое `works.changed`. */
const rejectedWarned = new Set<string>();

/**
 * Корни снимка с realpath; корень, чей realpath не читается (worktree удалён), пропускается. Корень
 * worktree, который не принимает `accept`, не заводится — main пишет предупреждение.
 */
async function buildEntries(snapshot: WorksSnapshot, accept: AcceptWorktree | undefined): Promise<Map<string, RootEntry[]>> {
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
        realpathOrNull(candidate.dir).then(async (absPath) => {
          if (absPath === null) return null;
          if (candidate.spec.kind === 'worktree' && accept !== undefined && !(await accept(entry.projectPath, absPath))) {
            const warned = `${key}\0${candidate.spec.sessionId}\0${absPath}`;
            if (!rejectedWarned.has(warned)) {
              rejectedWarned.add(warned);
              console.warn(`[parley] roots: worktree ${absPath} of ${key} is outside the worktree root and not registered — not a root`);
            }
            return null;
          }
          return { root: { workKey: key, spec: candidate.spec }, declaredPath: candidate.dir, projectPath: entry.projectPath,
            absPath, caseInsensitive: await probeCaseInsensitive(absPath) };
        }),
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

/**
 * `~` в locate и insideAnyRoot раскрывается по home (по умолчанию os.homedir()). `acceptWorktree` —
 * политика корней worktree (`worktreeRootPolicy`, main); без неё — любой созданный worktree карты
 * (тесты реестра).
 */
export function createRootsRegistry(
  source: RootsSource,
  options: { home?: string; acceptWorktree?: AcceptWorktree } = {},
): RootsRegistry {
  const home = options.home ?? os.homedir();
  let entries = new Map<string, RootEntry[]>();
  /** Счётчик `works.changed`: ответ `list()`, за время которого пришло событие, устарел. */
  let changes = 0;
  /** Счётчик пересборок: применяется только самая поздняя — realpath асинхронный, пересборки обгоняют друг друга. */
  let builds = 0;

  /** Последняя начатая пересборка: промах реестра дожидается её, а не отказывает раньше неё. */
  let latest: Promise<void> = Promise.resolve();

  /**
   * Корни работ, ушедших из снимка (fix-7.3 п. 1): только для записи. Работу удалил другой клиент,
   * а в окне остались несохранённые правки её файлов — вопрос окна «Save» пишет их туда, где папка
   * ещё есть. Правила записи те же; корнем здесь бывает только то, что было корнем снимка.
   */
  const retired = new Map<string, RootEntry[]>();

  const apply = (snapshot: WorksSnapshot): Promise<void> => {
    const build = ++builds;
    latest = buildEntries(snapshot, options.acceptWorktree).then((next) => {
      if (build !== builds) return;
      for (const [key, list] of entries) if (!next.has(key)) retired.set(key, list);
      for (const key of next.keys()) retired.delete(key);
      entries = next;
    });
    return latest;
  };

  source.onChange((snapshot) => {
    changes += 1;
    void apply(snapshot);
  });

  /** Общая пересборка одновременных промахов: один `works.list` на пачку, не на каждый вызов. */
  let refreshing: Promise<void> | null = null;

  /**
   * Промах реестра (ревью 7.2-A, п. 6): окно видит `works.changed` раньше, чем реестр
   * пересоберётся (realpath асинхронный), и спрашивает про корень, которого реестр ещё не
   * знает. Одна пересборка по свежему `works.list` перед отказом закрывает эту гонку для всех
   * вызовов разом; отказ — только если корня нет и после неё. Повторов с паузами нет.
   */
  const refresh = (): Promise<void> => {
    if (refreshing !== null) return refreshing;
    const seen = changes;
    const run = source.list().then(
      (snapshot) => {
        // `works.changed`, пришедший, пока `list()` был в пути, свежее его ответа — ждём его пересборку.
        if (changes !== seen) return latest;
        return apply(snapshot);
      },
      (error: unknown) => {
        // Нет связи с хостом — отказ по прежним корням.
        console.warn('[parley] roots: works.list on miss failed', error);
      },
    );
    refreshing = run.finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

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
        console.warn('[parley] roots: works.list failed', error);
      },
    );
  });

  return createRootAccess({ entries: () => entries, retired, refresh }, home);
}

interface RootAccessState {
  entries(): Map<string, RootEntry[]>;
  retired: Map<string, RootEntry[]>;
  refresh(key?: string): Promise<void>;
  beforeLookup?(key?: string): Promise<void>;
  confirm?(entry: RootEntry, mode: 'read' | 'write'): Promise<void>;
}

/** Общие проверки путей для legacy и committed-sync реестров. */
function createRootAccess(state: RootAccessState, home: string): RootsRegistry {
  const { retired, refresh } = state;
  const entries = state.entries;
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
    return entries().get(root.workKey)?.find((entry) => rootKey(entry.root) === key);
  };

  /** Корень из реестра; промах — пересборка по свежему снимку и вторая проверка, затем отказ. Запись — и в ушедший корень. */
  const requireRoot = async (root: FileRoot, mode: 'read' | 'write'): Promise<RootEntry> => {
    try {
      await state.beforeLookup?.(root.workKey);
    } catch {
      const saved = mode === 'write' && retired.get(root.workKey)?.find(candidate => rootKey(candidate.root) === rootKey(root));
      if (!saved) throw new FilesDeniedError('works sync is not current');
      await state.confirm?.(saved, mode);
      return saved;
    }
    let entry = findRoot(root);
    if (entry === undefined) {
      await refresh(root.workKey);
      entry = findRoot(root);
    }
    if (entry === undefined && mode === 'write') {
      const key = rootKey(root);
      entry = retired.get(root.workKey)?.find((candidate) => rootKey(candidate.root) === key);
    }
    if (entry === undefined) throw new FilesDeniedError(`unknown root: ${rootKey(root)}`);
    await state.confirm?.(entry, mode);
    return entry;
  };

  /** Работа известна реестру (промах — пересборка, как у корня): внешний файл читается во вкладке работы. */
  const requireWork = async (key: string): Promise<void> => {
    try { await state.beforeLookup?.(key); } catch { throw new FilesDeniedError('works sync is not current'); }
    if (entries().has(key)) return;
    await refresh(key);
    if (!entries().has(key)) throw new FilesDeniedError(`unknown work: ${key}`);
  };

  /** Внешний корень (2026-10-31): только чтение; путь абсолютный или `~/…`, без сверки с корнями — отдаётся realpath. */
  const resolveExternal = async (root: FileRoot, target: string, mode: 'read' | 'write'): Promise<string> => {
    if (mode === 'write') throw new FilesDeniedError('external files are read-only');
    await requireWork(root.workKey);
    if (target.includes('\0')) throw new FilesDeniedError('path contains NUL');
    const expanded = expandHome(target);
    if (!path.isAbsolute(expanded)) throw new FilesDeniedError(`relative path in external root: ${target}`);
    const real = await realpath(expanded).catch((error: unknown) => {
      throw diskError(error, target);
    });
    await requireWork(root.workKey);
    return real;
  };

  const resolve: RootsRegistry['resolve'] = async (root, relPath, mode) => {
    if (root.spec.kind === 'external') return resolveExternal(root, relPath, mode);
    const entry = await requireRoot(root, mode);
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
      await state.confirm?.(entry, mode);
      return real;
    }

    // Запись: лексическая проверка `.git`/каталога состояния ещё до диска — `.GIT/config` на
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
    await state.confirm?.(entry, mode);
    return real;
  };

  const locateIn = (key: string, real: string): { root: FileRoot; relPath: string } | null => {
    // Только корни своей работы: у работ одного проекта корень `project` общий, и поиск
    // по всем отдал бы путь одной из них (спека 10.8).
    let best: { entry: RootEntry; relPath: string } | null = null;
    for (const entry of entries().get(key) ?? []) {
      const relPath = relativeInside(entry, real);
      if (relPath === null) continue;
      if (best === null || entry.absPath.length > best.entry.absPath.length) best = { entry, relPath };
    }
    return best === null ? null : { root: best.entry.root, relPath: best.relPath };
  };

  const locate: RootsRegistry['locate'] = async (key, absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    try { await state.beforeLookup?.(key); } catch { return null; }
    // Промах — возможно, корень (новая работа, новый worktree) ещё не дошёл до реестра.
    const found = locateIn(key, real);
    if (found !== null) return found;
    await refresh(key);
    return locateIn(key, real);
  };

  const insideAny = (real: string): boolean => {
    for (const list of entries().values()) {
      if (list.some((entry) => relativeInside(entry, real) !== null)) return true;
    }
    return false;
  };

  const insideAnyRoot: RootsRegistry['insideAnyRoot'] = async (absPath) => {
    const real = await realAbs(absPath);
    if (real === null) return null;
    try { await state.beforeLookup?.(); } catch { return null; }
    if (insideAny(real)) return real;
    await refresh();
    return insideAny(real) ? real : null;
  };

  return {
    resolve,
    locate,
    insideAnyRoot,
    roots: (key) => (entries().get(key) ?? []).map((entry) => ({ spec: entry.root.spec, absPath: entry.absPath })),
    expandHome,
    rootPath: async (root) => {
      // У внешнего файла нет корня-папки и git.
      if (root.spec.kind === 'external') throw new FilesDeniedError('external root has no folder');
      const entry = await requireRoot(root, 'read');
      await state.confirm?.(entry, 'read');
      return entry.absPath;
    },
  };
}

/** Только committed view P4; страницы и промежуточный reducer сюда не передаются. */
export interface SyncRootsSource {
  readonly view: WorksSyncView;
  readonly status: WorksSyncSurfaceStatus;
  snapshotForLookup(): Promise<WorksSnapshot>;
  onCommit(listener: (change: WorksSyncRootsChange) => void): () => void;
}

/** Opt-in адаптер; production wiring и capability остаются отдельным шагом P4/P7. */
export function createSyncRootsRegistry(
  source: SyncRootsSource,
  options: { home?: string; acceptWorktree?: AcceptWorktree } = {},
): RootsRegistry & { dispose(): void } {
  type Work = WorksSnapshot['entries'][number];
  type Build = { work: Work; pending?: Promise<void>; dirty: boolean };
  const entries = new Map<string, RootEntry[]>();
  const retired = new Map<string, RootEntry[]>();
  const works = new Map<string, Build>();
  let epoch: string | null = null;
  let disposed = false;
  const keyOf = (work: Work): string => makeWorkKey(work.projectPath, work.map.work.id);
  const current = (): boolean => !disposed && source.status.state === 'current';
  const assertCurrent = async (): Promise<void> => {
    if (disposed) throw new FilesDeniedError('roots registry disposed');
    let snapshot: WorksSnapshot;
    try { snapshot = await source.snapshotForLookup(); } catch { throw new FilesDeniedError('works sync is not current'); }
    if (!current() || source.view.snapshot !== snapshot) throw new FilesDeniedError('works sync is not current');
  };

  const build = (key: string, state: Build): Promise<void> => {
    if (state.pending) return state.pending;
    state.pending = buildEntries({ entries: [state.work], branches: {} }, options.acceptWorktree).then(async next => {
      // Проверка после диска: за время realpath/policy мог начаться reset или удалиться работа.
      await assertCurrent();
      if (!current() || works.get(key) !== state) return;
      const verified = next.get(key);
      if (verified?.length) entries.set(key, verified);
      else entries.delete(key);
      retired.delete(key);
      state.dirty = false;
    }).catch(() => {
      // Ошибка или устаревшая сборка не создаёт ни активных, ни retired корней.
      state.dirty = true;
    }).finally(() => { delete state.pending; });
    return state.pending;
  };

  const reconcile = (): void => {
    if (disposed || source.view.epoch === null) return;
    const next = new Map(source.view.snapshot.entries.map(work => [keyOf(work), work]));
    const reset = epoch !== source.view.epoch;
    epoch = source.view.epoch;
    // Отзыв синхронный: удаление не ждёт realpath других работ.
    for (const key of works.keys()) {
      if (next.has(key)) continue;
      const verified = entries.get(key);
      if (verified?.length) retired.set(key, verified);
      entries.delete(key);
      works.delete(key);
    }
    for (const [key, work] of next) {
      const previous = works.get(key);
      if (!reset && previous?.work === work) continue;
      // Уже разрешённые неизменившиеся пути сохраняются; удалённые worktree отзываются сразу.
      const declared = new Map<string, string>([[rootKey({ workKey: key, spec: { kind: 'project' } }), work.projectPath]]);
      for (const session of work.map.sessions) {
        if (session.worktree !== null && session.worktree.createdAt !== null) {
          declared.set(rootKey({ workKey: key, spec: { kind: 'worktree', sessionId: session.id } }), session.worktree.path);
        }
      }
      const retained = (entries.get(key) ?? []).filter(entry => declared.get(rootKey(entry.root)) === entry.declaredPath);
      if (retained.length) entries.set(key, retained);
      else entries.delete(key);
      // Возвращённая работа не наследует write-only разрешения прежней инкарнации.
      retired.delete(key);
      works.set(key, { work, dirty: true });
    }
    for (const [key, state] of works) if (state.dirty && !state.pending) void build(key, state);
  };

  const unsubscribe = source.onCommit(change => {
    if (source.status.state !== 'current' && source.status.state !== 'catching-up') return;
    if (change.complete !== source.view.snapshot || change.epoch !== source.view.epoch || change.revision !== source.view.revision) return;
    reconcile();
  });
  if (current()) reconcile();

  const ensure = async (key?: string): Promise<void> => {
    await assertCurrent();
    const states = key === undefined ? [...works.values()] : [works.get(key)].filter((state): state is Build => state !== undefined);
    await Promise.all(states.map(state => state.pending ?? (state.dirty ? build(keyOf(state.work), state) : Promise.resolve())));
    await assertCurrent();
  };

  const confirm = async (entry: RootEntry, mode: 'read' | 'write'): Promise<void> => {
    const key = entry.root.workKey;
    const isRetired = (): boolean => mode === 'write' && (retired.get(key)?.includes(entry) ?? false);
    if (!isRetired()) {
      await assertCurrent();
      if (!entries.get(key)?.includes(entry)) throw new FilesDeniedError('root was revoked');
    }
    // Повторно проверяем исходный путь, а не только прежний realpath: удалённый или
    // перенаправленный worktree не должен разрешать Save по старому адресу.
    const real = await realpath(entry.declaredPath).catch((error: unknown) => { throw diskError(error, entry.declaredPath); });
    if (real !== entry.absPath) throw new FilesDeniedError('root path was repointed');
    if (isRetired() && entry.root.spec.kind === 'worktree' && options.acceptWorktree && !(await options.acceptWorktree(entry.projectPath, real))) {
      throw new FilesDeniedError('worktree is outside allowed roots');
    }
    if (isRetired()) return;
    await assertCurrent();
    if (!current() || !entries.get(key)?.includes(entry)) throw new FilesDeniedError('root was revoked');
  };

  const refresh = async (key?: string): Promise<void> => {
    // Адресный промах: worktree мог появиться на диске после committed события.
    const state = key === undefined ? undefined : works.get(key);
    if (state) state.dirty = true;
    await ensure(key);
  };
  const hidden = new Map<string, RootEntry[]>();
  const registry = createRootAccess({ entries: () => current() ? entries : hidden, retired, beforeLookup: ensure, refresh, confirm }, options.home ?? os.homedir());
  return { ...registry, dispose: () => { disposed = true; unsubscribe(); works.clear(); entries.clear(); retired.clear(); } };
}
