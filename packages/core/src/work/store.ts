import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LIMITS_DIR, limitsFile } from '../limits.js';
import { envValue, HOME_DIR, LEGACY_HOME_DIR, type Env } from '../names.js';
import { bumpWorkId, nextWorkId, parseMap } from './map.js';
import { PRE_JOURNAL_STATE_IGNORE, PRE_MEMORY_STATE_IGNORE, PRE_RECIPES_STATE_IGNORE, ensureStateDir, isDirectorySync, stateDir, SHARED_STATE_IGNORE } from './state-dir.js';
import { resolveSharedProjectContext, sharedPathIgnored } from './project-context.js';
import type { ProjectContextOptions, SharedProjectContext } from './project-context.js';
import type { WorkIndexEntry, WorkMap, WorksIndex, WorkStatus } from './types.js';

/**
 * Домашняя папка Parley (R4), первое подходящее:
 * 1. `PARLEY_HOME`; 2. `HARNAS_HOME` — этим живут тесты и второй дом;
 * 3. `~/.parley`, если он есть; 4. `~/.harnas`, если он есть — данные человека со времён имени harnas;
 * 5. иначе `~/.parley`.
 * Пустая переменная — то же, что незаданная. `env` и `userHome` подменяет тест.
 */
export function parleyHome(env: Env = process.env, userHome: string = homedir()): string {
  const explicit = envValue(env, 'HOME');
  if (explicit !== undefined) return explicit;
  const current = path.join(userHome, HOME_DIR);
  if (isDirectorySync(current)) return current;
  const legacy = path.join(userHome, LEGACY_HOME_DIR);
  return isDirectorySync(legacy) ? legacy : current;
}

/** Глобальный индекс работ: все работы всех проектов. */
export function worksIndexPath(): string {
  return path.join(parleyHome(), 'works-index.json');
}

export interface WorkPaths {
  dir: string;
  map: string;
  bak: string;
  lock: string;
  briefs: string;
  artifacts: string;
  /** Сгенерированные MCP-конфиги сессий: `mcp/<session-id>.json`. */
  mcp: string;
  /** Журналы событий хуков: `events/<session-id>.jsonl`, пишет сам хук. */
  events: string;
  /** Лимиты подписки от строки статуса Claude Code: `limits/<session-id>.json`, пишет её скрипт. */
  limits: string;
  /** Хуки Claude Code для сессий работы (`--settings`), один файл на работу. */
  settings: string;
}

/** Раскладка работы на диске (спецификация, раздел 2) в каталоге состояния проекта (`stateDir`). */
export function workPaths(projectPath: string, workId: string): WorkPaths {
  const dir = path.join(stateDir(projectPath), 'works', workId);
  return {
    dir,
    map: path.join(dir, 'map.json'),
    bak: path.join(dir, 'map.json.bak'),
    lock: path.join(dir, 'map.lock'),
    briefs: path.join(dir, 'briefs'),
    artifacts: path.join(dir, 'artifacts'),
    mcp: path.join(dir, 'mcp'),
    events: path.join(dir, 'events'),
    limits: path.join(dir, LIMITS_DIR),
    settings: path.join(dir, 'settings.json'),
  };
}

export interface WriteOptions {
  /** Блокировка, не снятая за это время, — ошибка вызова, а не тихое ожидание. */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const RETRY_MS = 20;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Таймаут `map.lock` — отдельный класс, а не голая `Error`: карту пишут трое
 * (хост, CLI и MCP-серверы агентов), и хосту нужно отличить именно занятость
 * блокировки от прочих сбоев записи, чтобы не падать, а сообщить `host.notice`
 * и повторить на следующем событии (план, кусок 1.4).
 */
export class MapLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`lock ${lockFile} was not released within ${timeoutMs} ms`);
    this.name = 'MapLockTimeoutError';
  }
}

/**
 * Работы нет — отдельный класс, как `MapLockTimeoutError`: хосту нужно ответить
 * `not_found`, а не `internal`, и в том числе когда каталог работы удалили
 * (`works.delete` другого клиента), пока запись ждала `map.lock`.
 */
export class WorkNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkNotFoundError';
  }
}

/** Эксклюзивное создание файла — атомарная операция файловой системы. */
async function acquireLock(lockFile: string, timeoutMs: number,
  timeoutError: () => Error = () => new MapLockTimeoutError(lockFile, timeoutMs), mode = 0o666,
): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(lockFile, 'wx', mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw timeoutError();
      }
      await delay(RETRY_MS);
    }
  }
}

