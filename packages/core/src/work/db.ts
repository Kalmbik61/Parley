/**
 * Рабочая база Parley: одна SQLite-база `<parleyHome>/parley.db` на все работы и проекты (спека хранилища 6.1).
 * Вместо `works-index.json` и `map.json` по каталогам работ — таблицы `works` (карта без списков) и `entries`
 * (элементы списков карты). Встроенный `node:sqlite`, без внешних зависимостей.
 *
 * Базой владеет хост: на один `parleyHome` хост один (спека хранилища 6.1), поэтому дескриптор здесь один на процесс.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parleyHome } from './store.js';

/**
 * `node:sqlite` подключается через `require`, а не статическим `import`: Vite 5 (под vitest 2) не знает модули, у которых
 * есть только имя с префиксом `node:`, срезает префикс и ищет пакет `sqlite`. Так база грузится одинаково из
 * `dist` ядра, хоста, приложения и из любых тестов, и конфиги vitest других пакетов трогать не нужно.
 */
const { DatabaseSync: Database } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

export const WORK_DB_FILE = 'parley.db';
export const WORK_DB_SCHEMA_VERSION = 1;

/**
 * Схема версии 1 (спека хранилища 6.1). `works` — строка на работу: заголовок, статус и версия вынесены в колонки
 * для выборок, остальная карта лежит в `work_json`, а то, чего схема ещё не знает, — в `extra_json`.
 * `entries` — списки карты по одному элементу на строку; `ord` хранит порядок внутри `kind`.
 */
const SCHEMA_V1 = `
CREATE TABLE works (
  project_path TEXT NOT NULL, id TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  work_json TEXT NOT NULL, extra_json TEXT NOT NULL,
  PRIMARY KEY (project_path, id));
CREATE TABLE entries (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL,
  kind TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, kind, key),
  FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
CREATE INDEX entries_order ON entries(project_path, work_id, kind, ord);
`;

interface Opened {
  file: string;
  db: DatabaseSync;
}

let opened: Opened | undefined;

/**
 * Дескриптор базы текущего `parleyHome()`. Кэшируется по пути; когда дом меняется (тесты меняют `PARLEY_HOME`
 * между тестами), прежняя база закрывается и открывается другая.
 */
export function workDb(): DatabaseSync {
  const file = path.join(parleyHome(), WORK_DB_FILE);
  if (opened?.file === file) return opened.db;
  closeWorkDb();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    prepare(db);
  } catch (error) {
    db.close();
    throw error;
  }
  opened = { file, db };
  return db;
}

/** Закрывает базу, если она открыта: для тестов и остановки хоста. Повторный вызов ничего не делает. */
export function closeWorkDb(): void {
  const current = opened;
  opened = undefined;
  current?.db.close();
}

/**
 * Настройки соединения и схема. Сначала `busy_timeout`: остальные PRAGMA и создание схемы тоже могут упереться
 * в замок другого процесса (CLI агента открывает ту же базу). Версия схемы читается уже под `BEGIN IMMEDIATE`,
 * чтобы два процесса не создали таблицы дважды.
 */
function prepare(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec('BEGIN IMMEDIATE');
  try {
    if (userVersion(db) < WORK_DB_SCHEMA_VERSION) {
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${WORK_DB_SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}
