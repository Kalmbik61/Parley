/**
 * Переезд прежних карт в базу на старте хоста (спека хранилища 6.6): `map.json` каждой работы становится строками
 * `works` и `entries`, письмами с отметками и кандидатами в непрочитанное (`messages`, `message_reads`, `message_unread`;
 * `insertMigratedMap`), а сам файл — `map.v2.json`. Письмам нужен уникальный номер `m-N`: карта с повторяющимися номерами
 * не переезжает (`failed`), её файл остаётся. Прежний глобальный `works-index.json` уходит в `works-index.v2.json`,
 * когда каждая его запись урегулирована: работа в базе, или её каталог цел и без `map.json`. Не найденная на диске
 * работа (проект на несмонтированном томе), непереехавшая и непрочитанный проект индекс удерживают: по нему следующий
 * старт найдёт карты. Переименованные файлы — страховка: база их не читает, человек вернёт карту
 * обратным переименованием.
 *
 * Порядок на первом старте — вся схема 6.6, а не только этот файл: (1) каталоги состояния `.harnas` → `.parley` на уровне
 * файлов (`migrateProjects`), (2) карты в базу (здесь), (3) пути артефактов и состояния в картах (`rewriteArtifactRefs`):
 * правка идёт через `updateMap`, и строки работ к этому моменту уже должны быть.
 *
 * Каждая работа сама по себе. Не вышла — остальные переезжают, а её файл остаётся как был и пробуется на следующем
 * старте. Вставка и сверка — одна транзакция: карта читается из ещё не записанных строк (`readStoredMap`) и должна быть
 * структурно равна разобранной из файла (не по тексту JSON: `rowsToMap` порядок полей верхнего уровня не хранит) и
 * сжатой: тексты записанных экспортов и отправленных эффектов в базу не идут (`compactStoredTexts`, спека хранилища 6.2),
 * а непрочитанное каждой сессии и человека, как его отдаёт база, — совпасть с прежними правилами над картой из файла
 * (`verifyLetterMap`, `letter-upgrade.ts`). Письма переезжают такими, какими были: незнакомые ключи письма едут в `body`,
 * время приводится к каноническому ISO-моменту, `deleted: false` убирается (`migrateMessage`); письмо с полем неверной формы,
 * нечитаемым временем, номером не `m-N` или повторным номером отказывает работе с причиной, номера не переписываются.
 * Только после сверки `COMMIT`, и только после него — `rename`:
 * упади хост между ними, строка есть, файл на месте, и следующий старт лишь переименует его — если файл равен строкам;
 * иначе (файл вернули после отката сборки и в него писали) работа `failed`, и оба остаются как были.
 */