async function releaseLock(handle: FileHandle, lockFile: string): Promise<void> {
  await handle.close();
  await rm(lockFile, { force: true });
}

async function withLock<T>(
  lockFile: string,
  timeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(lockFile, timeoutMs);
  try {
    return await body();
  } finally {
    await releaseLock(handle, lockFile);
  }
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Временный файл + rename: читатель видит либо старую карту, либо новую. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/** Читает карту работы. Битый файл — ошибка, догадки не строим. */
export async function readMap(projectPath: string, workId: string): Promise<WorkMap> {
  const file = workPaths(projectPath, workId).map;
  return parseMap(await readFile(file, 'utf8'), file);
}

/**
 * Убирает с диска следы удалённой сессии: бриф, журнал событий и MCP-конфиг
 * (план от 2026-09-06, раздел C). Артефакты не трогаем — это результат работы,
 * а не след сессии. Отсутствие любого файла — не ошибка: журнала может не быть
 * вовсе, а бриф не пишется быстрой сессии `new`.
 *
 * `projectPath` — проект ЗАПИСИ работы: закреплённая работа лежит в чужом
 * проекте, и путь харнесса удалил бы файлы не там.
 */
export async function deleteSessionFiles(
  projectPath: string,
  workId: string,
  sessionId: string,
): Promise<void> {
  const paths = workPaths(projectPath, workId);
  const files = [
    path.join(paths.briefs, `${sessionId}.md`),
    path.join(paths.events, `${sessionId}.jsonl`),
    path.join(paths.mcp, `${sessionId}.json`),
    limitsFile(paths.dir, sessionId),
  ];
  await Promise.all(files.map((file) => rm(file, { force: true })));
}

/**
 * Удаляет работу целиком: каталог `<состояние>/works/<id>` со всем содержимым,
 * включая артефакты, и её запись в глобальном индексе. Каталога уже нет —
 * не ошибка: запись из индекса всё равно снимается.
 */
export async function deleteWorkFiles(
  projectPath: string,
  workId: string,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: WriteOptions = {},
): Promise<void> {
  await rm(workPaths(projectPath, workId).dir, { recursive: true, force: true });
  await withWorksIndex(lockTimeoutMs, (index) => {
    index.works = index.works.filter(
      (work) => !(work.id === workId && work.projectPath === projectPath),
    );
  });
}

/**
 * Читает глобальный индекс; файла ещё нет — индекс пустой. `file` — индекс не текущего дома, а другого:
 * перенос дома читает прежний, пока тот ещё не переехал.
 */
export async function readWorksIndex(file: string = worksIndexPath()): Promise<WorksIndex> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, works: [] };
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`workspace index ${file} cannot be parsed: ${(error as Error).message}`);
  }
  const works = (data as Partial<WorksIndex>).works;
  if ((data as Partial<WorksIndex>).schemaVersion !== 1 || !Array.isArray(works)) {
    throw new Error(`workspace index ${file} cannot be parsed: unexpected shape`);
  }
  return { schemaVersion: 1, works };
}

/** Читает индекс, даёт его изменить и записывает — всё под своей блокировкой. */
async function withWorksIndex<T>(
  timeoutMs: number,
  mutate: (index: WorksIndex) => T | Promise<T>,
): Promise<T> {
  const file = worksIndexPath();
  await mkdir(path.dirname(file), { recursive: true });
  return withLock(path.join(path.dirname(file), 'works-index.lock'), timeoutMs, async () => {
    const index = await readWorksIndex();
    const result = await mutate(index);
    await writeAtomic(file, serialize(index));
    return result;
  });
}

const entryOf = (projectPath: string, map: WorkMap): WorkIndexEntry => ({
  id: map.work.id,
  projectPath,
  title: map.work.title,
  status: map.work.status,
  updatedAt: map.work.updatedAt,
});

function upsert(index: WorksIndex, entry: WorkIndexEntry): void {
  const at = index.works.findIndex(
    (work) => work.id === entry.id && work.projectPath === entry.projectPath,
  );
  if (at === -1) index.works.push(entry);
  else index.works[at] = entry;
}

/**
 * Снимает из глобального индекса записи, у которых карты на диске больше нет:
 * каталог работы снесли руками, проект удалили или переехал. Автоматически при
 * чтении так не делается — закреплённая чужая работа на отключённом диске
 * выглядит так же. Возвращает снятые записи.
 */
