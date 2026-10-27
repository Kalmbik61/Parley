/**
 * Рабочая база Parley: одна SQLite-база `<parleyHome>/parley.db` на все работы и проекты (спека хранилища 6.1).
 * Вместо `works-index.json` и `map.json` по каталогам работ — таблицы `works` (карта без списков) и `entries`
 * (элементы списков карты). Встроенный `node:sqlite`, без внешних зависимостей.
 *
 * Базой владеет хост: на один `parleyHome` хост один (спека хранилища 6.1), поэтому дескриптор здесь один на процесс.
 */

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { upgradeLettersSchema } from './letter-upgrade.js';
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
export const WORK_DB_SCHEMA_VERSION = 2;
/** Сколько соединение ждёт чужую блокировку по умолчанию; запись на время транзакции ставит своё и возвращает это (спека хранилища 6.9). */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Основа схемы (спека хранилища 6.1). `works` — строка на работу: заголовок, статус и версия вынесены в колонки
 * для выборок, остальная карта лежит в `work_json`, а то, чего схема ещё не знает, — в `extra_json`.
 * `entries` — списки карты по одному элементу на строку; `ord` хранит порядок внутри `kind`.
 */
const SCHEMA_BASE = `
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

/**
 * Письма в своих таблицах (спека хранилища 6.2, план 4). `messages` — строка на письмо: `seq` — число из `m-NN`, `id` —
 * номер как записан (`m-01`, `m-3795`), `recipients` — JSON `to`, `body` — JSON `{text, replyTo?, via?}`. `message_reads` —
 * кто и когда прочитал (прежний `readBy`). `message_unread` — кандидаты в непрочитанное: надмножество, окончательно письмо
 * отбирают живые правила (`recipientsOf`, `cancelledPlanLetter`, `isHumanUnread`) на маленьком наборе кандидатов.
 * Индекс `message_unread_seq` — для внешнего ключа на `messages(…, seq)`: первичный ключ кандидатов начинается с читателя, и
 * без индекса каскад каждого удалённого письма обходил бы всех кандидатов работы (замер: удаление комнаты из 20 000
 * писем при 32 000 кандидатов — 48 с без индекса, 0,6 с с ним).
 */
const SCHEMA_LETTERS = `
CREATE TABLE messages (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL,
  seq INTEGER NOT NULL, id TEXT NOT NULL,
  room_id TEXT, sender TEXT NOT NULL, recipients TEXT NOT NULL,
  at TEXT NOT NULL, kind TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, seq),
  FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
CREATE UNIQUE INDEX messages_id ON messages(project_path, work_id, id);
CREATE INDEX messages_channel ON messages(project_path, work_id, room_id, seq);
CREATE INDEX messages_at ON messages(project_path, work_id, at);
CREATE TABLE message_reads (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL, seq INTEGER NOT NULL,
  reader TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, seq, reader),
  FOREIGN KEY (project_path, work_id, seq) REFERENCES messages(project_path, work_id, seq) ON DELETE CASCADE);
CREATE TABLE message_unread (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL, reader TEXT NOT NULL,
  seq INTEGER NOT NULL, room_id TEXT,
  PRIMARY KEY (project_path, work_id, reader, seq),
  FOREIGN KEY (project_path, work_id, seq) REFERENCES messages(project_path, work_id, seq) ON DELETE CASCADE);
CREATE INDEX message_unread_seq ON message_unread(project_path, work_id, seq);
`;

/** Схема версии 2: основа и письма. Базу версии 1 (сборка плана 3, письма в `entries`) `upgradeLettersSchema` поднимает до неё. */
const SCHEMA_V2 = SCHEMA_BASE + SCHEMA_LETTERS;

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
  createPrivateFile(file);
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

/**
 * Файл базы заводится с правами 0600 до того, как SQLite его откроет: в нём переписка всех проектов (спека хранилища 6.1),
 * а `-wal` и `-shm` SQLite создаёт с правами самой базы. Уже существующий файл не трогается.
 */
function createPrivateFile(file: string): void {
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
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
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec('BEGIN IMMEDIATE');
  try {
    const version = userVersion(db);
    if (version === 1) {
      // База версии 1 (сборка плана 3, письма — строки `entries`): письменные таблицы создаются рядом, письма переезжают в
      // них и сверяются, и всё это одной транзакцией с подъёмом версии — упало что-то, остаётся схема 1 (спека хранилища 6.6).
      db.exec(SCHEMA_LETTERS);
      upgradeLettersSchema(db);
      db.exec(`PRAGMA user_version = ${WORK_DB_SCHEMA_VERSION}`);
    } else if (version < WORK_DB_SCHEMA_VERSION) {
      db.exec(SCHEMA_V2);
      db.exec(`PRAGMA user_version = ${WORK_DB_SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Транзакции уже нет (COMMIT не прошёл или SQLite откатила сама): причина — исходная ошибка, её и бросаем.
    }
    throw error;
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}
