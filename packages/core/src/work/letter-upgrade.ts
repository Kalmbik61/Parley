/**
 * Переезд на схему с письмами в своих таблицах (спека хранилища 6.6, план 4, задача 8): сверка карты, собранной из
 * таблиц, с исходной — одна и для переезда `map.json` (`migrate-to-db.ts`), и для апгрейда базы со схемы 1 (письма —
 * строки `entries` вида `message`, сборка плана 3: только разработка и приёмка, план 3 отдельно не выпускался).
 *
 * Сверка в обоих случаях двойная. Собранная из базы карта (`readStoredMapOn`) структурно равна исходной — не по тексту JSON,
 * порядок полей не хранится. И непрочитанное каждой сессии и человека, как его отдаёт база (кандидаты и живые правила),
 * совпадает с тем, что дают прежние правила над исходной картой (`unreadFor`, `unreadForHuman`): по письмам одним
 * сравнением карт не поймать кандидата, которого не положили.
 */

import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { letterByIdRow, replaceLetters, unreadOfHuman, unreadOfSession } from './letter-tables.js';
import { unreadFor, unreadForHuman } from './letters.js';
import { diffRows, ENTRY_FIELDS, mapToRows, rowIndex, rowsToMap, type StoredRow } from './map-rows.js';
import { normalizeLegacyMap } from './map.js';
import { sql } from './sql-statements.js';
import { DELETE_ENTRY, readStoredMapOn, UPSERT_ENTRY } from './store.js';
import type { WindowWorkMap } from './types.js';

/** Что обязана сохранить сверка: непрочитанные письма по каждой сессии и у человека. */
export interface UnreadDigest {
  bySession: Record<string, string[]>;
  human: string[];
}

/** Непрочитанное по прежним правилам над картой с письмами: то, что видели окно и агенты до переезда. */
export function legacyUnread(map: WindowWorkMap): UnreadDigest {
  return {
    bySession: Object.fromEntries(
      map.sessions.map((session) => [session.id, unreadFor(map, session.id).map((message) => message.id)]),
    ),
    human: map.messages.filter(unreadForHuman).map((message) => message.id),
  };
}

/** Непрочитанное по каждой сессии карты и у человека так, как его отдаёт база: кандидаты, затем живые правила. */
function storedUnread(db: DatabaseSync, projectPath: string, workId: string, map: WindowWorkMap): UnreadDigest {
  const byId = (id: string) => letterByIdRow(db, projectPath, workId, id);
  return {
    bySession: Object.fromEntries(
      map.sessions.map((session) => [
        session.id,
        unreadOfSession(db, projectPath, workId, session.id, map, byId).map((message) => message.id),
      ]),
    ),
    human: unreadOfHuman(db, projectPath, workId).map((message) => message.id),
  };
}

/**
 * Сверка работы, чьи строки уже в базе (внутри транзакции их видно и до `COMMIT`): карта из таблиц равна `expected`, а
 * непрочитанное из базы — `before`, снятому с исходной карты до вставки. Не сошлось — исключение с причиной: `source` —
 * то, с чем сверяли (имя файла или «строки схемы 1»), `mismatch` — текст отказа при разных картах. Таблицы, из которых
 * карта не собирается, бросают свою ошибку, и она становится причиной.
 */
export function verifyLetterMap(
  db: DatabaseSync,
  projectPath: string,
  workId: string,
  expected: WindowWorkMap,
  before: UnreadDigest,
  source: string,
  mismatch = `the map read back from the database does not match ${source}`,
): void {
  const stored = readStoredMapOn(db, projectPath, workId);
  if (!isDeepStrictEqual(stored, expected)) throw new Error(mismatch);
  const after = storedUnread(db, projectPath, workId, stored);
  if (!isDeepStrictEqual(after.human, before.human)) {
    throw new Error(`unread letters of the human read back from the database differ from ${source}`);
  }
  for (const [reader, ids] of Object.entries(before.bySession)) {
    if (!isDeepStrictEqual(after.bySession[reader], ids)) {
      throw new Error(`unread letters of ${reader} read back from the database differ from ${source}`);
    }
  }
}

