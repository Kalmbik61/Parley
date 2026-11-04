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
 * писем при 32 000 кандидатов — 48 с без индекса, 0,6 с с ним). Индекс `messages_sender` — для писем одного отправителя в канале
 * по номеру (ответ человека на решение комнаты, `lastHumanDecision`): без него страница таких писем обходила канал целиком
 * (замер: 84 из 91 мс сборки снимка без писем при 100 000 письмах, спека rooms.mail 6.8).
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
CREATE INDEX messages_sender ON messages(project_path, work_id, room_id, sender, seq);
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

/**
 * Индекс отправителя для баз версии 2, открытых до него: схема 2 не выпущена (живут только дома разработки), поэтому версию
 * не поднимаем, а при открытии дописываем индекс. `IF NOT EXISTS` — у новой базы и у той, что уже получила его, ничего не делает.
 */
const MESSAGES_SENDER_INDEX = 'CREATE INDEX IF NOT EXISTS messages_sender ON messages(project_path, work_id, room_id, sender, seq)';

/** Номер создания не зависит от часов/rowid и не освобождается при удалении работы. */
function upgradeIncarnations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE work_incarnation_clock (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      value INTEGER NOT NULL CHECK(typeof(value) = 'integer' AND value BETWEEN 0 AND 9007199254740991));
    INSERT INTO work_incarnation_clock VALUES (1, 0);
    ALTER TABLE works ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 0;
  `);
  const assign = db.prepare('UPDATE works SET incarnation = ? WHERE rowid = ?');
  let next = 0;
  for (const row of db.prepare('SELECT rowid FROM works ORDER BY rowid').all()) {
    if (!Number.isSafeInteger(++next)) throw new Error('Work incarnation allocator exhausted');
    assign.run(next, row['rowid']!);
  }
  db.prepare('UPDATE work_incarnation_clock SET value = ? WHERE singleton = 1').run(next);
  db.exec(`
    CREATE TRIGGER works_assign_incarnation AFTER INSERT ON works BEGIN
      SELECT CASE WHEN (SELECT value FROM work_incarnation_clock WHERE singleton = 1) >= 9007199254740991
        THEN RAISE(ABORT, 'Work incarnation allocator exhausted') END;
      UPDATE work_incarnation_clock SET value = value + 1 WHERE singleton = 1;
      UPDATE works SET incarnation = (SELECT value FROM work_incarnation_clock WHERE singleton = 1)
        WHERE project_path = NEW.project_path AND id = NEW.id;
    END;
  `);
}

/**
 * Assistant Core: `assistant_jobs` — задания помощника (`idempotency_key` не даёт выполнить одно дело дважды),
 * `assistant_cards` — карточки подтверждения, что переживают рестарт хоста. `payload_json` карточки — всё, что хост
 * знает о действии помимо вида для окна (`view_json`). `IF NOT EXISTS`: шаг повторяем на базе, у которой версию опустили.
 */
const SCHEMA_ASSISTANT_CORE = `
  CREATE TABLE IF NOT EXISTS assistant_jobs (
    job_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL,
    correlation_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','needs_confirmation','completed','failed','cancelled')),
    revision INTEGER NOT NULL,
    request_text TEXT NOT NULL,
    result_summary TEXT,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_via TEXT,
    outcome TEXT);
  CREATE INDEX IF NOT EXISTS assistant_jobs_state ON assistant_jobs(state, provider, created_at);
  CREATE TABLE IF NOT EXISTS assistant_cards (
    proposal_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    view_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','decided','expired','superseded')),
    revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_via TEXT,
    outcome TEXT);
  CREATE INDEX IF NOT EXISTS assistant_cards_state ON assistant_cards(state, source, created_at);
`;

/**
 * Уведомления (спека 2026-11-03, T1): `notifications` — каноническое хранилище событий, только конверт (виды, счётчики,
 * маршруты, opaque-id; пользовательских текстов в строках нет). `UNIQUE(dedupe_key)` + `ON CONFLICT DO NOTHING` не дают
 * повтору события (reconnect, рестарт) создать вторую запись. `notification_outbox` — durable очередь доставки по каналам:
 * попытки, `next_attempt_at` и предел попыток. Пассивный сток: прошлые события при первом старте не заливаются.
 */
const SCHEMA_NOTIFICATIONS = `
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    workspace_id TEXT,
    entity_ref TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    requires_action INTEGER NOT NULL CHECK(requires_action IN (0,1)),
    payload_ref TEXT,
    notification_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('new','seen','acked','expired')),
    seen_at INTEGER,
    acked_at INTEGER,
    acked_via TEXT);
  CREATE INDEX IF NOT EXISTS notifications_state ON notifications(state, created_at);
  CREATE TABLE IF NOT EXISTS notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE(notification_id, channel));
  CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(state, next_attempt_at);
