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
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { CONTEXT_DIR, contextFile } from '../context-fill.js';
import { LIMITS_DIR, limitsFile } from '../limits.js';
import { envValue, HOME_DIR, LEGACY_HOME_DIR, type Env } from '../names.js';
import { bumpWorkId, nextWorkId, parseMap } from './map.js';
import { isAlive } from './pid-alive.js';
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
  const resolved = resolveParleyHome(env, userHome);
  refuseRealHomeUnderTest(resolved);
  return resolved;
}

function resolveParleyHome(env: Env, userHome: string): string {
  const explicit = envValue(env, 'HOME');
  if (explicit !== undefined) return explicit;
  const current = path.join(userHome, HOME_DIR);
  if (isDirectorySync(current)) return current;
  const legacy = path.join(userHome, LEGACY_HOME_DIR);
  return isDirectorySync(legacy) ? legacy : current;
}

/**
 * Предохранитель: под vitest (настоящее окружение процесса, не параметр `env`) дом не может оказаться настоящим
 * `~/.parley` или `~/.harnas` — иначе тест писал бы в данные человека (инцидент 17.10.2026). Домашний каталог берётся
 * из базы пользователей: `HOME` песочницы его не подменяет.
 */
function refuseRealHomeUnderTest(resolved: string): void {
  if (process.env['VITEST'] === undefined) return;
  const target = path.resolve(resolved);
  for (const dir of [HOME_DIR, LEGACY_HOME_DIR]) {
    const real = path.join(userInfo().homedir, dir);
    const relative = path.relative(real, target);
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (!outside)
      throw new Error(
        `A test resolved the real Parley home (${target}): the sandbox test/sandbox-home.ts is not applied — was vitest run outside the package config?`,
      );
  }
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
  /** Заполненность контекста сессий от строки статуса (спека 2026-10-15). */
  context: string;
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
    context: path.join(dir, CONTEXT_DIR),
    settings: path.join(dir, 'settings.json'),
  };
}

export interface WriteOptions {
  /**
   * Блокировка, не снятая за это время, — ошибка вызова, а не тихое ожидание. Время идёт с момента, когда до вызова
   * дошла очередь писателей этого процесса (спека хранилища 6.9).
   */
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
  /** `holder` — необязательный хвост про хозяина блокировки, см. `describeHolder`. */
  constructor(lockFile: string, timeoutMs: number, holder = '') {
    super(`lock ${lockFile} was not released within ${timeoutMs} ms${holder}`);
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

/**
 * Файл блокировки без pid старше этого возраста остался от упавшего процесса прежней версии: окно между `open` и
 * записью pid — микросекунды, свежий пустой файл — это чужой процесс, который вот-вот допишет свой pid.
 */
const STALE_UNOWNED_LOCK_MS = 10_000;

/**
 * Осиротела ли блокировка: pid хозяина мёртв; файл без pid (прежняя версия, окно между `open` и записью) —
 * старше 10 с. Не обычный файл (висячий симлинк, каталог) и любая ошибка чтения — не осиротела: ждём до таймаута,
 * как до перехвата, а не крутим цикл.
 */
async function isOrphaned(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return false;
    // Строгий разбор: недописанное «12» из «12345\n» — не pid, судим по возрасту.
    const pid = /^(\d+)\n$/.exec(await readFile(file, 'utf8'))?.[1];
    return pid !== undefined ? !isAlive(Number(pid)) : Date.now() - info.mtimeMs > STALE_UNOWNED_LOCK_MS;
  } catch {
    return false;
  }
}

/**
 * Guard перехвата судим только по возрасту (`lstat`, без разбора содержимого): pid в нём не пишется, и подброшенный
 * извне файл с живым pid, каталог или симлинк иначе выключили бы перехват этой блокировки навсегда.
 */
async function staleGuard(file: string): Promise<boolean> {
  try {
    return Date.now() - (await lstat(file)).mtimeMs > STALE_UNOWNED_LOCK_MS;
  } catch {
    return false;
  }
}

/**
 * Снимает блокировку, чей хозяин мёртв (процесс упал, не отпустив её), и сообщает, что снял: тогда `open` стоит
 * повторить сразу. Живой pid (в том числе наш собственный) не трогаем никогда.
 *
 * Перепроверка и `rm` идут под guard-файлом `<lock>.steal` (`wx`): перехватывает один процесс за раз, поэтому второй
 * ожидающий не удалит блокировку, которую первый уже снял и взял заново. Guard живёт микросекунды и pid не пишет;
 * guard старше 10 с остался от вора, упавшего внутри, — его снимаем. Окно TOCTOU остаётся только у снятия такого
 * guard-а и у `release*` — второго порядка, после уже случившейся аномалии.
 */
async function removeOrphanedLock(lockFile: string): Promise<boolean> {
  if (!(await isOrphaned(lockFile))) return false;
  const guard = `${lockFile}.steal`;
  let handle: FileHandle;
  try {
    handle = await open(guard, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && (await staleGuard(guard))) await rm(guard, { force: true }).catch(() => {});
    return false;
  }
  try {
    if (!(await isOrphaned(lockFile))) return false;
    await rm(lockFile, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
    await rm(guard, { force: true }).catch(() => {});
  }
}

const humanAge = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
};

/** Хвост сообщения о таймауте: кто держит блокировку и сколько. Файл не читается — пустая строка. */
async function describeHolder(lockFile: string): Promise<string> {
  try {
    const info = await lstat(lockFile);
    const age = humanAge(Date.now() - info.mtimeMs);
    const pid = /^(\d+)\n$/.exec(await readFile(lockFile, 'utf8'))?.[1];
    return pid === undefined
      ? ` (no owner pid, file age ${age})`
      : ` (held by pid ${pid}, ${isAlive(Number(pid)) ? 'alive' : 'dead'}, for ${age})`;
  } catch {
    return '';
  }
}

/** Эксклюзивное создание файла — атомарная операция файловой системы; в файл пишется pid хозяина. */
async function acquireLock(lockFile: string, timeoutMs: number,
  timeoutError: (holder: string) => Error = (holder) => new MapLockTimeoutError(lockFile, timeoutMs, holder), mode = 0o666,
): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockFile, 'wx', mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeOrphanedLock(lockFile)) continue;
      if (Date.now() >= deadline) {
        throw timeoutError(await describeHolder(lockFile));
      }
      await delay(RETRY_MS);
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      await handle.close();
      await rm(lockFile, { force: true });
      throw error;
    }
    return handle;
  }
}

