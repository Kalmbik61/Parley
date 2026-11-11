/** Рабочая база SQLite (спека хранилища 6.1): только временные дома, настоящий `~/.parley` не трогаем. */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  BUSY_TIMEOUT_MS,
  MIGRATIONS,
  WORK_DB_FILE,
  WORK_DB_SCHEMA_VERSION,
  closeWorkDb,
  runMigrations,
  workDb,
} from './db.js';

let root = '';
let home = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-db-'));
  home = path.join(root, 'home');
  vi.stubEnv('PARLEY_HOME', home);
});

afterEach(async () => {
  closeWorkDb();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const pragma = (name: string): unknown => {
  const row = workDb().prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
};

const insertWork = (id: string, projectPath = '/p'): void => {
  workDb()
    .prepare(
      `INSERT INTO works (project_path, id, title, status, updated_at, work_json, extra_json)
       VALUES (?, ?, 'Work', 'active', '2026-10-24T00:00:00.000Z', '{}', '{}')`,
    )
    .run(projectPath, id);
};

const insertEntry = (workId: string, key: string, projectPath = '/p'): void => {
  workDb()
    .prepare(
      `INSERT INTO entries (project_path, work_id, kind, key, ord, json) VALUES (?, ?, 'task', ?, 0, '{}')`,
    )
    .run(projectPath, workId, key);
};

const countEntries = (): number =>
  Number((workDb().prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n);

describe('workDb', () => {
  it('новый parley.db (и его -wal/-shm) — с правами 0600: в нём переписка всех проектов', () => {
    insertWork('w-0001');

    const file = path.join(home, WORK_DB_FILE);
    const modes = [file, `${file}-wal`, `${file}-shm`]
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => [path.basename(candidate), statSync(candidate).mode & 0o777]);
    expect(modes[0]).toEqual([WORK_DB_FILE, 0o600]);
    expect(modes.every(([, mode]) => mode === 0o600)).toBe(true);
  });

  it('создаёт parley.db в PARLEY_HOME с WAL и user_version = 15', () => {
    expect(WORK_DB_FILE).toBe('parley.db');
    expect(WORK_DB_SCHEMA_VERSION).toBe(15);
    expect(existsSync(home)).toBe(false);

    workDb();

    expect(existsSync(path.join(home, 'parley.db'))).toBe(true);
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('user_version')).toBe(15);
  });

  it('шаг 4 создаёт таблицы Assistant Core: idempotency_key уникален, состояния ограничены', () => {
    const db = workDb();
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'assistant_%' AND type = 'table' ORDER BY name`).all().map((row) => row['name']);
    expect(names).toEqual(['assistant_cards', 'assistant_conversations', 'assistant_jobs', 'assistant_messages', 'assistant_request_deliveries', 'assistant_requests']);
    const insert = db.prepare(
      `INSERT INTO assistant_jobs (job_id, idempotency_key, origin, correlation_json, state, revision, request_text, provider, created_at, updated_at) VALUES (?, ?, 'island', '{}', ?, 1, 't', 'claude', 1, 1)`,
    );
    insert.run('j1', 'k', 'queued');
    expect(() => insert.run('j2', 'k', 'queued')).toThrow(/UNIQUE/);
    expect(() => insert.run('j3', 'k2', 'bogus')).toThrow(/CHECK/);
  });

  it('шаг 7 создаёт voice_usage: одна строка на сессию, состояния ограничены', () => {
    const db = workDb();
    const insert = db.prepare(`INSERT INTO voice_usage (voice_session_id, day, state) VALUES (?, '2026-11-04', ?)`);
    insert.run('live_1', 'open');
    expect(() => insert.run('live_1', 'open')).toThrow(/UNIQUE/);
    expect(() => insert.run('live_2', 'bogus')).toThrow(/CHECK/);
    expect(db.prepare('SELECT seconds_estimate, seconds_final FROM voice_usage').get()).toEqual({ seconds_estimate: 0, seconds_final: null });
  });

  it('ставит synchronous=NORMAL, busy_timeout=5000 и включает внешние ключи', () => {
    expect(pragma('synchronous')).toBe(1);
    expect(pragma('busy_timeout')).toBe(5000);
    expect(pragma('foreign_keys')).toBe(1);
  });

  it('создаёт таблицы works и entries и индекс entries_order', () => {
    const names = workDb()
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toEqual(expect.arrayContaining(['works', 'entries', 'entries_order']));
  });

  it('создаёт таблицы писем messages, message_reads, message_unread и индексы messages_id, messages_channel, messages_at, messages_sender, message_unread_seq', () => {
    const names = workDb()
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toEqual(
      expect.arrayContaining([
        'messages',
        'message_reads',
        'message_unread',
        'messages_id',
        'messages_channel',
        'messages_at',
        'messages_sender',
        'message_unread_seq',
      ]),
    );
  });

  const indexColumns = (name: string): string[] =>
    (workDb().prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map((row) => row.name);

  it('индекс messages_sender — (project_path, work_id, room_id, sender, seq): письма отправителя комнаты по номеру', () => {
    expect(indexColumns('messages_sender')).toEqual(['project_path', 'work_id', 'room_id', 'sender', 'seq']);
  });

  it('существующая база без индекса messages_sender получает его при открытии: схема 3, письма и работа целы', () => {
    insertWork('w-0001');
    workDb()
      .prepare(
        `INSERT INTO messages (project_path, work_id, seq, id, room_id, sender, recipients, at, kind, body)
         VALUES ('/p', 'w-0001', 1, 'm-01', 'r-01', 'human', '[]', '2026-10-24T00:00:00.000Z', 'note', '{"text":"hi"}')`,
      )
      .run();
    workDb().exec('DROP INDEX messages_sender');
    closeWorkDb();

    expect(indexColumns('messages_sender')).toEqual(['project_path', 'work_id', 'room_id', 'sender', 'seq']);
    expect(pragma('user_version')).toBe(15);
    expect(workDb().prepare('SELECT id, sender FROM messages').all()).toEqual([{ id: 'm-01', sender: 'human' }]);
    expect(workDb().prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
  });

  /** База схемы 1 (сборка плана 3) с одной работой и одним письмом в `entries`; `letter` — текст JSON строки письма. */
  const writeV1 = (letter: string): string => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(home, { recursive: true });
    const file = path.join(home, WORK_DB_FILE);
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE works (
        project_path TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, work_json TEXT NOT NULL, extra_json TEXT NOT NULL, PRIMARY KEY (project_path, id));
      CREATE TABLE entries (
        project_path TEXT NOT NULL, work_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY (project_path, work_id, kind, key),
        FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
      CREATE INDEX entries_order ON entries(project_path, work_id, kind, ord);`);
    const work = { id: 'w-0001', title: 'Work', goal: '', status: 'active', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' };
    old
      .prepare(`INSERT INTO works (project_path, id, title, status, updated_at, version, work_json, extra_json) VALUES ('/p', 'w-0001', 'Work', 'active', ?, 3, ?, ?)`)
      .run(work.updatedAt, JSON.stringify(work), JSON.stringify({ schemaVersion: 2, present: [], foreign: {} }));
    old.prepare(`INSERT INTO entries (project_path, work_id, kind, key, ord, json) VALUES ('/p', 'w-0001', 'message', 'm-01', 0, ?)`).run(letter);
    old.exec('PRAGMA user_version = 1');
    old.close();
    return file;
  };
  const goodLetter = JSON.stringify({ id: 'm-01', roomId: null, from: 's-01', to: ['s-02'], at: '2026-10-24T00:00:00.000Z', text: 'hi', kind: 'note', readBy: {} });

  it('база версии 1 (письма в entries) поднимается до 2 при открытии: письмо в таблице с кандидатом, строки message ушли, версия работы прежняя', () => {
    writeV1(goodLetter);

    expect(pragma('user_version')).toBe(15);

    const db = workDb();
    expect(db.prepare('SELECT seq, id, sender, recipients, body FROM messages').all()).toEqual([
      { seq: 1, id: 'm-01', sender: 's-01', recipients: '["s-02"]', body: '{"text":"hi"}' },
    ]);
    expect(db.prepare('SELECT reader, seq FROM message_unread').all()).toEqual([{ reader: 's-02', seq: 1 }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE kind = 'message'`).get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT version FROM works').get()).toEqual({ version: 3 });
  });

  it('апгрейд, который не сошёлся, откатывается: база остаётся схемы 1 без письменных таблиц, ошибка называет работу; открытие повторяется', () => {
    const file = writeV1('{ не json');

    expect(() => workDb()).toThrow(
      /parley\.db could not be upgraded from schema 1 to schema 2: workspace w-0001 \(\/p\): .*The database is unchanged and stays at schema 1/s,
    );
    expect(() => workDb()).toThrow('could not be upgraded from schema 1 to schema 2');

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'message%'`).all()).toEqual([]);
    expect(check.prepare(`SELECT json FROM entries WHERE kind = 'message'`).all()).toEqual([{ json: '{ не json' }]);
    check.prepare(`UPDATE entries SET json = ?`).run(goodLetter);
    check.close();

    expect(pragma('user_version')).toBe(15);
  });

  it('отдаёт один и тот же дескриптор, пока PARLEY_HOME не меняется', () => {
    expect(workDb()).toBe(workDb());
  });

  it('при повторном открытии не пересоздаёт схему и сохраняет данные', () => {
    insertWork('w-0001');
    insertEntry('w-0001', 'a');
    closeWorkDb();

    expect(pragma('user_version')).toBe(15);
    const works = workDb().prepare('SELECT id FROM works').all();
    expect(works).toEqual([{ id: 'w-0001' }]);
    expect(countEntries()).toBe(1);
  });

  it('closeWorkDb можно вызывать без открытой базы и несколько раз', () => {
    closeWorkDb();
    workDb();
    closeWorkDb();
    expect(() => closeWorkDb()).not.toThrow();
  });

  it('смена PARLEY_HOME открывает другую базу', () => {
    insertWork('w-0001');
    const first = workDb();

    const otherHome = path.join(root, 'other');
    vi.stubEnv('PARLEY_HOME', otherHome);
    const second = workDb();

    // Не `not.toBe`: при несовпадении vitest глубоко сравнивает объекты, а прежняя база уже закрыта.
    expect(Object.is(second, first)).toBe(false);
    expect(existsSync(path.join(otherHome, 'parley.db'))).toBe(true);
    expect(second.prepare('SELECT COUNT(*) AS n FROM works').get()).toEqual({ n: 0 });

    vi.stubEnv('PARLEY_HOME', home);
    expect(workDb().prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
  });

  it('удаление строки works каскадно удаляет её entries', () => {
    insertWork('w-0001');
    insertWork('w-0002');
    insertEntry('w-0001', 'a');
    insertEntry('w-0001', 'b');
    insertEntry('w-0002', 'a');

    workDb().prepare(`DELETE FROM works WHERE project_path = '/p' AND id = 'w-0001'`).run();

    expect(countEntries()).toBe(1);
    expect(workDb().prepare('SELECT work_id FROM entries').all()).toEqual([{ work_id: 'w-0002' }]);
  });

  it('не принимает запись без работы: внешний ключ включён', () => {
    expect(() => insertEntry('w-9999', 'a')).toThrow(/FOREIGN KEY/);
  });

  it('письма: удаление работы и письма каскадно уносит отметки и кандидатов; чужое письмо не трогает', () => {
    const db = workDb();
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    insertWork('w-0001');
    insertWork('w-0002');
    for (const [work, seq] of [['w-0001', 1], ['w-0001', 2], ['w-0002', 1]] as const) {
      db.prepare(
        `INSERT INTO messages (project_path, work_id, seq, id, room_id, sender, recipients, at, kind, body)
         VALUES ('/p', ?, ?, ?, NULL, 's-01', '[]', '2026-10-24T00:00:00.000Z', 'note', '{"text":"x"}')`,
      ).run(work, seq, `m-0${seq}`);
      db.prepare(`INSERT INTO message_reads (project_path, work_id, seq, reader, at) VALUES ('/p', ?, ?, 's-02', 't')`).run(work, seq);
      db.prepare(`INSERT INTO message_unread (project_path, work_id, reader, seq, room_id) VALUES ('/p', ?, 's-03', ?, NULL)`).run(work, seq);
    }

    db.prepare(`DELETE FROM messages WHERE work_id = 'w-0001' AND seq = 1`).run();
    expect([count('messages'), count('message_reads'), count('message_unread')]).toEqual([2, 2, 2]);

    db.prepare(`DELETE FROM works WHERE project_path = '/p' AND id = 'w-0001'`).run();
    expect([count('messages'), count('message_reads'), count('message_unread')]).toEqual([1, 1, 1]);
    expect(db.prepare('SELECT work_id FROM messages').all()).toEqual([{ work_id: 'w-0002' }]);
  });

  it('номер письма и id уникальны в работе: повтор отвергается', () => {
    const db = workDb();
    insertWork('w-0001');
    const insert = (seq: number, id: string): unknown =>
      db
        .prepare(
          `INSERT INTO messages (project_path, work_id, seq, id, room_id, sender, recipients, at, kind, body)
           VALUES ('/p', 'w-0001', ?, ?, NULL, 's-01', '[]', 't', 'note', '{}')`,
        )
        .run(seq, id);
    insert(1, 'm-01');

    expect(() => insert(1, 'm-02')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(2, 'm-01')).toThrow(/UNIQUE/);
  });
});


describe('durable work incarnations', () => {
  const incarnation = (id: string) => Number(workDb().prepare('SELECT incarnation FROM works WHERE id = ?').get(id)?.['incarnation']);
  it('allocates on all inserts independently of caller fields and RETURNING, survives deletion/reopen/two connections', () => {
    insertWork('w-0001'); const first = incarnation('w-0001');
    expect(Number.isSafeInteger(first)).toBe(true); expect(first).toBeGreaterThan(0);
    workDb().prepare('UPDATE works SET version = version + 1 WHERE id = ?').run('w-0001');
    expect(incarnation('w-0001')).toBe(first);
    workDb().exec('DELETE FROM works'); closeWorkDb();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const foreign = new DatabaseSync(path.join(home, WORK_DB_FILE));
    try {
      foreign.prepare("INSERT INTO works(project_path,id,title,status,updated_at,work_json,extra_json,incarnation) VALUES('/p','w-0001','B','active','x','{}','{}',999999)").run();
    } finally { foreign.close(); }
    expect(incarnation('w-0001')).toBe(first + 1);
    const returned = workDb().prepare("INSERT INTO works(project_path,id,title,status,updated_at,work_json,extra_json) VALUES('/p','w-0002','C','active','x','{}','{}') RETURNING incarnation").get();
    expect(returned?.['incarnation']).toBe(0);
    expect(incarnation('w-0002')).toBe(first + 2);
  });

  it('backfills schema2 atomically and never reuses an allocation after committed deletion', () => {
    insertWork('w-0001'); insertWork('w-0002');
    workDb().exec('DROP TRIGGER works_assign_incarnation; ALTER TABLE works DROP COLUMN incarnation; DROP TABLE work_incarnation_clock; PRAGMA user_version = 2');
    closeWorkDb();
    expect(incarnation('w-0001')).toBe(1); expect(incarnation('w-0002')).toBe(2);
    workDb().exec('DELETE FROM works'); insertWork('w-0001'); expect(incarnation('w-0001')).toBe(3);
  });

  it('rolls schema and data back on migration failure, and bounds allocator exhaustion', () => {
    insertWork('w-0001');
    workDb().exec('DROP TRIGGER works_assign_incarnation; ALTER TABLE works DROP COLUMN incarnation; PRAGMA user_version = 2');
    closeWorkDb(); // existing clock intentionally makes migration fail before schema adoption
    expect(() => workDb()).toThrow('already exists');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const check = new DatabaseSync(path.join(home, WORK_DB_FILE));
    try {
      expect(check.prepare('PRAGMA user_version').get()?.['user_version']).toBe(2);
      expect(check.prepare('PRAGMA table_info(works)').all().some(row => row['name'] === 'incarnation')).toBe(false);
      expect(check.prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
      check.exec('DROP TABLE work_incarnation_clock');
    } finally { check.close(); }
    expect(incarnation('w-0001')).toBe(1);
    workDb().exec('UPDATE work_incarnation_clock SET value = 9007199254740991');
    expect(() => insertWork('w-0002')).toThrow('exhausted');
    expect(workDb().prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
    expect(workDb().prepare('SELECT value FROM work_incarnation_clock').get()?.['value']).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('реестр миграций', () => {
  type Db = import('node:sqlite').DatabaseSync;
  const open = (file: string): Db => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    return new DatabaseSync(file);
  };
  const version = (db: Db): number => Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  const tables = (db: Db): string[] =>
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => String(row['name']));

  it('шаги идут по возрастанию без пропусков, версия схемы — номер последнего шага', () => {
    expect(MIGRATIONS.map((step) => step.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
    expect(WORK_DB_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  it('свежая база проходит все шаги до текущей версии', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'replay.db'));
    try {
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(tables(db)).toEqual(
        expect.arrayContaining(['works', 'entries', 'messages', 'message_reads', 'message_unread', 'work_incarnation_clock']),
      );
    } finally {
      db.close();
    }
  });

  it('база текущей версии: повторный запуск ничего не меняет, данные целы', () => {
    insertWork('w-0001');
    const schema = (): unknown => workDb().prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all();
    const before = schema();
    closeWorkDb();

    expect(pragma('user_version')).toBe(WORK_DB_SCHEMA_VERSION);
    runMigrations(workDb());
    expect(schema()).toEqual(before);
    expect(workDb().prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
  });

  it('база версии 4 поднимается до последней: уведомления, outbox и колонка delivered_inline', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'v4.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 4));
      expect(version(db)).toBe(4);
      expect(tables(db)).not.toContain('notifications');
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(tables(db)).toEqual(expect.arrayContaining(['notifications', 'notification_outbox']));
      const columns = db.prepare('PRAGMA table_info(assistant_jobs)').all().map((row) => String(row['name']));
      expect(columns).toContain('delivered_inline');
      expect(columns).toContain('result_json');
    } finally {
      db.close();
    }
  });

  it('база версии 7 поднимается до последней: появляются разговоры, повтор хода не плодит строк', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'v7.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 7));
      expect(version(db)).toBe(7);
      expect(tables(db)).not.toContain('assistant_messages');
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(tables(db)).toEqual(expect.arrayContaining(['assistant_conversations', 'assistant_messages']));
      db.prepare(`INSERT INTO assistant_conversations (id, created_at, updated_at) VALUES ('c1', 1, 1)`).run();
      const insert = db.prepare(`INSERT INTO assistant_messages (conversation_id, turn_key, role, channel, text, created_at) VALUES ('c1', 't1', ?, 'island', 'x', 1)`);
      insert.run('user');
      expect(() => insert.run('user')).toThrow(/UNIQUE/);
      expect(() => insert.run('bogus')).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('база версии 6 поднимается до последней: появляется voice_usage', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'v6.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 6));
      expect(version(db)).toBe(6);
      expect(tables(db)).not.toContain('voice_usage');
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(tables(db)).toContain('voice_usage');
    } finally {
      db.close();
    }
  });

  it('шаг 12 создаёт voice_telemetry: строка сессии и Request уникальны по ключу, перечисления ограничены, текстовых полей нет', () => {
    const db = workDb();
    const insert = db.prepare(`INSERT INTO voice_telemetry (voice_session_id, request_id, at, ack_audible, speech_state) VALUES (?, ?, 1, ?, ?)`);
    insert.run('vs-1', '', null, null);
    insert.run('vs-1', 'req-1', 'unknown', 'played');
    expect(() => insert.run('vs-1', 'req-1', null, null)).toThrow(/UNIQUE/);
    expect(() => insert.run('vs-1', 'req-2', 'maybe', null)).toThrow(/CHECK/);
    expect(() => insert.run('vs-1', 'req-3', null, 'bogus')).toThrow(/CHECK/);
    const text = (db.prepare('PRAGMA table_info(voice_telemetry)').all() as Array<{ name: string; type: string }>).filter((column) => column.type === 'TEXT').map((column) => column.name);
    expect(text).toEqual(['voice_session_id', 'request_id', 'ack_audible', 'speech_state']);
  });

  it('шаг 13 добавляет числовые колонки Decisions в voice_telemetry; повтор на базе с колонками не падает; текстовых полей не прибавилось', () => {
    const db = workDb();
    const columns = (db.prepare('PRAGMA table_info(voice_telemetry)').all() as Array<{ name: string; type: string }>);
    const added = columns.filter((column) => column.name.startsWith('decisions_'));
    expect(added.map((column) => [column.name, column.type])).toEqual([
      ['decisions_received', 'INTEGER'],
      ['decisions_rejected', 'INTEGER'],
      ['decisions_input_tokens', 'INTEGER'],
      ['decisions_fallback', 'INTEGER'],
    ]);
    expect(columns.filter((column) => column.type === 'TEXT').map((column) => column.name)).toEqual(['voice_session_id', 'request_id', 'ack_audible', 'speech_state']);
    const step = MIGRATIONS[12]!;
    expect(step.version).toBe(13);
    expect(() => step.up(db)).not.toThrow();
  });

  it('шаг 14 добавляет nullable context_json в assistant_jobs; повтор на базе с колонкой не падает', () => {
    const db = workDb();
    const column = (db.prepare('PRAGMA table_info(assistant_jobs)').all() as Array<{ name: string; type: string; notnull: number }>).find((row) => row.name === 'context_json');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
    const step = MIGRATIONS.find((m) => m.version === 14)!;
    expect(step.version).toBe(14);
    expect(() => step.up(db)).not.toThrow();
  });

  it('шаг 15 (Code Mode, план T12a) заводит одну строку выключения: только singleton 1 и только off = 1; повтор не падает', () => {
    const db = workDb();
    const step = MIGRATIONS[MIGRATIONS.length - 1]!;
    expect(step.version).toBe(15);
    expect(() => step.up(db)).not.toThrow();
    db.prepare('INSERT INTO code_mode_preference (singleton, off, at) VALUES (1, 1, ?)').run('t');
    expect(() => db.prepare('INSERT INTO code_mode_preference (singleton, off, at) VALUES (2, 1, ?)').run('t')).toThrow();
    expect(() => db.prepare('UPDATE code_mode_preference SET off = 0 WHERE singleton = 1').run()).toThrow();
  });

  it('база версии 12 поднимается до 13 с сохранением строк voice_telemetry', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'v12.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 12));
      db.prepare("INSERT INTO voice_telemetry (voice_session_id, request_id, at, interrupts) VALUES ('vs-1', '', 5, 2)").run();
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(db.prepare("SELECT interrupts, decisions_received, decisions_fallback FROM voice_telemetry WHERE voice_session_id = 'vs-1'").get()).toEqual({ interrupts: 2, decisions_received: null, decisions_fallback: null });
    } finally {
      db.close();
    }
  });

  it('база версии 11 поднимается до последней: появляется voice_telemetry', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'v11.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 11));
      expect(tables(db)).not.toContain('voice_telemetry');
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
      expect(tables(db)).toContain('voice_telemetry');
    } finally {
      db.close();
    }
  });

  it('сбой внутри шага не меняет user_version и не оставляет частичного состояния', () => {
    mkdirSync(home, { recursive: true });
    const db = open(path.join(home, 'failing.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 2));
      const before = tables(db);
      const failing = {
        version: 3,
        up: (handle: Db): void => {
          handle.exec('CREATE TABLE half_done (id INTEGER)');
          throw new Error('boom');
        },
      };

      expect(() => runMigrations(db, [...MIGRATIONS.slice(0, 2), failing])).toThrow('boom');

      expect(version(db)).toBe(2);
      expect(tables(db)).toEqual(before);
      // Транзакция закрыта: следующий шаг проходит с этой же базой.
      runMigrations(db);
      expect(version(db)).toBe(WORK_DB_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('база новее кода: открытие не пишет в схему (ни индекс, ни версию)', () => {
    insertWork('w-0001');
    workDb().exec('DROP INDEX messages_sender');
    closeWorkDb();
    const raw = open(path.join(home, WORK_DB_FILE));
    raw.exec(`PRAGMA user_version = ${WORK_DB_SCHEMA_VERSION + 5}`);
    raw.close();

    const db = workDb();
    expect(pragma('user_version')).toBe(WORK_DB_SCHEMA_VERSION + 5);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'messages_sender'`).all()).toEqual([]);
    expect(db.prepare('SELECT id FROM works').all()).toEqual([{ id: 'w-0001' }]);
  });

  it('второй handle при записи ждёт замок в пределах BUSY_TIMEOUT_MS и не портит данные', async () => {
    insertWork('w-0001');
    closeWorkDb();
    const file = path.join(home, WORK_DB_FILE);
    // Версия на шаг ниже текущей: у базы текущей версии быстрый путь замок записи не берёт и ждать было бы нечего.
    const old = open(file);
    old.exec(`PRAGMA user_version = ${WORK_DB_SCHEMA_VERSION - 1}`);
    old.close();
    const holdMs = 600;
    // Замок держит отдельный процесс: node:sqlite синхронный, в одном потоке ожидание не отпустило бы замок.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
         db.exec('BEGIN IMMEDIATE');db.exec("UPDATE works SET title='Held'");
         process.stdout.write('ready\\n');
         setTimeout(()=>{db.exec('COMMIT');db.close();},${holdMs});`,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`holder exited early: ${code}`)));
        child.stdout.once('data', () => resolve());
      });
      const started = Date.now();
      const db = workDb(); // BEGIN IMMEDIATE в шаге упирается в BUSY и ждёт до busy_timeout
      const waited = Date.now() - started;

      expect(waited).toBeGreaterThanOrEqual(holdMs / 6);
      expect(waited).toBeLessThan(BUSY_TIMEOUT_MS);
      expect(pragma('user_version')).toBe(WORK_DB_SCHEMA_VERSION);
      expect(db.prepare('SELECT id, title FROM works').all()).toEqual([{ id: 'w-0001', title: 'Held' }]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      child.kill();
    }
  });
});
