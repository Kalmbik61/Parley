/**
 * Переезд прежних карт в базу на старте хоста (спека хранилища 6.6): `map.json` каждой работы становится строками
 * `works` и `entries`, а сам файл — `map.v2.json`. Прежний глобальный `works-index.json` уходит в `works-index.v2.json`,
 * когда непереехавших работ не осталось. Переименованные файлы — страховка: база их не читает, человек вернёт карту
 * обратным переименованием.
 *
 * Порядок на первом старте — вся схема 6.6, а не только этот файл: (1) каталоги состояния `.harnas` → `.parley` на уровне
 * файлов (`migrateProjects`), (2) карты в базу (здесь), (3) пути артефактов и состояния в картах (`rewriteArtifactRefs`):
 * правка идёт через `updateMap`, и строки работ к этому моменту уже должны быть.
 *
 * Каждая работа сама по себе. Не вышла — остальные переезжают, а её файл остаётся как был и пробуется на следующем
 * старте. Вставка и сверка — одна транзакция: карта читается из ещё не записанных строк (`readStoredMap`) и должна быть
 * структурно равна разобранной из файла (не по тексту JSON: `rowsToMap` порядок полей верхнего уровня не хранит), а
 * непрочитанное каждой сессии и человека — совпасть до и после. Только тогда `COMMIT`, и только после него — `rename`:
 * упади хост между ними, строка есть, файл на месте, и следующий старт лишь переименует его.
 */

import { lstat, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unreadFor, unreadForHuman } from './letters.js';
import { parseMap } from './map.js';
import { stateDir } from './state-dir.js';
import {
  insertMigratedMap,
  isOrphaned,
  readStoredMap,
  readWorksIndex,
  workExists,
  workPaths,
  worksIndexPath,
} from './store.js';
import type { WorkMap } from './types.js';

/** Имя, под которым прежний `map.json` остаётся рядом с картой в базе. */
const MAP_BACKUP_FILE = 'map.v2.json';
/** Имя, под которым прежний `works-index.json` остаётся в доме. */
const INDEX_BACKUP_FILE = 'works-index.v2.json';

export interface MapMigrationResult {
  /** Работа в базе, а прежний файл переименован (в том числе когда прерванный переезд лишь докончен). */
  migrated: { projectPath: string; workId: string }[];
  /** Карта не разобралась, не сошлась со своими строками или файл не переименовался: прежний файл остаётся, пробуем снова. */
  failed: { projectPath: string; workId: string; reason: string }[];
  /** Работа занята процессом прежней сборки (`map.lock` с живым держателем): ничего не тронуто, пробуем на следующем старте. */
  skipped: { projectPath: string; workId: string; reason: 'busy' }[];
}

interface Candidate {
  projectPath: string;
  workId: string;
}

type Outcome =
  | { status: 'none' }
  | { status: 'migrated' }
  | { status: 'busy' }
  | { status: 'failed'; reason: string };

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Код ошибки ФС, а нет его — текст: так причина отказа короче и по ней видно, что случилось. */
const fsReason = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? errorText(error);

/** Что обязана сохранить сверка: непрочитанные письма по каждой сессии и у человека. */
function unreadDigest(map: WorkMap): { bySession: Record<string, string[]>; human: string[] } {
  return {
    bySession: Object.fromEntries(
      map.sessions.map((session) => [session.id, unreadFor(map, session.id).map((message) => message.id)]),
    ),
    human: map.messages.filter(unreadForHuman).map((message) => message.id),
  };
}