export async function pruneWorksIndex({
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
}: WriteOptions = {}): Promise<WorkIndexEntry[]> {
  return withWorksIndex(lockTimeoutMs, async (index) => {
    const removed: WorkIndexEntry[] = [];
    const kept: WorkIndexEntry[] = [];
    for (const entry of index.works) {
      const alive = await stat(workPaths(entry.projectPath, entry.id).map)
        .then((info) => info.isFile())
        .catch(() => false);
      (alive ? kept : removed).push(entry);
    }
    index.works = kept;
    return removed;
  });
}

export interface NewWork {
  title: string;
  goal?: string;
}

/**
 * Создаёт работу: резервирует id в глобальном индексе (под его блокировкой,
 * поэтому два процесса не получат один номер), раскладывает каталоги и пишет карту.
 * Индекс — не единственный источник занятых номеров: он глобальный и может быть
 * пустым, когда карты в проекте уже лежат (clone проекта с закоммиченным каталогом состояния,
 * перенос дома, копия проекта). Поэтому занятые на диске id пропускаются,
 * а сама запись идёт эксклюзивным `wx` — чужую карту не затираем никогда.
 */
export async function createWork(
  projectPath: string,
  init: NewWork,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: WriteOptions = {},
): Promise<WorkMap> {
  const at = new Date().toISOString();
  const map: WorkMap = {
    schemaVersion: 2,
    work: {
      id: 'w-0000',
      title: init.title,
      goal: init.goal ?? '',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
    sessions: [],
    messages: [],
    rooms: [],
  };

  // Карта пишется под блокировкой индекса и раньше самого индекса: наблюдатель
  // дома перечитывает список по записи индекса, и запись без карты он молча
  // пропустил бы. За каталогом нового проекта ещё никто не следит, так что без
  // этого порядка первая работа проекта не появилась бы в списке до следующей
  // записи какой-нибудь карты. Сбой записи карты — и индекс не тронут.
  await withWorksIndex(lockTimeoutMs, async (index) => {
    let id = nextWorkId(index);
    while (await exists(workPaths(projectPath, id).map)) id = bumpWorkId(id);
    map.work.id = id;

    // Каталог состояния — до путей работы: новый `.parley` получает свой `.gitignore` (R5).
    await ensureStateDir(projectPath);
    const paths = workPaths(projectPath, id);
    await mkdir(paths.briefs, { recursive: true });
    await mkdir(paths.artifacts, { recursive: true });
    const text = serialize(map);
    await withLock(paths.lock, lockTimeoutMs, async () => {
      try {
        await writeFile(paths.map, text, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new Error(`map ${paths.map} already exists — the workspace was not created`);
      }
      // `.bak` с первой же записи: раздел 8 обещает предыдущую версию для любой карты.
      await writeFile(paths.bak, text, 'utf8');
    });
    index.works.push(entryOf(projectPath, map));
  });
  return map;
}

/**
 * Единственный способ изменить карту: читаем и пишем под блокировкой `map.lock`,
 * поэтому параллельные писатели не затирают друг друга. Прежняя версия уходит
 * в `map.json.bak`, новая появляется атомарным `rename`. Битую карту не трогаем.
 */
/** Только у updateMap: createWork, deleteWorkFiles и pruneWorksIndex берут прежний WriteOptions. */
export interface UpdateMapOptions extends WriteOptions {
  /** false — `work.updatedAt` не сдвигается: правка не событие работы (порядок сайдбара, спека 6.2). */
  touch?: boolean;
}

export async function updateMap(
  projectPath: string,
  workId: string,
  mutate: (map: WorkMap) => void,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, touch = true }: UpdateMapOptions = {},
): Promise<WorkMap> {
  const paths = workPaths(projectPath, workId);
  // Блокировка живёт в каталоге работы, поэтому про несуществующую работу первым
  // отчитался бы ENOENT про `map.lock` — не про тот файл, которого на самом деле нет.
  const missing = (): WorkNotFoundError =>
    new WorkNotFoundError(`map ${paths.map} does not exist — workspace ${workId} does not exist`);
  if (!(await exists(paths.map))) throw missing();

  // Каталог могли удалить после проверки выше, пока ждали лок или уже под ним:
  // тогда ENOENT про `map.lock` или `map.json` — это тоже «работы нет». Решает
  // не код ошибки сам по себе, а то, что каталога работы больше нет.
  const whenGone = async (error: unknown): Promise<never> => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !(await exists(paths.dir))) {
      throw missing();
    }
    throw error;
  };

  return withLock(paths.lock, lockTimeoutMs, async () => {
    const raw = await readFile(paths.map, 'utf8');
    const current = parseMap(raw, paths.map);
    // Карта, разошедшаяся с именем каталога, — повод отказаться: иначе в индексе
    // осела бы запись с чужим id, которую в списке работ нечем открыть.
    if (current.work.id !== workId) {
      throw new Error(`map ${paths.map} belongs to workspace ${current.work.id}, not ${workId}`);
    }
    mutate(current);
    if (touch) current.work.updatedAt = new Date().toISOString();

    // Индекс обновляем до записи карты и не отпуская `map.lock`: его отказ должен
    // означать «карта не переписана», иначе ретрай вызывающего продублирует мутацию.
    // Порядок записей в индексе при этом остаётся порядком записей карты.
    await withWorksIndex(lockTimeoutMs, (index) => upsert(index, entryOf(projectPath, current)));
    await writeFile(paths.bak, raw, 'utf8');
    await writeAtomic(paths.map, serialize(current));
    return current;
  }).catch(whenGone);
}

