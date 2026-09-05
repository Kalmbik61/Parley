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
import type { WorkIndexEntry, WorkMap, WorksIndex } from './types.js';

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

/** Эксклюзивное создание файла — атомарная операция файловой системы. */
async function acquireLock(lockFile: string, timeoutMs: number): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`блокировка ${lockFile} не снята за ${timeoutMs} мс`);
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
    schemaVersion: 1,
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
export async function updateMap(
  projectPath: string,
  workId: string,
  mutate: (map: WorkMap) => void,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: WriteOptions = {},
): Promise<WorkMap> {
  const paths = workPaths(projectPath, workId);
  // Блокировка живёт в каталоге работы, поэтому про несуществующую работу первым
  // отчитался бы ENOENT про `map.lock` — не про тот файл, которого на самом деле нет.
  if (!(await exists(paths.map))) {
    throw new Error(`карты ${paths.map} нет — работы ${workId} не существует`);
  }

  return withLock(paths.lock, lockTimeoutMs, async () => {
    const raw = await readFile(paths.map, 'utf8');
    const current = parseMap(raw, paths.map);
    // Карта, разошедшаяся с именем каталога, — повод отказаться: иначе в индексе
    // осела бы запись с чужим id, которую в списке работ нечем открыть.
    if (current.work.id !== workId) {
      throw new Error(`карта ${paths.map} принадлежит работе ${current.work.id}, а не ${workId}`);
    }
    mutate(current);
    current.work.updatedAt = new Date().toISOString();

    // Индекс обновляем до записи карты и не отпуская `map.lock`: его отказ должен
    // означать «карта не переписана», иначе ретрай вызывающего продублирует мутацию.
    // Порядок записей в индексе при этом остаётся порядком записей карты.
    await withWorksIndex(lockTimeoutMs, (index) => upsert(index, entryOf(projectPath, current)));
    await writeFile(paths.bak, raw, 'utf8');
    await writeAtomic(paths.map, serialize(current));
    return current;
  });
}