`;

/**
 * Учёт голосовых сессий GPT-Live (спека 2026-11-03, B2): строка на сессию. `seconds_estimate` растёт по usage-событиям,
 * `seconds_final` и `cost_final` ставит `session.closed`; `state = 'closed'` — терминал. `cost_final` пока NULL:
 * тариф за секунду не зашит в код. День — локальный (`YYYY-MM-DD`), по нему B4 считает дневной лимит.
 */
const SCHEMA_VOICE_USAGE = `
  CREATE TABLE IF NOT EXISTS voice_usage (
    voice_session_id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','closed')),
    seconds_estimate INTEGER NOT NULL DEFAULT 0,
    seconds_final INTEGER,
    cost_final REAL,
    close_reason TEXT);
  CREATE INDEX IF NOT EXISTS voice_usage_day ON voice_usage(day);
`;

/**
 * Локальная телеметрия голоса (спека 2026-11-04 «Голос↔Ассистент», §11, T6): одна строка на сессию (`request_id = ''`) и
 * по строке на Request. Только числа, перечисления и id: ни аудио, ни транскрипта, ни текста итога. Строки сливаются по
 * ключу «сессия + Request» (новый факт дописывается, прежний не затирается). Таблица ограничена хостом (последние строки).
 */
const SCHEMA_VOICE_TELEMETRY = `
  CREATE TABLE IF NOT EXISTS voice_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    first_audio_ms INTEGER,
    ack_audible TEXT CHECK(ack_audible IN ('true','false','unknown')),
    delegation_to_submit_ms INTEGER,
    transcript_wait_ms INTEGER,
    link_request_ms INTEGER,
    job_duration_ms INTEGER,
    result_hold_ms INTEGER,
    speech_state TEXT CHECK(speech_state IN ('queued','submitted','played','unknown','dropped')),
    interrupts INTEGER,
    superseded_count INTEGER,
    voice_seconds INTEGER,
    voice_cost_estimate_usd REAL,
    UNIQUE(voice_session_id, request_id));
`;

/**
 * Долговечные разговоры помощника (спека 2026-11-03, C1): история ходов острова и Telegram. Канал — атрибут сообщения,
 * а не разговора: оба канала пишут в один. `turn_key` + `role` уникальны в разговоре: повтор записи не плодит строк.
 * Тексты людей живут только здесь.
 */
const SCHEMA_ASSISTANT_CONVERSATIONS = `
  CREATE TABLE IF NOT EXISTS assistant_conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    turn_key TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    channel TEXT NOT NULL CHECK(channel IN ('island','telegram','reminder','voice')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, turn_key, role));
`;

/**
 * Request голосовых поручений (спека 2026-11-04 «Голос↔Ассистент», §4, T2): строка на поручение. `origin_key` уникален
 * (из исходных voiceSessionId + delegationId, после восстановления не меняется), `job_id` уникален: на Request ровно один
 * job. `seq` растёт в разговоре, `version` — своя, не ревизия job. `assistant_request_deliveries` — устойчивые отметки
 * доставки итога потребителю: `job_revision` — ревизия финального состояния job, которую он получил.
 */
const SCHEMA_ASSISTANT_REQUESTS = `
  CREATE TABLE IF NOT EXISTS assistant_requests (
    request_id TEXT PRIMARY KEY,
    origin_key TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    context_json TEXT,
    job_id TEXT NOT NULL UNIQUE,
    superseded_by TEXT,
    transcript_partial INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, seq));
  CREATE TABLE IF NOT EXISTS assistant_request_deliveries (
    request_id TEXT NOT NULL REFERENCES assistant_requests(request_id) ON DELETE CASCADE,
    consumer TEXT NOT NULL,
    job_revision INTEGER NOT NULL,
    delivered_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, consumer));