/** Предел названия работы в кодовых точках: эмодзи — один символ, а не два UTF-16. */
const WORK_TITLE_MAX = 120;

/**
 * `trim()` не считает пробелом невидимые символы формата (ZWSP, ZWNJ, ZWJ,
 * WORD JOINER), и название из одних их выглядело бы пустой карточкой. Обрезаются
 * только края: ZWJ внутри эмодзи-последовательности нужен. Та же регулярка — в
 * схеме `works.rename` протокола.
 */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/**
 * Переименовывает работу. Не событие работы: `updatedAt` стоит на месте, иначе
 * карточка всплыла бы в начало своего ранга в сайдбаре (спека 6.2).
 */
export async function renameWork(
  projectPath: string,
  workId: string,
  title: string,
): Promise<WorkMap> {
  const trimmed = title.replace(TITLE_EDGES, '');
  const length = [...trimmed].length;
  if (length < 1 || length > WORK_TITLE_MAX) {
    throw new Error(`workspace title: 1–${WORK_TITLE_MAX} characters`);
  }
  return updateMap(projectPath, workId, (map) => (map.work.title = trimmed), { touch: false });
}

/**
 * Меняет статус работы. Живые сессии архив не трогает; и это тоже не событие
 * работы, поэтому `updatedAt` не сдвигается.
 */
export async function setWorkStatus(
  projectPath: string,
  workId: string,
  status: WorkStatus,
): Promise<WorkMap> {
  return updateMap(projectPath, workId, (map) => (map.work.status = status), { touch: false });
}


export type SharedStateErrorCode = 'project-unavailable' | 'git-context-unverified' | 'main-project-unavailable' |
  'shared-state-unsafe' | 'shared-file-too-large' | 'shared-file-unreadable' | 'backlog-lock-timeout' |
  'backlog-conflict' | 'backlog-merge-conflict' | 'backlog-invalid' | 'preferences-invalid' | 'suggestions-invalid' |
  'memory-invalid' | 'memory-merge-conflict' | 'memory-conflict' | 'memory-suggestions-invalid';
export class SharedStateError extends Error {
  constructor(readonly code: SharedStateErrorCode) { super(code); this.name = 'SharedStateError'; }
}
export interface SharedDiagnostic { code: 'parley-gitignore-custom' | 'parley-dir-ignored' }
/** Где лежит бэклог проекта: `state` — `<каталог состояния>/backlog.md`, `todos` — TODOS.md/TODO.md папки проекта. */
export type BacklogFileChoice = 'state' | 'todos';
export interface SharedProjectPaths {
  context: Exclude<SharedProjectContext, { kind: 'unavailable' }>;
  dir: string; backlog: string; plans: string; decisions: string; historyShared: string; preferences: string; suggestions: string; memory: string; memorySuggestions: string; lock: string;
  /** Сохранённый выбор файла бэклога; null — выбора не было или настройки не читаются. */
  backlogChoice: BacklogFileChoice | null;
  /** TODOS.md/TODO.md папки проекта — имя как на диске; null — такого файла нет. */
  todosFile: string | null;
}
export interface SharedWriteOptions extends ProjectContextOptions, WriteOptions {
  /** Optional optimistic version from a human editor; stale edits are refused rather than reapplied. */
  expectedVersion?: string;
  /** Deterministic external-editor fixture seam, immediately before the final comparison. */
  beforeCommit?: (file: string, attempt: number) => Promise<void>;
}