/** Строка `entries` схемы 1: вид письма (`message`) в `EntryKind` схемы 2 больше не входит. */
interface RowV1 {
  kind: string;
  key: string;
  ord: number;
  json: string;
}

/**
 * Одна работа схемы 1 в схему 2. Карта собирается из строк `entries` прежним `rowsToMap`, письма (`message`, порядок по
 * `ord`) подставляются в неё как `messages` и проходят разбор прежней карты: форма писем, приведение времени и `deleted`
 * (`normalizeLegacyMap`). Дальше карта раскладывается заново: списки — только изменившимися строками (сжатые тексты
 * экспортов и эффектов, `compactStoredTexts`), письма — в таблицы с отметками и кандидатами по правилам на состав комнат
 * этого момента, строки `message` из `entries` уходят. В конце — сверка (`verifyLetterMap`).
 */
function upgradeWork(db: DatabaseSync, projectPath: string, workId: string): void {
  const head = sql(db, 'SELECT work_json, extra_json FROM works WHERE project_path = ? AND id = ?').get(projectPath, workId);
  const work = String(head?.['work_json']);
  const extra = String(head?.['extra_json']);
  const rows = sql(db, 'SELECT kind, key, ord, json FROM entries WHERE project_path = ? AND work_id = ? ORDER BY kind, ord').all(
    projectPath,
    workId,
  ) as unknown as RowV1[];
  const letters = rows
    .filter((row) => row.kind === 'message')
    .sort((a, b) => a.ord - b.ord)
    .map((row) => JSON.parse(row.json) as unknown);
  // Строки неизвестного вида (их `rowsToMap` пропускает) остаются как были: ни собрать их, ни удалить нечем.
  const lists = rows.filter((row) => Object.hasOwn(ENTRY_FIELDS, row.kind)) as StoredRow[];

  const data = rowsToMap(work, extra, lists) as Record<string, unknown>;
  data['messages'] = letters;
  const expected = normalizeLegacyMap(data, `${workId} (${projectPath})`);
  const before = legacyUnread(expected);

  const index = rowIndex(lists);
  const next = mapToRows(expected, index);
  const diff = diffRows({ work, extra, index }, next);
  for (const row of diff.upserts) sql(db, UPSERT_ENTRY).run(projectPath, workId, row.kind, row.key, row.ord, row.json);
  for (const gone of diff.deletes) sql(db, DELETE_ENTRY).run(projectPath, workId, gone.kind, gone.key);
  if (diff.workChanged) {
    sql(db, 'UPDATE works SET work_json = ?, extra_json = ? WHERE project_path = ? AND id = ?').run(next.work, next.extra, projectPath, workId);
  }
  sql(db, `DELETE FROM entries WHERE project_path = ? AND work_id = ? AND kind = 'message'`).run(projectPath, workId);
  replaceLetters(db, projectPath, workId, expected);
  verifyLetterMap(db, projectPath, workId, expected, before, 'the schema 1 rows');
}

/**
 * Поднимает работы базы со схемы 1 до схемы 2 (письма из `entries` в таблицы) на открытии, внутри транзакции открытия:
 * вызывающий уже создал таблицы писем и после возврата ставит `user_version = 2`. Любой сбой — исключение с номером
 * работы; транзакция откатится целиком, база останется схемы 1, а хост покажет причину в журнале (спека хранилища 6.6).
 */
export function upgradeLettersSchema(db: DatabaseSync): void {
  const works = sql(db, 'SELECT project_path, id FROM works ORDER BY project_path, id').all();
  for (const row of works) {
    const projectPath = String(row['project_path']);
    const workId = String(row['id']);
    try {
      upgradeWork(db, projectPath, workId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `parley.db could not be upgraded from schema 1 to schema 2: workspace ${workId} (${projectPath}): ${reason}. ` +
          'The database is unchanged and stays at schema 1.',
        { cause: error },
      );
    }
  }
}