import { lstat, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { legacyUnread, verifyLetterMap, type UnreadDigest } from './letter-upgrade.js';
import { parseMap } from './map.js';
import { stateDir } from './state-dir.js';
import { compactStoredTexts } from './stored-texts.js';
import {
  insertMigratedMap,
  isOrphaned,
  readWorksIndex,
  storeDb,
  workExists,
  workPaths,
  worksIndexPath,
} from './store.js';
import type { WindowWorkMap } from './types.js';

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
  /** Карты нет. `settled` — работа не потеряна: она уже в базе или её каталог цел и без `map.json` (спека хранилища 6.6). */
  | { status: 'none'; settled: boolean }
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

/** Причина отказа, когда у работы есть и строка, и `map.json`, а карты разные: файл новее строк или наоборот, выбирать нечем. */
const DIFFERS_FROM_STORED = 'map.json differs from the stored copy (newer edits after a downgrade?)';

/**
 * Сверка карты из строк с разобранной из файла — одна и для вставки (внутри её транзакции), и для работы, у которой уже
 * есть строка: карты равны структурно, а не по тексту JSON, и непрочитанное каждой сессии и человека, как его отдаёт
 * база, то же, что дали прежние правила над картой из файла до вставки (`before`; `letter-upgrade.ts`, спека хранилища 6.6).
 * Строки не собираются в карту — `readStoredMap` бросит свою ошибку, и она станет причиной отказа.
 */
function verifyStored(
  projectPath: string,
  workId: string,
  map: WindowWorkMap,
  before: UnreadDigest,
  file: string,
  mismatch?: string,
): void {
  verifyLetterMap(storeDb(), projectPath, workId, map, before, file, mismatch);
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

/**
 * Карта из `map.json` в том виде, в каком она ляжет в базу и с каким её сверяют: записанные экспорты без текста,
 * отправленные эффекты с хэшем вместо текста (спека хранилища 6.2). `parseMap` сжимает карту сам; явный вызов держит
 * сверку переезда независимой от того, где ядро переводит старый вид.
 */
async function readLegacyMap(file: string): Promise<WindowWorkMap> {
  return compactStoredTexts(parseMap(await readFile(file, 'utf8'), file));
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
 * Проект, чей каталог работ не читается (права, сбой диска), не останавливает остальных: он называется в `unreadable`
 * и до следующего старта остаётся неурегулированным.
 */
async function candidates(
  indexed: readonly Candidate[],
  log: (line: string) => void,
): Promise<{ list: Candidate[]; unreadable: string[] }> {
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
  const unreadable: string[] = [];
  for (const projectPath of projects) {
    try {
      for (const workId of await workDirs(projectPath)) add(projectPath, workId);
    } catch (error) {
      unreadable.push(projectPath);
      log(`the works of ${projectPath} cannot be listed (${fsReason(error)}), their maps wait for the next start`);
    }
  }
  return { list: [...found.values()], unreadable };
}

/** Каталог работы цел (это каталог): без него у записи индекса нет ни карты, ни следа, и сказать «переехала» нельзя. */
async function workDirExists(dir: string): Promise<boolean> {
  try {
    return (await lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Одна работа: от «файла нет» до переименования. Исключение наружу не уходит — оно становится отказом этой работы. */
async function migrateOne({ projectPath, workId }: Candidate): Promise<Outcome> {
  const paths = workPaths(projectPath, workId);
  try {
    try {
      await lstat(paths.map);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Карты нет: переехала раньше (строка в базе или каталог без `map.json`) — или не видна, потому что проект или
      // каталог недоступны (том не смонтирован): такую запись индекса отпускать рано.
      return { status: 'none', settled: workExists(projectPath, workId) || (await workDirExists(paths.dir)) };
    }
    // Занятость — до чтения: пока писатель прежней сборки жив, его `map.json` ещё меняется.
    if (await lockHeld(path.join(paths.dir, 'map.lock'))) return { status: 'busy' };

    if (workExists(projectPath, workId)) {
      // Строка и файл разом: прерванный переезд (строки закоммичены, файл не переименован) или возврат после отката сборки
      // (`map.v2.json` переименован обратно, прежняя сборка писала в него). Вставлять второй раз нельзя, а переименовать
      // файл, который новее строк, — спрятать правки: переименование только если файл равен строкам (спека хранилища 6.6).
      const map = await readLegacyMap(paths.map);
      verifyStored(projectPath, workId, map, legacyUnread(map), paths.map, DIFFERS_FROM_STORED);
    } else {
      const map = await readLegacyMap(paths.map);
      if (map.work.id !== workId) {
        throw new Error(`map ${paths.map} belongs to workspace ${map.work.id}, not ${workId}`);
      }
      const before = legacyUnread(map);
      insertMigratedMap(projectPath, workId, map, () => {
        verifyStored(projectPath, workId, map, before, paths.map);
      });
    }
  } catch (error) {
    return { status: 'failed', reason: errorText(error) };
  }
  try {
    await rename(paths.map, path.join(paths.dir, MAP_BACKUP_FILE));
  } catch (error) {
    // Работа уже в базе: файл переименует следующий старт (спека хранилища 6.6: старый `map.json` на месте не держат).
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
  const inIndex = new Set(indexed.map((entry) => `${entry.projectPath}\0${entry.workId}`));
  /** Записи индекса, чью работу не найти ни в базе, ни на диске: том не смонтирован или каталог убрали. */
  const missing: Candidate[] = [];

  const { list, unreadable } = await candidates(indexed, log);
  // Первый старт с большими картами длится заметно, а окно до тех пор «подключается»: одна строка в журнале хоста, чтобы
  // было видно, что хост занят переездом, а не завис. Работы без `map.json` (переехали раньше) в счёт не идут.
  const pending = (
    await Promise.all(
      list.map(({ projectPath, workId }) =>
        lstat(workPaths(projectPath, workId).map).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).filter(Boolean).length;
  if (pending > 0) log(`переезд карт в базу: ${pending} работ`);
  for (const candidate of list) {
    const { projectPath, workId } = candidate;
    const outcome = await migrateOne(candidate);
    const name = `map ${workId} (${projectPath})`;
    switch (outcome.status) {
      case 'none':
        if (!outcome.settled && inIndex.has(`${projectPath}\0${workId}`)) {
          missing.push(candidate);
          log(`${name} is not on disk (project or folder unavailable), its entry stays in the old index`);
        }
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

  // Индекс нужен следующему старту, пока хоть одна работа осталась в файле или не найдена: по нему находится проект.
  // Исчезнувший том вернётся с картами на месте, и без записи индекса они не нашлись бы.
  const settled =
    result.failed.length === 0 && result.skipped.length === 0 && missing.length === 0 && unreadable.length === 0;
  if (settled) {
    try {
      await rename(indexFile, path.join(path.dirname(indexFile), INDEX_BACKUP_FILE));
    } catch (error) {
      if (!isMissing(error)) log(`the old workspace index could not be renamed: ${fsReason(error)}`);
    }
  }
  return result;
}