/** TODOS.md или TODO.md папки проекта, имя — как на диске, регистр не важен. Порядок: точное TODOS.md, другое написание
 * todos.md, точное TODO.md, другое написание todo.md; внутри ранга — по кодам символов. */
export async function findTodosFile(projectPath: string): Promise<string | null> {
  let names: string[];
  try { names = (await readdir(projectPath)).filter(name => /^todos?\.md$/i.test(name)); } catch { return null; }
  const rank = (name: string): number => (name.toLowerCase() === 'todos.md' ? 0 : 2) + (name === 'TODOS.md' || name === 'TODO.md' ? 0 : 1);
  return names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

/** Выбор файла бэклога для пути — без исключений: испорченные настройки дают каталог состояния. Строгая проверка — при записи. */
async function readBacklogChoice(file: string): Promise<BacklogFileChoice | null> {
  try {
    const value: unknown = JSON.parse((await readSharedFile(file)).text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const choice = record['backlogFile'];
    return record['version'] === 1 && (choice === 'state' || choice === 'todos') ? choice : null;
  } catch { return null; }
}

export async function sharedProjectPaths(projectPath: string, options: ProjectContextOptions = {}): Promise<SharedProjectPaths> {
  const context = await resolveSharedProjectContext(projectPath, options);
  if (context.kind === 'unavailable') throw new SharedStateError(context.reason);
  const dir = stateDir(context.projectPath);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SharedStateError('shared-state-unsafe');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return withBacklogChoice({ context, dir, backlog: path.join(dir, 'backlog.md'), plans: path.join(dir, 'plans'), decisions: path.join(dir, 'decisions'),
    historyShared: path.join(dir, 'history-shared'), preferences: path.join(dir, 'preferences.json'), suggestions: path.join(dir, 'backlog-suggestions.json'),
    memory: path.join(dir, 'memory.md'), memorySuggestions: path.join(dir, 'memory-suggestions.json'),
    lock: path.join(dir, 'backlog.lock'), backlogChoice: null, todosFile: null });
}
/** Файл бэклога по сохранённому выбору — без повторного определения контекста проекта (git не вызывается). */
export async function withBacklogChoice(paths: SharedProjectPaths): Promise<SharedProjectPaths> {
  const [backlogChoice, todosFile] = await Promise.all([readBacklogChoice(paths.preferences), findTodosFile(paths.context.projectPath)]);
  const backlog = backlogChoice === 'todos' ? path.join(paths.context.projectPath, todosFile ?? 'TODOS.md') : path.join(paths.dir, 'backlog.md');
  return { ...paths, backlog, backlogChoice, todosFile };
}

export interface SharedFileSnapshot { text: string; version: string }
const SHARED_FILE_LIMIT = 1024 * 1024;
export const MISSING_SHARED_VERSION = 'missing';

/** Nonblocking regular-file reads; strict UTF-8 prevents lossless Markdown replacement of bad bytes. */
export async function readSharedFile(file: string): Promise<SharedFileSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await readSharedFileOnce(file); }
    catch (error) {
      if (!(error instanceof SharedStateError) || error.code !== 'backlog-conflict') throw error;
    }
  }
  throw new SharedStateError('backlog-conflict');
}
async function readSharedFileOnce(file: string): Promise<SharedFileSnapshot> {
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', version: MISSING_SHARED_VERSION };
    throw new SharedStateError('shared-file-unreadable');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new SharedStateError('shared-file-unreadable');
    if (before.size > BigInt(SHARED_FILE_LIMIT)) throw new SharedStateError('shared-file-too-large');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new SharedStateError('backlog-conflict');
    const content = bytes.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
    catch { throw new SharedStateError('shared-file-unreadable'); }
    const version = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs,
      createHash('sha256').update(content).digest('hex')].join(':');
    return { text, version };
  } finally { await handle.close(); }
}

/** Atomic replacement, not filesystem CAS: a non-cooperating writer after comparison can still race. */
export async function writeSharedFile(file: string, text: string, expected: SharedFileSnapshot, mode = 0o600): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > SHARED_FILE_LIMIT) throw new SharedStateError('shared-file-too-large');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    if ((await readSharedFile(file)).version !== expected.version) throw new SharedStateError('backlog-conflict');
    await rename(temporary, file);
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