/**
 * Снимает файл блокировки, только если это всё ещё наш файл: перехват мог отдать путь новому хозяину. Идентичность
 * берём до `close` — пока дескриптор открыт, inode не переиспользуется.
 */
async function releaseLock(handle: FileHandle, lockFile: string): Promise<void> {
  try {
    const own = await handle.stat();
    const current = await lstat(lockFile);
    if (current.dev === own.dev && current.ino === own.ino) await rm(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Очередь писателей этого процесса по пути файла блокировки (спека хранилища 6.9, этап 1): значение — «хвост»,
 * промис, который выполнится, когда уйдёт последний из вставших. Внутри процесса хоста писатели одного замка встают
 * в цепочку и берут файловый замок по одному, а не опрашивают файл наперегонки каждые `RETRY_MS`: при десятках
 * одновременных записей одной карты хвост упирался в `lockTimeoutMs`, хотя замок держал сам процесс. Файловый замок
 * остаётся как был — для других процессов (CLI, сессии без канала): `lockTimeoutMs` считается только для него и с того
 * момента, когда очередь дошла. У ожидания в очереди своего таймаута нет: оно кончается, когда каждый, кто впереди,
 * закончит или упадёт по своему. Запись снимает уходящий писатель, если за ним никого нет.
 */
const lockQueues = new Map<string, Promise<void>>();

async function withLock<T>(
  lockFile: string,
  timeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  const ahead = lockQueues.get(lockFile);
  let leave!: () => void;
  const turn = new Promise<void>((resolve) => {
    leave = resolve;
  });
  lockQueues.set(lockFile, turn);
  try {
    await ahead;
    const handle = await acquireLock(lockFile, timeoutMs);
    try {
      return await body();
    } finally {
      await releaseLock(handle, lockFile);
    }
  } finally {
    // Очередь отпускаем в любом исходе, и после падения тоже, — иначе идущие следом ждали бы вечно. Наш файл
    // блокировки к этому моменту уже снят, так что без чужого замка следующий берёт его с первой попытки.
    if (lockQueues.get(lockFile) === turn) lockQueues.delete(lockFile);
    leave();
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

/**
 * Разобранные карты процесса по пути `map.json` (спека хранилища 6.9, этап 1). Карты бывают в мегабайты, а читают
 * их часто: разбор неизменного файла каждый раз занимал поток. Сверка — по личности файла из `stat`
 * (`dev:ino:size:mtimeNs:ctimeNs`): запись идёт атомарным rename (новый inode), правка на месте меняет время и размер,
 * так что устаревшую карту кэш не отдаст. Принимает и выдаёт он копии (`structuredClone`): вызывающие свободно
 * меняют полученную карту, и общий объект испортил бы её всем читателям сразу. После записи в него ложится не изменённый
 * в памяти объект, а то, что вернёт свежий разбор записанного текста: разбор достраивает умолчания, убирает испорченное
 * и отвергает неверное, и писавший процесс не должен читать карту иначе, чем любой другой. Записей не больше
 * `MAP_CACHE_LIMIT`, сверх лимита уходит самая давняя по вставке.
 */
export const MAP_CACHE_LIMIT = 32;

const mapCache = new Map<string, { identity: string; map: WorkMap }>();
let mapCacheHits = 0;
let mapCacheMisses = 0;

/** Сколько раз карту взяли из кэша и сколько раз пришлось читать с диска. Только для тестов: из `index.ts` не экспортируется. */
export function mapCacheStats(): { hits: number; misses: number } {
  return { hits: mapCacheHits, misses: mapCacheMisses };
}

/** Личность файла карты. `stat` не удался (файла нет, нет доступа) — `null`: кэш не участвует, ошибку отдаст само чтение. */
async function mapIdentity(file: string): Promise<string | null> {
  try {
    const info = await stat(file, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    return null;
  }
}

/** Копия закэшированной карты, если файл с тех пор не менялся; иначе `undefined`. Попадания и промахи считаются здесь. */
function cachedMap(file: string, identity: string | null): WorkMap | undefined {
  const entry = mapCache.get(file);
  if (identity === null || entry === undefined || entry.identity !== identity) {
    mapCacheMisses += 1;
    return undefined;
  }
  mapCacheHits += 1;
  return structuredClone(entry.map);
}

/**
 * Кладёт карту в кэш как есть: вызывающий отдаёт объект, которого больше ни у кого нет (свежий разбор или своя копия).
 * Сверх `MAP_CACHE_LIMIT` вытесняется самая давняя по вставке.
 */
function rememberMap(file: string, identity: string, map: WorkMap): void {
  mapCache.set(file, { identity, map });
  for (const oldest of mapCache.keys()) {
    if (mapCache.size <= MAP_CACHE_LIMIT) break;
    mapCache.delete(oldest);
  }
}

/** Что вернёт свежий разбор записанного текста; `undefined` — разбор его отверг, и читателю с диска он откажет так же. */
function reparse(text: string, file: string): WorkMap | undefined {
  try {
    return parseMap(text, file);
  } catch {
    return undefined;
  }
}

/**
 * Читает карту работы. Битый файл — ошибка, догадки не строим. Неизменный файл разбирается один раз,
 * дальше карта приходит из кэша процесса — копией (спека хранилища 6.9).
 */
export async function readMap(projectPath: string, workId: string): Promise<WorkMap> {
  const file = workPaths(projectPath, workId).map;
  // `stat` до чтения: если карту перепишут между ними, в кэше окажется новое содержимое под старой личностью,
  // и следующее чтение просто разберёт её ещё раз.
  const identity = await mapIdentity(file);
  const cached = cachedMap(file, identity);
  if (cached !== undefined) return cached;
  const map = parseMap(await readFile(file, 'utf8'), file);
  if (identity !== null) rememberMap(file, identity, structuredClone(map));
  return map;
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
    contextFile(paths.dir, sessionId),
  ];
  await Promise.all(files.map((file) => rm(file, { force: true })));
}

/**
 * Удаляет работу целиком: каталог `<состояние>/works/<id>` со всем содержимым,
 * включая артефакты, и её запись в глобальном индексе. Каталога уже нет —
 * не ошибка: запись из индекса всё равно снимается. Каталог удаляется только
 * после взятия блокировки индекса: отказ блокировки ничего не стирает.
 */
export async function deleteWorkFiles(
  projectPath: string,
  workId: string,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: WriteOptions = {},
): Promise<void> {
  await withWorksIndex(lockTimeoutMs, async (index) => {
    await rm(workPaths(projectPath, workId).dir, { recursive: true, force: true });
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
 * Как часто `updateMap` обновляет `map.json.bak` (спека хранилища 6.9). Раньше копия переписывалась каждой
 * записью карты целиком, а карты бывают в мегабайты: запись удваивалась.
 */
export const MAP_BACKUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Пора ли класть копию: файла нет (человек удалил) — пора сразу; иначе — когда с её последней записи
 * прошло не меньше интервала. Разность берётся по модулю: после сдвига часов назад у копии mtime в будущем,
 * и без модуля она не обновлялась бы, пока часы не дойдут до этого времени.
 */
async function backupDue(file: string, now: number): Promise<boolean> {
  try {
    return Math.abs(now - (await stat(file)).mtimeMs) >= MAP_BACKUP_INTERVAL_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Единственный способ изменить карту: читаем и пишем под блокировкой `map.lock`,
 * поэтому параллельные писатели не затирают друг друга. Новая версия появляется
 * атомарным `rename`. Прежняя уходит в `map.json.bak` не каждой записью, а когда копии нет
 * или с её записи прошло `MAP_BACKUP_INTERVAL_MS` (спека хранилища 6.9); `createWork` кладёт её
 * сразу. Битую карту не трогаем.
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
    // Карта из кэша процесса — без чтения и разбора файла (спека хранилища 6.9). Сырой текст нужен только для `.bak`:
    // с диска он берётся по месту, и только если копию пора обновлять.
    let raw: string | undefined;
    let current = cachedMap(paths.map, await mapIdentity(paths.map));
    if (current === undefined) {
      raw = await readFile(paths.map, 'utf8');
      current = parseMap(raw, paths.map);
    }
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
    // Копия — не каждой записью, а когда прежней нет или она устарела (спека хранилища 6.9).
    if (await backupDue(paths.bak, Date.now())) {
      await writeAtomic(paths.bak, raw ?? (await readFile(paths.map, 'utf8')));
    }
    const text = serialize(current);
    await writeAtomic(paths.map, text);
    // В кэш — после записи и под тем же замком, и не `current`, а то, что вернёт свежий разбор записанного текста
    // (спека хранилища 6.9): иначе писавший процесс читал бы карту иначе, чем любой другой. Личность файла берём до
    // разбора: перепишут его за время разбора — запись просто не совпадёт со следующей сверкой. Не вышло (каталог
    // работы снесли; разбор отверг только что записанное) — запись снимаем и молчим: карта уже записана, ошибка
    // заставила бы повторить мутацию, а следующее чтение или обновление прочтёт файл с диска и откажет, как прежде.
    const written = await mapIdentity(paths.map);
    const reread = written === null ? undefined : reparse(text, paths.map);
    if (written !== null && reread !== undefined) rememberMap(paths.map, written, reread);
    else mapCache.delete(paths.map);
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
/**
 * Потолок чтения для карты работы. Карта — собственный файл Parley, а не общий файл проекта: переписка
 * раздувает её за 1 МиБ, и общий потолок делал такую карту нечитаемой для бэклога. Так карту читает бэклог
 * хоста (`knownMap`): `readSharedFile(file, MAP_SNAPSHOT_LIMIT)`; `writeSharedFile` остаётся на 1 МиБ —
 * картам он не нужен (спека хранилища 6.9).
 */
export const MAP_SNAPSHOT_LIMIT = 256 * 1024 * 1024;
export const MISSING_SHARED_VERSION = 'missing';

/**
 * Nonblocking regular-file reads; strict UTF-8 prevents lossless Markdown replacement of bad bytes.
 * `limit` bounds the file size in bytes and defaults to `SHARED_FILE_LIMIT` (1 MiB).
 */
export async function readSharedFile(file: string, limit = SHARED_FILE_LIMIT): Promise<SharedFileSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await readSharedFileOnce(file, limit); }
    catch (error) {
      if (!(error instanceof SharedStateError) || error.code !== 'backlog-conflict') throw error;
    }
  }
  throw new SharedStateError('backlog-conflict');
}
async function readSharedFileOnce(file: string, limit: number): Promise<SharedFileSnapshot> {
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', version: MISSING_SHARED_VERSION };
    throw new SharedStateError('shared-file-unreadable');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new SharedStateError('shared-file-unreadable');
    if (before.size > BigInt(limit)) throw new SharedStateError('shared-file-too-large');
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
  try { return await body(); }
  finally { await releaseLock(handle, paths.lock); }
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
  try { await verify(); return await body(); }
  finally { await releaseLock(handle, file); }
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
