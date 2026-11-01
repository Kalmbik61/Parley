import { constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONTEXT_DIR, contextFile } from '../context-fill.js';
import { LIMITS_DIR, limitsFile } from '../limits.js';
import { envValue, ENV_PREFIX, HOME_DIR, LEGACY_ENV_PREFIX, LEGACY_HOME_DIR, type Env } from '../names.js';
import { BUSY_TIMEOUT_MS, WORK_DB_FILE, workDb } from './db.js';
import { diffRows, isPlainJsonTree, mapToRows, rowIndex, rowsToMap, type StoredRow } from './map-rows.js';
import { bumpWorkId, nextWorkId, normalizeMap } from './map.js';
import type { LetterJournal, LetterTx } from './letter-store.js';
import { createTableLetterTx, loadAllLetters, replaceLetters } from './letter-tables.js';
import { isAlive } from './pid-alive.js';
import { sql } from './sql-statements.js';
import { PRE_JOURNAL_STATE_IGNORE, PRE_MEMORY_STATE_IGNORE, PRE_RECIPES_STATE_IGNORE, ensureStateDir, isDirectorySync, stateDir, SHARED_STATE_IGNORE } from './state-dir.js';
import { resolveSharedProjectContext, sharedPathIgnored } from './project-context.js';
import type { ProjectContextOptions, SharedProjectContext } from './project-context.js';
import type { WindowWorkMap, WorkIndexEntry, WorkMap, WorksIndex, WorkStatus } from './types.js';

/** Найденный дом и снимок входов, под которым он найден (`parleyHome`). */
let homeMemo: { snapshot: string; home: string } | undefined;

/**
 * Домашняя папка Parley (R4), первое подходящее:
 * 1. `PARLEY_HOME`; 2. `HARNAS_HOME` — этим живут тесты и второй дом;
 * 3. `~/.parley`, если он есть; 4. `~/.harnas`, если он есть — данные человека со времён имени harnas;
 * 5. иначе `~/.parley`.
 * Пустая переменная — то же, что незаданная. `env` и `userHome` подменяет тест.
 */
export function parleyHome(env: Env = process.env, userHome: string = homedir()): string {
  // Дом процесса ищут на каждой записи, чтении версии и подготовке запроса, а без переменных это два `stat`: найденное
  // помним, пока не сменились сами входы — `PARLEY_HOME`, `HARNAS_HOME`, домашний каталог и признак теста. Каталоги
  // `~/.parley` и `~/.harnas` при этом смотрятся один раз на снимок: перенос дома (`migrateHome`) идёт, пока процессы
  // его агентов не живы (спека хранилища 6.9, план 4, задача 5). Чужое окружение (`env` из теста) не запоминается.
  if (env !== process.env) return checkedHome(env, userHome);
  const snapshot = [
    env[ENV_PREFIX + 'HOME'],
    env[LEGACY_ENV_PREFIX + 'HOME'],
    env['VITEST'],
    userHome,
  ].join('\u0000');
  if (homeMemo?.snapshot === snapshot) return homeMemo.home;
  const home = checkedHome(env, userHome);
  homeMemo = { snapshot, home };
  return home;
}

/** Забывает найденный дом: после переноса `~/.harnas` → `~/.parley` (`migrateHome`) прежний ответ уже неверен. */
export function forgetParleyHome(): void {
  homeMemo = undefined;
}