/** Single shared-domain lock; existing work/map paths and their lock behavior remain independent. */
export async function withSharedProjectLock<T>(paths: SharedProjectPaths, body: () => Promise<T>, options: WriteOptions = {}): Promise<T> {
  const selected = await ensureStateDir(paths.context.projectPath);
  if (selected !== paths.dir || !(await lstat(selected)).isDirectory() || (await lstat(selected)).isSymbolicLink())
    throw new SharedStateError('shared-state-unsafe');
  const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30_000) throw new SharedStateError('backlog-invalid');
  const handle = await acquireLock(paths.lock, timeout, () => new SharedStateError('backlog-lock-timeout'), 0o600);
  const identity = await handle.stat();
  try { return await body(); }
  finally {
    await releaseSharedLock(handle, paths.lock, identity);
  }
}

async function releaseSharedLock(handle: FileHandle, file: string, identity: { dev: number; ino: number }): Promise<void> {
  await handle.close();
  // Do not remove an observed replacement lock. Portable compare/unlink still has a small TOCTOU.
  try {
    const current = await lstat(file);
    if (current.dev === identity.dev && current.ino === identity.ino) await rm(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Private history receipt lock: selected checkout only, without native main discovery. */
export async function withLocalHistoryLock<T>(root: string, parent: string, body: () => Promise<T>, options: WriteOptions = {}): Promise<T> {
  const verify = async (): Promise<void> => {
    if (path.dirname(parent) !== root || path.basename(parent) !== 'history' ||
        await realpath(root) !== root || await realpath(parent) !== parent ||
        !(await lstat(root)).isDirectory() || !(await lstat(parent)).isDirectory())
      throw new SharedStateError('shared-state-unsafe');
  };
  await verify();
  const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30_000) throw new SharedStateError('backlog-invalid');
  const file = path.join(parent, 'history.lock');
  const handle = await acquireLock(file, timeout, () => new SharedStateError('backlog-lock-timeout'), 0o600);
  let identity: { dev: number; ino: number } | undefined;
  try { identity = await handle.stat(); await verify(); return await body(); }
  finally { if (identity) await releaseSharedLock(handle, file, identity); else await handle.close(); }
}

/** Read-only diagnostics: never creates state or migrates an existing ignore file. */
export async function inspectSharedIgnore(paths: SharedProjectPaths, options: ProjectContextOptions = {}): Promise<SharedDiagnostic[]> {
  const previous = await readSharedFile(path.join(paths.dir, '.gitignore'));
  const diagnostics: SharedDiagnostic[] = [];
  let exists = true;
  if (previous.version === MISSING_SHARED_VERSION) {
    try { await lstat(paths.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
  }
  if (exists && previous.text !== SHARED_STATE_IGNORE && previous.text !== PRE_MEMORY_STATE_IGNORE && previous.text !== PRE_JOURNAL_STATE_IGNORE && previous.text !== PRE_RECIPES_STATE_IGNORE && previous.text !== '*\n')
    diagnostics.push({ code: 'parley-gitignore-custom' });
  // Бэклог в TODOS.md — файл проекта, а не каталога состояния: его игнор к `.parley` отношения не имеет.
  const backlogInState = path.dirname(paths.backlog) === paths.dir;
  if ((backlogInState && await sharedPathIgnored(paths.context, paths.backlog, options)) || await sharedPathIgnored(paths.context, paths.memory, options))
    diagnostics.push({ code: 'parley-dir-ignored' });
  return diagnostics;
}
/** Called under the project lock on shared writes; only the exact generated legacy ignore is migrated. */
export async function prepareSharedIgnore(paths: SharedProjectPaths, options: ProjectContextOptions = {}): Promise<SharedDiagnostic[]> {
  const file = path.join(paths.dir, '.gitignore');
  const previous = await readSharedFile(file);
  if ((previous.text === '*\n' || previous.text === PRE_MEMORY_STATE_IGNORE || previous.text === PRE_JOURNAL_STATE_IGNORE || previous.text === PRE_RECIPES_STATE_IGNORE) && previous.version !== MISSING_SHARED_VERSION)
    await writeSharedFile(file, SHARED_STATE_IGNORE, previous, 0o644);
  return inspectSharedIgnore(paths, options);
}