/** Идёт ли запись прежней сборки: есть `map.lock`, и его хозяин жив. Замок упавшего процесса работу не держит. */
async function lockHeld(lockFile: string): Promise<boolean> {
  try {
    await lstat(lockFile);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return !(await isOrphaned(lockFile));
}

/** Каталоги работ проекта под текущим именем каталога состояния; нет каталога — работ нет. */
async function workDirs(projectPath: string): Promise<string[]> {
  try {
    const items = await readdir(path.join(stateDir(projectPath), 'works'), { withFileTypes: true });
    return items.filter((item) => item.isDirectory()).map((item) => item.name).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Работы, у которых мог остаться `map.json`: записи прежнего индекса в его порядке (он станет порядком списка), затем
 * карты в каталогах работ каждого известного проекта — проекта из индекса и проекта, у которого в базе уже есть строки.
 */
async function candidates(indexed: readonly Candidate[]): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  const add = (projectPath: string, workId: string): void => {
    const key = `${projectPath}\0${workId}`;
    if (!found.has(key)) found.set(key, { projectPath, workId });
  };
  for (const entry of indexed) add(entry.projectPath, entry.workId);
  const projects = new Set([
    ...indexed.map((entry) => entry.projectPath),
    ...(await readWorksIndex()).works.map((work) => work.projectPath),
  ]);
  for (const projectPath of projects) {
    for (const workId of await workDirs(projectPath)) add(projectPath, workId);
  }
  return [...found.values()];
}

/** Одна работа: от «файла нет» до переименования. Исключение наружу не уходит — оно становится отказом этой работы. */
async function migrateOne({ projectPath, workId }: Candidate): Promise<Outcome> {
  const paths = workPaths(projectPath, workId);
  try {
    try {
      await lstat(paths.map);
    } catch (error) {
      if (isMissing(error)) return { status: 'none' }; // переехала раньше, или работы на диске уже нет
      throw error;
    }
    // Занятость — до чтения: пока писатель прежней сборки жив, его `map.json` ещё меняется.
    if (await lockHeld(path.join(paths.dir, 'map.lock'))) return { status: 'busy' };

    if (workExists(projectPath, workId)) {
      // Прерванный переезд: строки закоммичены, файл не переименован. Вставлять второй раз нельзя, а строки должны собираться.
      readStoredMap(projectPath, workId);
    } else {
      const map = parseMap(await readFile(paths.map, 'utf8'), paths.map);
      if (map.work.id !== workId) {
        throw new Error(`map ${paths.map} belongs to workspace ${map.work.id}, not ${workId}`);
      }
      const before = unreadDigest(map);
      insertMigratedMap(projectPath, workId, map, () => {
        const stored = readStoredMap(projectPath, workId);
        if (!isDeepStrictEqual(stored, map)) {
          throw new Error(`the map read back from the database does not match ${paths.map}`);
        }
        if (!isDeepStrictEqual(unreadDigest(stored), before)) {
          throw new Error(`unread letters read back from the database differ from ${paths.map}`);
        }
      });
    }
  } catch (error) {
    return { status: 'failed', reason: errorText(error) };
  }
  try {
    await rename(paths.map, path.join(paths.dir, MAP_BACKUP_FILE));
  } catch (error) {
    // Работа уже в базе: файл переименует следующий старт.
    return { status: 'failed', reason: `stored in the database, but ${paths.map} could not be renamed: ${fsReason(error)}` };
  }
  return { status: 'migrated' };
}

/**
 * Переносит карты работ из прежних `map.json` в базу и называет, что вышло. Зовёт хост на старте — под замком
 * единственности, после переноса каталогов состояния и до службы работ и автозапуска. Прежний индекс, который не
 * разобрался, — исключение: проектов не назвать, а хост покажет отказ в журнале.
 */
export async function migrateMapsToDb(options: { log?: (line: string) => void } = {}): Promise<MapMigrationResult> {
  const log = options.log ?? (() => undefined);
  const indexFile = worksIndexPath();
  const indexed = (await readWorksIndex(indexFile)).works.map((work) => ({ projectPath: work.projectPath, workId: work.id }));
  const result: MapMigrationResult = { migrated: [], failed: [], skipped: [] };

  for (const candidate of await candidates(indexed)) {
    const { projectPath, workId } = candidate;
    const outcome = await migrateOne(candidate);
    const name = `map ${workId} (${projectPath})`;
    switch (outcome.status) {
      case 'none':
        break;
      case 'migrated':
        result.migrated.push(candidate);
        log(`${name} moved into the database`);
        break;
      case 'busy':
        result.skipped.push({ ...candidate, reason: 'busy' });
        log(`${name} is busy (map.lock is held), left in its file until the next start`);
        break;
      case 'failed':
        result.failed.push({ ...candidate, reason: outcome.reason });
        log(`${name} stays in its file: ${outcome.reason}`);
        break;
    }
  }

  // Индекс нужен следующему старту, пока хоть одна работа осталась в файле: по нему находится проект.
  if (result.failed.length === 0 && result.skipped.length === 0) {
    try {
      await rename(indexFile, path.join(path.dirname(indexFile), INDEX_BACKUP_FILE));
    } catch (error) {
      if (!isMissing(error)) log(`the old workspace index could not be renamed: ${fsReason(error)}`);
    }
  }
  return result;
}
