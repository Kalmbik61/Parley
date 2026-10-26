/** Рабочая база SQLite (спека хранилища 6.1): только временные дома, настоящий `~/.parley` не трогаем. */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORK_DB_FILE, WORK_DB_SCHEMA_VERSION, closeWorkDb, workDb } from './db.js';

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

  it('создаёт parley.db в PARLEY_HOME с WAL и user_version = 2', () => {
    expect(WORK_DB_FILE).toBe('parley.db');
    expect(WORK_DB_SCHEMA_VERSION).toBe(2);
    expect(existsSync(home)).toBe(false);

    workDb();

    expect(existsSync(path.join(home, 'parley.db'))).toBe(true);
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('user_version')).toBe(2);
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

  it('создаёт таблицы писем messages, message_reads, message_unread и индексы messages_id, messages_channel, messages_at, message_unread_seq', () => {
    const names = workDb()
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toEqual(
      expect.arrayContaining(['messages', 'message_reads', 'message_unread', 'messages_id', 'messages_channel', 'messages_at', 'message_unread_seq']),
    );
  });

  it('база версии 1 (письма в entries) без апгрейда не открывается: понятная ошибка, данные на месте', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(home, { recursive: true });
    const file = path.join(home, WORK_DB_FILE);
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE works (id TEXT); PRAGMA user_version = 1');
    old.close();

    expect(() => workDb()).toThrow('parley.db has schema 1; it needs the letters upgrade');

    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE name = 'messages'`).all()).toEqual([]);
    check.close();
  });

  it('отдаёт один и тот же дескриптор, пока PARLEY_HOME не меняется', () => {
    expect(workDb()).toBe(workDb());
  });

  it('при повторном открытии не пересоздаёт схему и сохраняет данные', () => {
    insertWork('w-0001');
    insertEntry('w-0001', 'a');
    closeWorkDb();

    expect(pragma('user_version')).toBe(2);
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