function checkedHome(env: Env, userHome: string): string {
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

/**
 * Прежний глобальный индекс работ `works-index.json`. Список работ теперь — таблица `works` (`readWorksIndex`); путь
 * остался для переезда прежних файлов в базу и для переноса каталогов состояния, которым нужен именно старый файл
 * (спека хранилища 6.6).
 */
export function worksIndexPath(): string {
  return path.join(parleyHome(), 'works-index.json');
}

export interface WorkPaths {
  dir: string;
  /** Прежний `map.json`: карты живут в базе, путь остался для переезда и проверок «лежит ли карта прежнего формата». */
  map: string;
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
   * Блокировка, не снятая за это время, — ошибка вызова, а не тихое ожидание. Для базы работ это ожидание записи чужого
   * процесса (CLI, MCP агента без канала): писатели одного процесса друг друга не ждут (спека хранилища 6.9). Файловая
   * блокировка общих файлов проекта берёт то же значение.
   */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const RETRY_MS = 20;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Таймаут блокировки записи — отдельный класс, а не голая `Error`: карту пишут трое
 * (хост, CLI и MCP-серверы агентов), и хосту нужно отличить именно занятость
 * базы от прочих сбоев записи, чтобы не падать, а сообщить `host.notice`
 * и повторить на следующем событии (план, кусок 1.4). Бросается и когда `parley.db` занята
 * другим процессом дольше `lockTimeoutMs` (спека хранилища 6.9, этап 2).
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
 * `not_found`, а не `internal`, и в том числе когда работу удалили
 * (`works.delete` другого клиента) между проверкой и записью.
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
 * как до перехвата, а не крутим цикл. Её же спрашивает переезд прежних карт: живой замок `map.lock` — работа занята
 * процессом прежней сборки (спека хранилища 6.6).
 */
export async function isOrphaned(file: string): Promise<boolean> {
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

/** Коды SQLite, по которым хранилище отличает занятую базу и занятый id (расширенный код — у ограничений). */
const SQLITE_BUSY = 5;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

const sqliteCode = (error: unknown): number => (error as { errcode?: number } | null)?.errcode ?? 0;

/**
 * Отказ из-за занятости базы, а не из-за карты: `MapLockTimeoutError` (запись не дождалась) или сырой `SQLITE_BUSY` у
 * читателя. Такая работа не битая — повтор на следующем проходе удастся, и хост молчит о повреждении.
 */
export function isDatabaseBusy(error: unknown): boolean {
  return error instanceof MapLockTimeoutError || (sqliteCode(error) & 0xff) === SQLITE_BUSY;
}

/**
 * База занята другим соединением дольше `lockTimeoutMs` — тот же `MapLockTimeoutError`, что был у файловой блокировки:
 * хост по нему не падает, а сообщает `host.notice` и повторяет (спека хранилища 6.9). Прочие ошибки идут как есть.
 */
function asLockTimeout(error: unknown, timeoutMs: number): unknown {
  return (sqliteCode(error) & 0xff) === SQLITE_BUSY
    ? new MapLockTimeoutError(path.join(parleyHome(), WORK_DB_FILE), timeoutMs)
    : error;
}

/**
 * Запись в базу: синхронное тело между `BEGIN IMMEDIATE` и `COMMIT`, при любом исключении — `ROLLBACK` (спека хранилища
 * 6.9, этап 2). Синхронность ставит писателей этого процесса в очередь сама: между `BEGIN` и `COMMIT` цикл событий не
 * освобождается. Чужие процессы ждёт `busy_timeout` соединения — на время записи он равен `lockTimeoutMs`, а после неё
 * (в том числе после отказа) возвращается к `BUSY_TIMEOUT_MS`: иначе чтения и следующие записи ждали бы столько, сколько
 * попросила последняя.
 */
function writeTransaction<T>(db: DatabaseSync, lockTimeoutMs: number, body: () => T): T {
  const timeoutMs = Number.isFinite(lockTimeoutMs)
    ? Math.max(0, Math.trunc(lockTimeoutMs))
    : DEFAULT_LOCK_TIMEOUT_MS;
  try {
    try {
      db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw asLockTimeout(error, timeoutMs);
    }
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Транзакции уже нет: SQLite сама откатила её при сбое.
      }
      throw asLockTimeout(error, timeoutMs);
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

/** Чтение нескольких запросов с одного снимка базы; внутри уже открытой транзакции (запись, переезд) своей не открывает. */
export function readTransaction<T>(db: DatabaseSync, body: () => T): T {
  if (db.isTransaction) return body();
  db.exec('BEGIN');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // Тело бросило или COMMIT не прошёл: открытая транзакция не должна остаться (следующий вызов принял бы её за свою).
    try {
      db.exec('ROLLBACK');
    } catch {
      // Транзакции уже нет: причина — исходная ошибка, её и бросаем.
    }
    throw error;
  }
}

export const UPSERT_ENTRY = `INSERT INTO entries (project_path, work_id, kind, key, ord, json) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (project_path, work_id, kind, key) DO UPDATE SET ord = excluded.ord, json = excluded.json`;
export const DELETE_ENTRY =
  'DELETE FROM entries WHERE project_path = ? AND work_id = ? AND kind = ? AND key = ?';
const INSERT_WORK = `INSERT INTO works (project_path, id, title, status, updated_at, version, work_json, extra_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_WORK = `UPDATE works SET title = ?, status = ?, updated_at = ?, work_json = ?, extra_json = ?,
  version = version + 1 WHERE project_path = ? AND id = ? RETURNING version`;

const notFound = (projectPath: string, workId: string): WorkNotFoundError =>
  new WorkNotFoundError(`workspace ${workId} does not exist in ${projectPath}`);

/** Имя работы для текстов отказа `normalizeMap`: файла карты больше нет, называем работу и проект. */
const mapSource = (projectPath: string, workId: string): string => `${workId} (${projectPath})`;

/** Номер версии строки работы; `undefined` — строки нет. Запись растит его на каждой записи (спека хранилища 6.9). */
function versionOf(db: DatabaseSync, projectPath: string, workId: string): number | undefined {
  const row = sql(db, 'SELECT version FROM works WHERE project_path = ? AND id = ?').get(
    projectPath,
    workId,
  );
  return row === undefined ? undefined : Number(row['version']);
}

/**
 * Версия строки работы в базе; `undefined` — работы нет. Её растит каждая запись любого процесса, поэтому по ней
 * читатель узнаёт, что его копия карты устарела (спека хранилища 6.9). Версию берут до чтения карты: запись между ними
 * даст запоздавший ключ и лишнюю загрузку, а не устаревшую карту под свежим ключом.
 */
export function workVersion(projectPath: string, workId: string): number | undefined {
  return versionOf(storeDb(), projectPath, workId);
}

/**
 * Личность работы для ожидания (спека хранилища 6.9): версия строки текстом, `null` — работы в базе нет. Файла карты,
 * по `stat` которого ожидание узнавало запись, больше нет; версию растит каждая запись любого процесса, и один запрос по
 * ключу строки дешевле разбора карты, так что ею можно сверяться на каждом тике опроса.
 */
export function workVersionKey(projectPath: string, workId: string): string | null {
  const version = workVersion(projectPath, workId);
  return version === undefined ? null : `${version}`;
}

/** То, что лежит в базе про одну работу: версия, запись работы, `extra` и строки списков. */
interface Stored {
  version: number;
  work: string;
  extra: string;
  rows: StoredRow[];
}

/** Одним снимком читает строку работы и все её строки списков; `undefined` — работы нет. */
function loadStored(db: DatabaseSync, projectPath: string, workId: string): Stored | undefined {
  return readTransaction(db, () => {
    const head = sql(
      db,
      'SELECT version, work_json, extra_json FROM works WHERE project_path = ? AND id = ?',
    ).get(projectPath, workId);
    if (head === undefined) return undefined;
    const rows = sql(
      db,
      'SELECT kind, key, ord, json FROM entries WHERE project_path = ? AND work_id = ? ORDER BY kind, ord',
    ).all(projectPath, workId) as unknown as StoredRow[];
    return {
      version: Number(head['version']),
      work: String(head['work_json']),
      extra: String(head['extra_json']),
      rows,
    };
  });
}

/**
 * Разобранные карты процесса (спека хранилища 6.9). Ключ — `проект\0работа`; запись — карта и то, что лежит в базе под её
 * версией: JSON работы, `extra` и строки списков по ключам (`index`), с которыми `updateMap` сравнивает следующую запись.
 * Сверка — по номеру версии строки `works`, а не по файлу: чужую запись (CLI, MCP агента без канала) видно по новой версии,
 * устаревшую карту кэш не отдаст. Карты бывают в мегабайты, а читают их часто: неизменная работа загружается один раз.
 * `readMap` кладёт в кэш объект и выдаёт копии (`structuredClone`): вызывающие свободно меняют полученную карту, и общий
 * объект испортил бы её всем читателям сразу. `updateMap` копию не берёт: на попадании он забирает объект из кэша себе
 * (запись снимается), мутирует его сам, а после записи кладёт в кэш карту, которую дал бы свежий разбор записанных
 * строк, — писавший процесс не должен читать карту иначе, чем любой другой. Это либо свежая сборка строк (карту забирает
 * вызывающий), либо сама записанная карта, если она чистое дерево JSON (`applyMapUpdate`). Брошенная мутация или отказ
 * записи оставляют кэш без записи: следующее чтение загрузит базу, а не увидит наполовину изменённый объект. Записей не
 * больше `MAP_CACHE_LIMIT`, сверх лимита уходит самая давняя по вставке. Кэш принадлежит дескриптору базы: сменился
 * дом — кэш пуст.
 */
export const MAP_CACHE_LIMIT = 32;

interface CachedMap {
  version: number;
  map: WorkMap;
  work: string;
  extra: string;
  index: ReadonlyMap<string, StoredRow>;
}

const mapCache = new Map<string, CachedMap>();
let cacheOwner: DatabaseSync | undefined;
let mapCacheHits = 0;
let mapCacheMisses = 0;

/** Сколько раз карту взяли из кэша и сколько раз пришлось загружать из базы. Только для тестов: из `index.ts` не экспортируется. */
export function mapCacheStats(): { hits: number; misses: number } {
  return { hits: mapCacheHits, misses: mapCacheMisses };
}

const cacheKey = (projectPath: string, workId: string): string => `${projectPath}\0${workId}`;

/** База текущего дома; у другого дескриптора (дом сменился) — свой пустой кэш. */
export function storeDb(): DatabaseSync {
  const db = workDb();
  if (db !== cacheOwner) {
    mapCache.clear();
    cacheOwner = db;
  }
  return db;
}

/** Запись кэша, если версия в базе всё та же; иначе `undefined`. Попадания и промахи считаются здесь. */
function cachedEntry(key: string, version: number): CachedMap | undefined {
  const entry = mapCache.get(key);
  if (entry === undefined || entry.version !== version) {
    mapCacheMisses += 1;
    return undefined;
  }
  mapCacheHits += 1;
  return entry;
}

/** Кладёт запись в кэш как есть: объект карты принадлежит кэшу, у вызывающего его нет. Сверх лимита уходит самая давняя. */
function rememberMap(key: string, entry: CachedMap): void {
  mapCache.set(key, entry);
  for (const oldest of mapCache.keys()) {
    if (mapCache.size <= MAP_CACHE_LIMIT) break;
    mapCache.delete(oldest);
  }
}

/**
 * Размер загруженной карты в байтах — сумма текстов её строк в базе (работа, `extra`, строки списков), как они были
 * разобраны. Считается по кэшу процесса, а не по сборке JSON заново: на карте в десятки мегабайт `JSON.stringify` стоил бы
 * больше самого чтения. `undefined` — карты в кэше нет (читать её нужно через `readMap`).
 */
export function storedMapBytes(projectPath: string, workId: string): number | undefined {
  const entry = mapCache.get(cacheKey(projectPath, workId));
  if (entry === undefined) return undefined;
  let bytes = Buffer.byteLength(entry.work) + Buffer.byteLength(entry.extra);
  for (const row of entry.index.values()) bytes += Buffer.byteLength(row.json);
  return bytes;
}

/**
 * Запись базы одной работы дошла до подписчиков процесса: проект, работа и версия, под которой она теперь лежит.
 * `removed` — работу сняли (`deleteWorkFiles`, `pruneWorksIndex`): версия тогда последняя, какая у неё была.
 *
 * `prevVersion`, `structural` и `journal` (спека rooms.mail 6.2) есть у записей `updateMap` и `writeLetters`: версия до
 * записи, менялись ли строки карты, и что записано в письма. Журнал лежит в событии каждой такой записи, пустым тоже. У
 * остальных записей (`createWork`, `replaceStoredMap`, переезд, снятие работы) их нет, и нет `structural` — считать `true`:
 * письмами такая запись не разбирается, подписчик обязан пересчитать всё.
 */
export interface MapWrittenEvent {
  projectPath: string;
  workId: string;
  version: number;
  removed?: true;
  prevVersion?: number;
  structural?: boolean;
  journal?: LetterJournal;
}

const writeListeners = new Set<(event: MapWrittenEvent) => void>();

/**
 * Подписка на записи этого процесса (`createWork`, `updateMap`, `replaceStoredMap`, снятие работы): событие приходит после
 * коммита и после обновления кэша. Записи других процессов видны хосту иначе — по `workDataVersion` (спека хранилища 6.9).
 * Возвращает отписку.
 */
export function onMapWritten(listener: (event: MapWrittenEvent) => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

/** Слушатель, который бросил, уже записанного не откатывает: падение писателя заставило бы вызывающего повторить мутацию. */
function emitMapWritten(event: MapWrittenEvent): void {
  for (const listener of [...writeListeners]) {
    try {
      listener(event);
    } catch {
      // Событие — уведомление, а не часть записи.
    }
  }
}

/** Есть ли в базе строка работы. Без разбора карты: так проверяют существование вместо `stat` файла карты. */
export function workExists(projectPath: string, workId: string): boolean {
  return versionOf(storeDb(), projectPath, workId) !== undefined;
}

/**
 * База текущего дома для чтения писем работы (`letter-store.ts`, спека хранилища 6.2). Работы нет — `WorkNotFoundError`, как
 * у `readMap`: письма без работы читать нечем, а запрос с пустым ответом выдал бы удалённую работу за пустую.
 */
export function letterDb(projectPath: string, workId: string): DatabaseSync {
  const db = storeDb();
  if (versionOf(db, projectPath, workId) === undefined) throw notFound(projectPath, workId);
  return db;
}

/**
 * `PRAGMA data_version` соединения: число меняется, когда запись закоммитило другое соединение (другой процесс — CLI,
 * MCP агента без канала), и не меняется от коммитов этого. Читает только заголовок журнала, поэтому годится для опроса
 * каждые полсекунды (спека хранилища 6.9). Записи своего процесса хост узнаёт по `onMapWritten`.
 */
export function workDataVersion(): number {
  return Number(sql(storeDb(), 'PRAGMA data_version').get()?.['data_version']);
}

/** Версии всех работ базы одним запросом: после чужой записи хост сверяет их с прошлым снимком (спека хранилища 6.9). */
export function listWorkVersions(): Array<{ projectPath: string; id: string; version: number }> {
  return sql(storeDb(), 'SELECT project_path, id, version FROM works')
    .all()
    .map((row) => ({
      projectPath: String(row['project_path']),
      id: String(row['id']),
      version: Number(row['version']),
    }));
}

/**
 * Собирает полную карту из строк базы мимо кэша — для тестов, выгрузки и сверки переезда: хранимая часть прошла
 * `normalizeMap`, как и загрузка `readMap`, а письма с отметками прочтения собраны из своих таблиц одним снимком базы
 * (спека хранилища 6.2). Работы нет — `WorkNotFoundError`.
 */
export function readStoredMap(projectPath: string, workId: string): WindowWorkMap {
  return readStoredMapOn(storeDb(), projectPath, workId);
}

/**
 * `readStoredMap` на заданном соединении: апгрейд базы со схемы 1 собирает и сверяет карты ещё до того, как дескриптор
 * `workDb()` существует (`letter-upgrade.ts`, спека хранилища 6.6).
 */
export function readStoredMapOn(db: DatabaseSync, projectPath: string, workId: string): WindowWorkMap {
  return readTransaction(db, () => {
    const stored = loadStored(db, projectPath, workId);
    if (stored === undefined) throw notFound(projectPath, workId);
    const map = normalizeMap(rowsToMap(stored.work, stored.extra, stored.rows), mapSource(projectPath, workId));
    return Object.assign(map, { messages: loadAllLetters(db, projectPath, workId) });
  });
}

/**
 * Только для тестов: записывает строки работы из произвольного объекта без `normalizeMap` и поднимает версию — так
 * тест изображает «чужую запись» и карту, которую нормализация отвергает. Списки заменяются целиком; письма — тоже, если в
 * объекте есть `messages` (полная карта: письма с `readBy`, кандидаты в непрочитанное раскладываются по правилам карты),
 * иначе письма работы остаются как были. Работы нет — `WorkNotFoundError`.
 */
export function replaceStoredMap(projectPath: string, workId: string, data: unknown): void {
  const db = storeDb();
  const version = writeTransaction(db, DEFAULT_LOCK_TIMEOUT_MS, () => {
    if (versionOf(db, projectPath, workId) === undefined) throw notFound(projectPath, workId);
    const map = data as WorkMap;
    const next = mapToRows(map);
    sql(db, 'DELETE FROM entries WHERE project_path = ? AND work_id = ?').run(projectPath, workId);
    for (const row of next.rows) {
      sql(db, UPSERT_ENTRY).run(projectPath, workId, row.kind, row.key, row.ord, row.json);
    }
    if (Array.isArray((data as Partial<WindowWorkMap>).messages)) replaceLetters(db, projectPath, workId, data as WindowWorkMap);
    const work = map.work as unknown as Record<string, unknown>;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const updated = sql(db, UPDATE_WORK).get(
      text(work['title']),
      text(work['status']),
      text(work['updatedAt']),
      next.work,
      next.extra,
      projectPath,
      workId,
    );
    return Number(updated?.['version']);
  });
  emitMapWritten({ projectPath, workId, version });
}

/**
 * Только для переезда прежнего `map.json` (спека хранилища 6.6): вставляет строку работы, строки её списков и письма с
 * отметками прочтения и кандидатами одной транзакцией и зовёт `check` до `COMMIT` — внутри транзакции видны ещё не записанные строки, и `readStoredMap` собирает
 * из них карту для сверки. Бросил `check` (или вставка) — `ROLLBACK`, в базе ничего не остаётся. Версия — часы, как у
 * `createWork`. Подписчики `onMapWritten` узнают о работе после коммита.
 */
export function insertMigratedMap(
  projectPath: string,
  workId: string,
  map: WindowWorkMap,
  check: () => void,
): void {
  const db = storeDb();
  const version = writeTransaction(db, DEFAULT_LOCK_TIMEOUT_MS, () => {
    const rows = mapToRows(map);
    const work = map.work as unknown as Record<string, unknown>;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const at = Date.now();
    sql(db, INSERT_WORK).run(
      projectPath,
      workId,
      text(work['title']),
      text(work['status']),
      text(work['updatedAt']),
      at,
      rows.work,
      rows.extra,
    );
    for (const row of rows.rows) {
      sql(db, UPSERT_ENTRY).run(projectPath, workId, row.kind, row.key, row.ord, row.json);
    }
    replaceLetters(db, projectPath, workId, map);
    check();
    return at;
  });
  emitMapWritten({ projectPath, workId, version });
}

/**
 * Читает карту работы из базы. Нет строки — `WorkNotFoundError`; карта, которую `normalizeMap` не принимает, — ошибка,
 * догадки не строим. Неизменная работа загружается один раз, дальше карта приходит из кэша процесса копией (спека
 * хранилища 6.9).
 */
export async function readMap(projectPath: string, workId: string): Promise<WorkMap> {
  return loadMap(projectPath, workId, true);
}

/**
 * Карта из кэша процесса без копии и без `await` — только чтение внутри ядра (`letter-store.ts`, спека хранилища 6.2):
 * выданный объект принадлежит кэшу, его нельзя менять и держать за пределами вызова, потому что следующий `updateMap`
 * забирает его себе и мутирует. Наружу из ядра уходят копии нужных частей. Ошибки те же, что у `readMap`.
 */
export function readMapView(projectPath: string, workId: string): Readonly<WorkMap> {
  return loadMap(projectPath, workId, false);
}

/**
 * Разбор карты из кэша процесса без копии, пока `read` работает: объект принадлежит кэшу, и `read` обязан отработать
 * синхронно и не вернуть из карты ничего изменяемого (см. `readMapView`). Хост берёт так комнаты и состав работы для
 * страницы писем, не платя копией всей карты (спека хранилища 6.2). Ошибки те же, что у `readMap`.
 */
export function viewMap<T>(projectPath: string, workId: string, read: (map: Readonly<WorkMap>) => T): T {
  return read(readMapView(projectPath, workId));
}

function loadMap(projectPath: string, workId: string, copy: boolean): WorkMap {
  const db = storeDb();
  const key = cacheKey(projectPath, workId);
  const version = versionOf(db, projectPath, workId);
  if (version === undefined) {
    mapCache.delete(key);
    throw notFound(projectPath, workId);
  }
  const cached = cachedEntry(key, version);
  if (cached !== undefined) return copy ? structuredClone(cached.map) : cached.map;
  // Версию в запись кэша берём из той же загрузки, что и строки: запись между запросами не перепутает их.
  const stored = loadStored(db, projectPath, workId);
  if (stored === undefined) {
    mapCache.delete(key);
    throw notFound(projectPath, workId);
  }
  const map = normalizeMap(
    rowsToMap(stored.work, stored.extra, stored.rows),
    mapSource(projectPath, workId),
  );
  rememberMap(key, {
    version: stored.version,
    map,
    work: stored.work,
    extra: stored.extra,
    index: rowIndex(stored.rows),
  });
  return copy ? structuredClone(map) : map;
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
 * Удаляет работу целиком: её строки в базе (списки уходят каскадом) и каталог
 * `<состояние>/works/<id>` со всем содержимым, включая артефакты. Каталога уже нет —
 * не ошибка: строка из базы всё равно снимается. Каталог удаляется только после
 * того, как строка снята: отказ записи в базу ничего не стирает.
 */
export async function deleteWorkFiles(
  projectPath: string,
  workId: string,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: WriteOptions = {},
): Promise<void> {
  const db = storeDb();
  const version = writeTransaction(db, lockTimeoutMs, () => {
    const last = versionOf(db, projectPath, workId);
    sql(db, 'DELETE FROM works WHERE project_path = ? AND id = ?').run(projectPath, workId);
    return last;
  });
  mapCache.delete(cacheKey(projectPath, workId));
  // Снятие — тоже запись базы: без события хост этого процесса не узнал бы об удалении (файлов, за которыми он следил, нет).
  if (version !== undefined) emitMapWritten({ projectPath, workId, version, removed: true });
  await rm(workPaths(projectPath, workId).dir, { recursive: true, force: true });
}

/** Список работ из таблицы `works` в порядке создания. */
function listWorks(db: DatabaseSync): WorkIndexEntry[] {
  const rows = sql(
    db,
    'SELECT project_path, id, title, status, updated_at FROM works ORDER BY rowid',
  ).all();
  return rows.map((row) => ({
    id: String(row['id']),
    projectPath: String(row['project_path']),
    title: String(row['title']),
    status: String(row['status']) as WorkStatus,
    updatedAt: String(row['updated_at']),
  }));
}

/**
 * Список работ — все работы всех проектов, из таблицы `works` (спека хранилища 6.1). С `file` читается не база, а
 * прежний `works-index.json` — не текущего дома, а другого: перенос дома читает индекс прежнего, пока тот ещё не переехал.
 */
export async function readWorksIndex(file?: string): Promise<WorksIndex> {
  if (file === undefined) return { schemaVersion: 1, works: listWorks(storeDb()) };
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

/** Папка в доме, куда `pruneWorksIndex` кладёт JSON-копию карты перед тем, как снять работу из базы. */
const PRUNED_DIR = 'pruned';

/**
 * Снимает из базы работы, у которых каталога на диске больше нет: каталог работы снесли руками, проект удалили или
 * он переехал. Автоматически при чтении так не делается — закреплённая чужая работа на отключённом диске выглядит
 * так же. «Нет» — только `ENOENT`/`ENOTDIR` от `stat`; любая другая ошибка (права, сбой диска) работу оставляет и
 * называется в `report`, остальных не останавливая. Снятие стирает и письма, и сессии, и планы работы, поэтому перед ним
 * карта пишется JSON-файлом в `<дом>/pruned/<номер>-<время UTC>.json` (спека хранилища 6.9); не записалась — работа остаётся.
 * Возвращает снятые записи.
 */
export async function pruneWorksIndex({
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  report = () => undefined,
}: WriteOptions & { report?: (line: string) => void } = {}): Promise<WorkIndexEntry[]> {
  const db = storeDb();
  const gone: WorkIndexEntry[] = [];
  for (const entry of listWorks(db)) {
    const dir = workPaths(entry.projectPath, entry.id).dir;
    try {
      if (!(await stat(dir)).isDirectory()) gone.push(entry);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') gone.push(entry);
      else report(`workspace ${entry.id} (${entry.projectPath}) kept: cannot check ${dir} (${code ?? (error as Error).message})`);
    }
  }
  if (gone.length === 0) return gone;
  const removed: WorkIndexEntry[] = [];
  const events = writeTransaction(db, lockTimeoutMs, () => {
    const versions: MapWrittenEvent[] = [];
    for (const entry of gone) {
      // Копия и снятие в одной транзакции записи: между ними карту никто не изменит.
      try {
        savePrunedCopy(entry);
      } catch (error) {
        report(`workspace ${entry.id} (${entry.projectPath}) kept: its copy could not be saved (${(error as Error).message})`);
        continue;
      }
      const version = versionOf(db, entry.projectPath, entry.id);
      sql(db, 'DELETE FROM works WHERE project_path = ? AND id = ?').run(
        entry.projectPath,
        entry.id,
      );
      mapCache.delete(cacheKey(entry.projectPath, entry.id));
      removed.push(entry);
      if (version !== undefined) {
        versions.push({ projectPath: entry.projectPath, workId: entry.id, version, removed: true });
      }
    }
    return versions;
  });
  for (const event of events) emitMapWritten(event);
  return removed;
}

/**
 * Пишет карту работы (то, что отдаёт `readStoredMap`) в `<дом>/pruned/<номер>-<время UTC без двоеточий>.json`; существующий
 * файл не затирает. Вызывается внутри транзакции записи — читает на её снимке.
 */
function savePrunedCopy(entry: WorkIndexEntry): void {
  const map = readStoredMap(entry.projectPath, entry.id);
  const dir = path.join(parleyHome(), PRUNED_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '');
  writeFileSync(path.join(dir, `${entry.id}-${stamp}.json`), `${JSON.stringify(map, null, 2)}\n`, { flag: 'wx' });
}

export interface NewWork {
  title: string;
  goal?: string;
}

/**
 * Создаёт работу: в одной транзакции выбирает id по всей базе (поэтому два процесса не получат один номер), вставляет
 * строку и раскладывает каталоги. Карты прежнего формата, ещё не переехавшие в базу, тоже занимают номера: id, под
 * которым на диске лежит `map.json`, пропускается, чужую карту не затираем никогда. Не вышли каталоги — строки нет.
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
    rooms: [],
  };

  // Каталог состояния — до путей работы: новый `.parley` получает свой `.gitignore` (R5).
  await ensureStateDir(projectPath);
  const db = storeDb();
  const created = writeTransaction(db, lockTimeoutMs, () => {
    let id = nextWorkId({ schemaVersion: 1, works: listWorks(db) });
    while (existsSync(workPaths(projectPath, id).map)) id = bumpWorkId(id);
    map.work.id = id;
    const rows = mapToRows(map);
    // Версия новой работы — часы, а не 0: удалённый и созданный заново id (`nextWorkId` берёт максимум по базе) иначе
    // совпал бы с версией в кэше другого процесса, и тот отдал бы карту прежней работы (спека хранилища 6.9).
    const version = Date.now();
    try {
      sql(db, INSERT_WORK).run(
        projectPath,
        id,
        map.work.title,
        map.work.status,
        map.work.updatedAt,
        version,
        rows.work,
        rows.extra,
      );
    } catch (error) {
      if (sqliteCode(error) === SQLITE_CONSTRAINT_PRIMARYKEY) {
        throw new Error(
          `workspace ${id} already exists in ${projectPath} — the workspace was not created`,
        );
      }
      throw error;
    }
    // Каталоги — до коммита: не вышли, и строка откатывается вместе с ними.
    const paths = workPaths(projectPath, id);
    mkdirSync(paths.briefs, { recursive: true });
    mkdirSync(paths.artifacts, { recursive: true });
    return { workId: id, version };
  });
  emitMapWritten({ projectPath, ...created });
  return map;
}

/** Только у updateMap: createWork, deleteWorkFiles и pruneWorksIndex берут прежний WriteOptions. */
export interface UpdateMapOptions extends WriteOptions {
  /** false — `work.updatedAt` не сдвигается: правка не событие работы (порядок сайдбара, спека 6.2). */
  touch?: boolean;
}

/**
 * Единственный способ изменить карту: загрузка, мутация и запись идут одной синхронной транзакцией
 * `BEGIN IMMEDIATE … COMMIT`, поэтому параллельные писатели (хост, CLI, MCP агентов) не затирают друг друга, а
 * неудавшаяся запись не оставляет следов (спека хранилища 6.9, этап 2). На диск уходит только изменившееся: строки
 * списков с другим JSON или порядком (`diffRows`) и строка работы. Мутация, после которой `normalizeMap` не принимает
 * карту, откатывается целиком — раньше такая карта ложилась в файл и ломала следующее чтение. Битую карту в базе не трогаем.
 * Работы нет — `WorkNotFoundError`. После коммита в кэш кладётся карта, которую дал бы свежий разбор записанных строк
 * (см. `applyMapUpdate`), подписчики `onMapWritten` получают событие, а вызывающий — изменённую карту.
 *
 * Мутатор получает вторым аргументом письма работы (`LetterTx`, спека хранилища 6.2); мутаторы с одним аргументом
 * работают как прежде. Мутация, которая ничего не изменила (ни строк карты, ни работы, ни писем), не пишет: версия
 * работы и `updatedAt` прежние, `onMapWritten` молчит (план 4, «Пустая запись не пишет»).
 */
export async function updateMap(
  projectPath: string,
  workId: string,
  mutate: (map: WorkMap, letters: LetterTx) => void,
  options: UpdateMapOptions = {},
): Promise<WorkMap> {
  // Карта уходит вызывающему, и он её меняет: кэшу нужен свой объект — свежая сборка строк, а не эта карта.
  const update = applyMapUpdate(projectPath, workId, mutate, { ...options, keepResult: true });
  return update.shared ? structuredClone(update.map) : update.map;
}

/** Результат `applyMapUpdate`: карта и признак, что объект принадлежит кэшу (запись была пустой или кэш взял саму карту) и наружу идёт копией. */
export interface MapUpdate {
  map: WorkMap;
  shared: boolean;
}

/** Условия `applyMapUpdate` сверх `UpdateMapOptions`: публичные `updateMap` и `writeLetters` их не знают или задают сами. */
interface ApplyMapOptions extends UpdateMapOptions {
  /**
   * `true` — карту результата оставит у себя вызывающий и будет её менять (`updateMap`): кэш тогда держит свежую сборку
   * записанных строк, и объект вызывающего ему не принадлежит. `false` (по умолчанию) — результат не нужен или идёт
   * копией (`writeLetters`): кэш берёт саму записанную карту, уже прошедшую `normalizeMap`, и строки заново не
   * разбираются (спека хранилища 6.9, план 4, задача 5).
   */
  keepResult?: boolean;
}

/**
 * Карту без потерь переживает JSON; ошибка обхода (слишком глубокое дерево) — как «нет». Только такая карта может лечь в
 * кэш как есть, без повторного разбора записанных строк (спека хранилища 6.9).
 */
const survivesJson = (map: WorkMap): boolean => {
  try {
    return isPlainJsonTree(map);
  } catch {
    return false;
  }
};

/**
 * Синхронное тело `updateMap`: транзакция не отпускает цикл событий, поэтому им пользуются и вызывающие, которым нужен
 * результат сразу (`writeLetters`, спека хранилища 6.2). Пустая запись возвращает объект кэша (`shared`): копию берёт
 * тот, кому карта нужна наружу, а `writeLetters` карту не отдаёт и копии не платит.
 *
 * Что лежит в кэше после записи — инвариант «писавший видит то же, что другие процессы»: карта, структурно равная
 * свежему разбору записанных строк (`rowsToMap` и `normalizeMap`). Свежий разбор стоит обхода всей карты, поэтому
 * без `keepResult` кэш берёт саму карту мутатора, но только пока она чистое дерево JSON (`isPlainJsonTree`): ключ
 * без значения, `NaN`, дата или массив, общий у двух писем, после записи и перечитывания выглядели бы иначе, и тогда
 * разбор строк остаётся. С `keepResult` карта уходит вызывающему, и кэш всегда держит свой разобранный объект. Пустая
 * запись возвращает карту в кэш на тех же условиях: строки те же, а объект мутатор мог изменить, не задев JSON.
 */
export function applyMapUpdate(
  projectPath: string,
  workId: string,
  mutate: (map: WorkMap, letters: LetterTx) => void,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, touch = true, keepResult = false }: ApplyMapOptions = {},
): MapUpdate {
  const db = storeDb();
  const key = cacheKey(projectPath, workId);
  const source = mapSource(projectPath, workId);

  const written = writeTransaction(db, lockTimeoutMs, () => {
    const stored = versionOf(db, projectPath, workId);
    if (stored === undefined) {
      mapCache.delete(key);
      throw notFound(projectPath, workId);
    }
    // Карта из кэша процесса — без загрузки и без копии: запись из кэша снимается, после записи ниже кэш получит новую.
    let current: WorkMap;
    let previous: { work: string; extra: string; index: ReadonlyMap<string, StoredRow> };
    const hit = cachedEntry(key, stored);
    if (hit !== undefined) {
      mapCache.delete(key);
      current = hit.map;
      previous = hit;
    } else {
      const loaded = loadStored(db, projectPath, workId);
      if (loaded === undefined) {
        mapCache.delete(key);
        throw notFound(projectPath, workId);
      }
      current = normalizeMap(rowsToMap(loaded.work, loaded.extra, loaded.rows), source);
      previous = { work: loaded.work, extra: loaded.extra, index: rowIndex(loaded.rows) };
    }
    // Карта, разошедшаяся со своим id, — повод отказаться: иначе в списке осела бы запись, которую нечем открыть.
    if (current.work.id !== workId) {
      throw new Error(`map ${source} belongs to workspace ${current.work.id}, not ${workId}`);
    }
    const { letters, wrote, journal } = createTableLetterTx(db, projectPath, workId, current);
    mutate(current, letters);
    // Мутация могла дать карту, которую нормализация не примет: бросает — запись откатывается.
    normalizeMap(current, source);

    // Сдвиг `updatedAt` — после проверки на пустоту: пустая запись его не трогает (спека хранилища 6.2).
    const next = mapToRows(current, previous.index);
    const diff = diffRows(previous, next);
    // Строки карты изменились — до проверки на пустоту и до `touch`: сдвиг `updatedAt` запись структурной не делает.
    const structural = diff.upserts.length > 0 || diff.deletes.length > 0 || diff.workChanged;
    if (!structural && !wrote()) {
      // Строки в базе те же, но объект кэша мутатор мог изменить, не задев JSON (ключ без значения, общий массив): на
      // место он возвращается, только если свежий разбор строк дал бы такую же карту. Иначе записи кэша нет — следующее
      // чтение загрузит базу. Наружу карта уходит копией.
      const keep = hit !== undefined && survivesJson(current);
      if (keep) rememberMap(key, hit);
      return { empty: true as const, current, shared: keep };
    }
    if (touch) {
      current.work.updatedAt = new Date().toISOString();
      next.work = JSON.stringify(current.work);
    }
    for (const row of diff.upserts) {
      sql(db, UPSERT_ENTRY).run(projectPath, workId, row.kind, row.key, row.ord, row.json);
    }
    for (const gone of diff.deletes)
      sql(db, DELETE_ENTRY).run(projectPath, workId, gone.kind, gone.key);
    const updated = sql(db, UPDATE_WORK).get(
      current.work.title,
      current.work.status,
      current.work.updatedAt,
      next.work,
      next.extra,
      projectPath,
      workId,
    );
    return {
      empty: false as const,
      current,
      next,
      version: Number(updated?.['version']),
      prevVersion: stored,
      structural,
      journal: journal(),
    };
  });
  if (written.empty) return { map: written.current, shared: written.shared };

  // В кэш — после коммита (спека хранилища 6.9): карта, структурно равная свежему разбору записанных строк, иначе писавший
  // процесс читал бы карту иначе, чем любой другой. Не вышло — запись снимаем и молчим: карта уже записана, ошибка заставила бы
  // повторить мутацию, а следующее чтение загрузит базу и откажет так же, как отказал бы любой другой процесс.
  let shared = false;
  try {
    // Строки записанной карты — её же JSON (`mapToRows` после `normalizeMap`), поэтому чистое дерево JSON и есть то, что
    // даст разбор этих строк; повторять его нужно, только когда это не так или карту заберёт вызывающий.
    const own = !keepResult && survivesJson(written.current);
    const map = own
      ? written.current
      : normalizeMap(rowsToMap(written.next.work, written.next.extra, written.next.rows), source);
    rememberMap(key, {
      version: written.version,
      map,
      work: written.next.work,
      extra: written.next.extra,
      index: rowIndex(written.next.rows),
    });
    shared = own;
  } catch {
    mapCache.delete(key);
  }
  emitMapWritten({
    projectPath,
    workId,
    version: written.version,
    prevVersion: written.prevVersion,
    structural: written.structural,
    journal: written.journal,
  });
  return { map: written.current, shared };
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

/**
 * Ставит или снимает разрешение агентам закрывать завершённые сессии (sg-12); `false` удаляет поле, миграций карты нет.
 * Как смена статуса — не событие работы: `updatedAt` стоит на месте. Пишет только человек, через окно.
 */
export async function setWorkCloseFinished(
  projectPath: string,
  workId: string,
  closeFinished: boolean,
): Promise<void> {
  await updateMap(
    projectPath,
    workId,
    (map) => {
      if (closeFinished) map.work.closeFinished = true;
      else delete map.work.closeFinished;
    },
    { touch: false },
  );
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
 * Потолок чтения общего файла проекта, если звавший просит его поднять (`readSharedFile(file, limit)`). Карты работ давно
 * не файлы — они в базе (спека хранилища 6.9), и бэклог хоста читает их через `readMap`; константа осталась экспортом
 * для старых вызывающих и своих тестов.
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
