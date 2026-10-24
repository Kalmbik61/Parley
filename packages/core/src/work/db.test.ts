/** Рабочая база SQLite (спека хранилища 6.1): только временные дома, настоящий `~/.parley` не трогаем. */

import { existsSync, statSync } from 'node:fs';
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

  it('создаёт parley.db в PARLEY_HOME с WAL и user_version = 1', () => {
    expect(WORK_DB_FILE).toBe('parley.db');
    expect(WORK_DB_SCHEMA_VERSION).toBe(1);
    expect(existsSync(home)).toBe(false);

    workDb();

    expect(existsSync(path.join(home, 'parley.db'))).toBe(true);
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('user_version')).toBe(1);
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

  it('отдаёт один и тот же дескриптор, пока PARLEY_HOME не меняется', () => {
    expect(workDb()).toBe(workDb());
  });

  it('при повторном открытии не пересоздаёт схему и сохраняет данные', () => {
    insertWork('w-0001');
    insertEntry('w-0001', 'a');
    closeWorkDb();

    expect(pragma('user_version')).toBe(1);
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
});
