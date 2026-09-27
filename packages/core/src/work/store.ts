import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { bumpWorkId, nextWorkId, parseMap } from './map.js';
import type { WorkIndexEntry, WorkMap, WorksIndex, WorkStatus } from './types.js';

/** Домашняя папка харнесса. Переопределяется через окружение — этим живут тесты. */
export function harnasHome(): string {
  const fromEnv = process.env.HARNAS_HOME;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(homedir(), '.harnas');
}

/** Глобальный индекс работ: все работы всех проектов. */
export function worksIndexPath(): string {
  return path.join(harnasHome(), 'works-index.json');
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
  /** Хуки Claude Code для сессий работы (`--settings`), один файл на работу. */
  settings: string;
}

/** Раскладка работы на диске (спецификация, раздел 2). */
export function workPaths(projectPath: string, workId: string): WorkPaths {
  const dir = path.join(projectPath, '.harnas', 'works', workId);
  return {
    dir,
    map: path.join(dir, 'map.json'),
    bak: path.join(dir, 'map.json.bak'),
    lock: path.join(dir, 'map.lock'),
    briefs: path.join(dir, 'briefs'),
    artifacts: path.join(dir, 'artifacts'),
    mcp: path.join(dir, 'mcp'),
    events: path.join(dir, 'events'),
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
 * (TUI, хост и MCP-серверы агентов), и хосту нужно отличить именно занятость
 * блокировки от прочих сбоев записи, чтобы не падать, а сообщить `host.notice`
 * и повторить на следующем событии (план, кусок 1.4).
 */
export class MapLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`блокировка ${lockFile} не снята за ${timeoutMs} мс`);
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
async function acquireLock(lockFile: string, timeoutMs: number): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new MapLockTimeoutError(lockFile, timeoutMs);
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
  ];
  await Promise.all(files.map((file) => rm(file, { force: true })));
}

/**
 * Удаляет работу целиком: каталог `.harnas/works/<id>` со всем содержимым,
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

/** Читает глобальный индекс; файла ещё нет — индекс пустой. */
export async function readWorksIndex(): Promise<WorksIndex> {
  const file = worksIndexPath();
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
    throw new Error(`индекс работ ${file} не парсится: ${(error as Error).message}`);
  }
  const works = (data as Partial<WorksIndex>).works;
  if ((data as Partial<WorksIndex>).schemaVersion !== 1 || !Array.isArray(works)) {
    throw new Error(`индекс работ ${file} не парсится: неожиданная форма`);
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
 * пустым, когда карты в проекте уже лежат (clone проекта с закоммиченным `.harnas/`,
 * перенос `HARNAS_HOME`, копия проекта). Поэтому занятые на диске id пропускаются,
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

  await withWorksIndex(lockTimeoutMs, async (index) => {
    let id = nextWorkId(index);
    while (await exists(workPaths(projectPath, id).map)) id = bumpWorkId(id);
    map.work.id = id;
    index.works.push(entryOf(projectPath, map));
  });

  const paths = workPaths(projectPath, map.work.id);
  await mkdir(paths.briefs, { recursive: true });
  await mkdir(paths.artifacts, { recursive: true });
  const text = serialize(map);
  await withLock(paths.lock, lockTimeoutMs, async () => {
    try {
      await writeFile(paths.map, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(`карта ${paths.map} уже существует — работа не создана`);
    }
    // `.bak` с первой же записи: раздел 8 обещает предыдущую версию для любой карты.
    await writeFile(paths.bak, text, 'utf8');
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
    new WorkNotFoundError(`карты ${paths.map} нет — работы ${workId} не существует`);
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
      throw new Error(`карта ${paths.map} принадлежит работе ${current.work.id}, а не ${workId}`);
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
    throw new Error(`название работы: 1–${WORK_TITLE_MAX} символов`);
  }
  return updateMap(projectPath, workId, (map) => (map.work.title = trimmed), { touch: false });
}

/**
 * Меняет статус работы. Живые сессии архив не трогает — так же, как TUI; и это
 * тоже не событие работы, поэтому `updatedAt` не сдвигается.
 */
export async function setWorkStatus(
  projectPath: string,
  workId: string,
  status: WorkStatus,
): Promise<WorkMap> {
  return updateMap(projectPath, workId, (map) => (map.work.status = status), { touch: false });
}