`;

/** Шаг миграции: `up` выполняется внутри транзакции раннера, `user_version` ставит раннер. */
export interface MigrationStep {
  version: number;
  up(db: DatabaseSync): void;
}

/**
 * Реестр миграций: упорядоченный по возрастанию `version` список. Шаги 1–3 — записанная история схемы, не правится;
 * новая схема — новый шаг в конец с номером на единицу больше (номера не резервируются, версию схемы задаёт последний шаг).
 * Каждая закоммиченная промежуточная версия должна быть годной точкой старта для следующих шагов: шаг 2, например,
 * опирается на то, что его путь для базы версии 1 переносит и пустую базу.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  // 1: основа (`works`, `entries`).
  { version: 1, up: (db) => db.exec(SCHEMA_BASE) },
  // 2: письма в своих таблицах; базу версии 1 (письма в `entries`) здесь же переносят и сверяют (спека хранилища 6.6).
  // Перенос читает работы вместе с `incarnation`, поэтому базе версии 1 номера создания выдаются до него.
  {
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_LETTERS);
      upgradeIncarnationsOnce(db);
      upgradeLettersSchema(db);
    },
  },
  // 3: durable-номера создания работ (базам версии 2; пройденным через шаг 2 уже выданы).
  { version: 3, up: upgradeIncarnationsOnce },
  // 4: durable jobs и карточки Assistant Core (спека 2026-11-03, задача C2).
  { version: 4, up: (db) => db.exec(SCHEMA_ASSISTANT_CORE) },
  // 5: канонические уведомления и durable outbox (спека 2026-11-03, задача T1).
  { version: 5, up: (db) => db.exec(SCHEMA_NOTIFICATIONS) },
  // 6: флаг «экран показал финал job» переживает рестарт (спека 2026-11-03, C2); колонку `outcome` он не занимает.
  {
    version: 6,
    up: (db) => {
      // Шаг повторяем на базе с опущенной версией: колонка, что уже есть, не добавляется второй раз.
      const has = db.prepare('PRAGMA table_info(assistant_jobs)').all().some((column) => column['name'] === 'delivered_inline');
      if (!has) db.exec('ALTER TABLE assistant_jobs ADD COLUMN delivered_inline INTEGER NOT NULL DEFAULT 0');
    },
  },
  // 7: учёт голосовых сессий GPT-Live (спека 2026-11-03, B2).
  { version: 7, up: (db) => db.exec(SCHEMA_VOICE_USAGE) },
  // 8: долговечные разговоры помощника (спека 2026-11-03, C1).
  { version: 8, up: (db) => db.exec(SCHEMA_ASSISTANT_CONVERSATIONS) },
  // 9: Request голосовых поручений и отметки доставки (спека 2026-11-04, T2).
  { version: 9, up: (db) => db.exec(SCHEMA_ASSISTANT_REQUESTS) },
  // 10: итог job (`JobResult`: ответ, карточки и вызовы инструментов, что записал хост; план голоса, T1).
  {
    version: 10,
    up: (db) => {
      const has = db.prepare('PRAGMA table_info(assistant_jobs)').all().some((column) => column['name'] === 'result_json');
      if (!has) db.exec('ALTER TABLE assistant_jobs ADD COLUMN result_json TEXT');
    },
  },
  // 11: итог `link_request` голосового Request: независимый или вытесняющий; пока `link_kind` пуст, связь не определена (T5).
  {
    version: 11,
    up: (db) => {
      const have = new Set(db.prepare('PRAGMA table_info(assistant_requests)').all().map((column) => column['name']));
      if (!have.has('link_kind')) db.exec('ALTER TABLE assistant_requests ADD COLUMN link_kind TEXT');
      if (!have.has('link_supersedes_json')) db.exec('ALTER TABLE assistant_requests ADD COLUMN link_supersedes_json TEXT');
      if (!have.has('link_reason')) db.exec('ALTER TABLE assistant_requests ADD COLUMN link_reason TEXT');
      if (!have.has('linked_at')) db.exec('ALTER TABLE assistant_requests ADD COLUMN linked_at INTEGER');
    },
  },
  // 12: локальная телеметрия голоса (спека 2026-11-04, §11, T6).
  { version: 12, up: (db) => db.exec(SCHEMA_VOICE_TELEMETRY) },
];

export const WORK_DB_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Прогоняет шаги, которых в базе ещё нет, каждый в своей `BEGIN IMMEDIATE` транзакции вместе с подъёмом `user_version`:
 * упал шаг — откатились и его таблицы, и версия, база остаётся на предыдущем шаге. Версия читается под замком записи,
 * поэтому второй процесс, дождавшийся замка, видит уже поднятую версию и шаг пропускает.
 */
export function runMigrations(db: DatabaseSync, steps: readonly MigrationStep[] = MIGRATIONS): void {
  // Быстрый путь: база уже на последнем шаге — замок записи не берём. Под замком версия всё равно перечитывается.
  const last = steps[steps.length - 1];
  if (!last || userVersion(db) >= last.version) return;
  for (const step of steps) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (userVersion(db) < step.version) {
        step.up(db);
        db.exec(`PRAGMA user_version = ${step.version}`);
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
}

/** Номера создания выдаются один раз: у базы, где колонка уже есть (прошла шаг 2 с версии 1 или нового дома), шаг пропускается. */
function upgradeIncarnationsOnce(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(works)').all();
  if (!columns.some((column) => column['name'] === 'incarnation')) upgradeIncarnations(db);
}

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

/** База в памяти со всей схемой: для тестов и для сервисов, которым хранилище ещё не передали. */
export function openMemoryDb(): DatabaseSync {
  const db = new Database(':memory:');
  runMigrations(db);
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
 * в замок другого процесса (CLI агента открывает ту же базу). Схему ведёт реестр `MIGRATIONS`.
 */
function prepare(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations(db);
  // Индекс отправителя чинится и у баз, где он пропал: `IF NOT EXISTS` у целой базы ничего не делает.
  // База новее кода (user_version выше известной) остаётся нетронутой: схему там ведёт более новый код.
  if (userVersion(db) <= WORK_DB_SCHEMA_VERSION) db.exec(MESSAGES_SENDER_INDEX);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}
