import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFile } from '../context-fill.js';
import { closeWorkDb, WORK_DB_FILE, workDb } from './db.js';
import { addMessage, addSession } from './map.js';
import type { Room, WorkMap } from './types.js';
import {
  createWork,
  deleteSessionFiles,
  deleteWorkFiles,
  insertMigratedMap,
  MAP_CACHE_LIMIT,
  MAP_SNAPSHOT_LIMIT,
  mapCacheStats,
  MapLockTimeoutError,
  onMapWritten,
  pruneWorksIndex,
  readMap,
  readStoredMap,
  readWorksIndex,
  renameWork,
  replaceStoredMap,
  setWorkStatus,
  updateMap,
  parleyHome,
  WorkNotFoundError,
  workExists,
  workPaths,
  worksIndexPath,
  inspectSharedIgnore,
  prepareSharedIgnore,
  readSharedFile,
  sharedProjectPaths,
  withSharedProjectLock,
  writeSharedFile,
} from './store.js';

describe('shared storage primitives', () => {
  it('compares content and modification identity, and removes unique temporary files on conflict', async () => {
    const file = path.join(project, 'shared.md'); await writeFile(file, 'Before');
    const before = await readSharedFile(file); await writeFile(file, 'Extern');
    await expect(writeSharedFile(file, 'Stale', before)).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toBe('Extern');
    expect((await readdir(project)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('bounds regular-file reads and refuses invalid UTF-8/directories without rewriting them', async () => {
    const file = path.join(project, 'invalid'); await writeFile(file, Buffer.from([0xff]));
    await expect(readSharedFile(file)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    await expect(readSharedFile(project)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await expect(readSharedFile(file)).rejects.toMatchObject({ code: 'shared-file-too-large' });
  });
  it('reads past the default bound only when the caller raises it', async () => {
    const file = path.join(project, 'big.json');
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024));
    await expect(readSharedFile(file)).rejects.toMatchObject({ code: 'shared-file-too-large' });
    const snapshot = await readSharedFile(file, MAP_SNAPSHOT_LIMIT);
    expect(snapshot.text).toHaveLength(2 * 1024 * 1024);
    await expect(readSharedFile(file, 1024)).rejects.toMatchObject({ code: 'shared-file-too-large' });
  });
  it('rejects symlink/FIFO readers and symlink state directories without following them', async () => {
    const target = path.join(project, 'target'); await writeFile(target, 'private');
    const alias = path.join(project, 'alias'); await symlink(target, alias);
    await expect(readSharedFile(alias)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    const fifo = path.join(project, 'fifo'); await run('mkfifo', [fifo]);
    await expect(readSharedFile(fifo)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    await symlink(other, path.join(project, '.parley'));
    await expect(sharedProjectPaths(project)).rejects.toMatchObject({ code: 'shared-state-unsafe' });
    expect(await readdir(other)).toEqual([]);
  });
  it('times out on an occupied project lock, never steals it, and releases its own lock after errors', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.dir); await writeFile(paths.lock, 'foreign');
    await expect(withSharedProjectLock(paths, async () => {}, { lockTimeoutMs: 0 })).rejects.toMatchObject({ code: 'backlog-lock-timeout' });
    expect(await readFile(paths.lock, 'utf8')).toBe('foreign'); await rm(paths.lock);
    await expect(withSharedProjectLock(paths, async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
    expect(await exists(paths.lock)).toBe(false);
  });
  it('preserves an observed replacement lock during cleanup', async () => {
    const paths = await sharedProjectPaths(project);
    await withSharedProjectLock(paths, async () => { await rename(paths.lock, paths.lock + '.old'); await writeFile(paths.lock, 'replacement'); });
    expect(await readFile(paths.lock, 'utf8')).toBe('replacement');
  });
});

const run = promisify(execFile);
const require = createRequire(import.meta.url);
/** Пишущий скрипт запускается отдельным процессом через tsx: настоящая параллельность. */
const writerScript = fileURLToPath(new URL('../../test/work-db-writer.ts', import.meta.url));
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');

let home = '';
let project = '';
let other = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  other = await mkdtemp(path.join(tmpdir(), 'parley-other-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  closeWorkDb();
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project, other].map((dir) => rm(dir, { recursive: true, force: true })));
});

const isDirectory = async (dir: string): Promise<boolean> => (await stat(dir)).isDirectory();

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

describe('песочница тестов', () => {
  it('без PARLEY_HOME дом уходит во временный каталог, а не в настоящий ~/.parley', () => {
    // Жёсткое правило задания: настоящие ~/.parley, ~/.harnas и ~/.claude тесты не трогают.
    // Запись из недосчитанного промиса случается и после `afterEach` (см.
    // `test/sandbox-home.ts`), поэтому проверяем сам запасной путь.
    delete process.env.PARLEY_HOME;
    expect(worksIndexPath().startsWith(tmpdir())).toBe(true);
  });
});

describe('parleyHome — выбор дома (R4)', () => {
  const userHome = (): string => home;

  describe('предохранитель: тест не резолвит настоящий дом Parley', () => {
    // `userInfo().homedir` читается из базы пользователей — `HOME` песочницы его не подменяет.
    const realHome = userInfo().homedir;

    it('PARLEY_HOME на настоящий ~/.parley или ~/.harnas — ошибка', () => {
      expect(() => parleyHome({ PARLEY_HOME: path.join(realHome, '.parley') })).toThrow(/sandbox-home/);
      expect(() => parleyHome({ HARNAS_HOME: path.join(realHome, '.harnas') })).toThrow(/sandbox-home/);
    });

    it('путь внутри настоящего дома — ошибка', () => {
      expect(() => parleyHome({ PARLEY_HOME: path.join(realHome, '.parley', 'works') })).toThrow(/sandbox-home/);
    });

    it('запасной путь от настоящего домашнего каталога — ошибка', () => {
      expect(() => parleyHome({}, realHome)).toThrow(/sandbox-home/);
    });

    it('временные каталоги и фейковый userHome работают', () => {
      expect(parleyHome({ PARLEY_HOME: path.join(home, 'x') }, userHome())).toBe(path.join(home, 'x'));
      expect(parleyHome({}, userHome())).toBe(path.join(home, '.parley'));
      expect(parleyHome({ PARLEY_HOME: path.join(realHome, '.parley-sibling') })).toBe(
        path.join(realHome, '.parley-sibling'),
      );
    });
  });

  it('PARLEY_HOME — первый', () => {
    expect(parleyHome({ PARLEY_HOME: '/new', HARNAS_HOME: '/old' }, userHome())).toBe('/new');
  });

  it('нет PARLEY_HOME — HARNAS_HOME', () => {
    expect(parleyHome({ HARNAS_HOME: '/old' }, userHome())).toBe('/old');
  });

  it('пустые переменные — как незаданные', async () => {
    await mkdir(path.join(home, '.harnas'));
    expect(parleyHome({ PARLEY_HOME: '', HARNAS_HOME: '' }, userHome())).toBe(path.join(home, '.harnas'));
    expect(parleyHome({ PARLEY_HOME: '', HARNAS_HOME: '/old' }, userHome())).toBe('/old');
  });

  it('переменных нет, есть ~/.parley — он, даже если есть и ~/.harnas', async () => {
    await mkdir(path.join(home, '.parley'));
    await mkdir(path.join(home, '.harnas'));
    expect(parleyHome({}, userHome())).toBe(path.join(home, '.parley'));
  });

  it('переменных нет, ~/.parley нет, есть ~/.harnas — данные человека со времён harnas', async () => {
    await mkdir(path.join(home, '.harnas'));
    expect(parleyHome({}, userHome())).toBe(path.join(home, '.harnas'));
  });

  it('ничего нет — новый ~/.parley, и ничего не создаётся', async () => {
    expect(parleyHome({}, userHome())).toBe(path.join(home, '.parley'));
    expect(await readdir(home)).toEqual([]);
  });

  it('по умолчанию читает process.env и настоящий homedir()', () => {
    process.env.PARLEY_HOME = '/через/окружение';
    expect(parleyHome()).toBe('/через/окружение');
  });

  it('PARLEY_HOME главнее HARNAS_HOME и в process.env; после снятия PARLEY_HOME работает прежняя', () => {
    const saved = process.env.HARNAS_HOME;
    process.env.HARNAS_HOME = '/прежний';
    try {
      process.env.PARLEY_HOME = '/новый';
      expect(parleyHome()).toBe('/новый');
      delete process.env.PARLEY_HOME;
      expect(parleyHome()).toBe('/прежний');
    } finally {
      if (saved === undefined) delete process.env.HARNAS_HOME;
      else process.env.HARNAS_HOME = saved;
    }
  });

  it('индекс работ и файл настроек идут за выбранным домом', () => {
    delete process.env.PARLEY_HOME;
    const saved = process.env.HARNAS_HOME;
    process.env.HARNAS_HOME = home;
    try {
      expect(worksIndexPath()).toBe(path.join(home, 'works-index.json'));
    } finally {
      if (saved === undefined) delete process.env.HARNAS_HOME;
      else process.env.HARNAS_HOME = saved;
    }
  });
});

/** Версия строки работы в базе: растёт на каждой записи (спека хранилища 6.9, этап 2). */
const versionOf = (workId: string): number =>
  Number(
    (
      workDb()
        .prepare('SELECT version FROM works WHERE project_path = ? AND id = ?')
        .get(project, workId) as {
        version: number;
      }
    ).version,
  );

/** Строки `entries` как карта «вид/ключ → порядок и JSON»: по ней видно, какие строки изменила запись. */
const entryRows = (): Map<string, string> =>
  new Map(
    (
      workDb().prepare('SELECT kind, key, ord, json FROM entries').all() as {
        kind: string;
        key: string;
        ord: number;
        json: string;
      }[]
    ).map((row) => [`${row.kind}/${row.key}`, `${row.ord}:${row.json}`]),
  );

/** Сколько строк в базе записано соединением с момента открытия (`works` и `entries` вместе). */
const totalChanges = (): number =>
  Number((workDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n);

/** Второе соединение с той же базой держит блокировку записи, как чужой процесс (CLI, MCP агента без канала). */
const holdWriteLock = (): { release: () => void } => {
  const foreign = new Database(path.join(home, WORK_DB_FILE));
  foreign.exec('PRAGMA busy_timeout = 0');
  foreign.exec('BEGIN IMMEDIATE');
  return {
    release: () => {
      foreign.exec('ROLLBACK');
      foreign.close();
    },
  };
};

const addPlanSession = (map: WorkMap): void => {
  addSession(map, { provider: 'claude', label: 'план', task: 't' });
};

const connectionBusyTimeout = (): number =>
  Number((workDb().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Комната, которую `normalizeMap` не примет: неизвестный режим. */
const bogusRoom = (): Room =>
  ({
    id: 'r-01',
    title: 'бэкенд',
    creator: 'human',
    ownerId: null,
    members: [],
    createdAt: '2026-10-24T00:00:00.000Z',
    lead: null,
    proposal: null,
    archivedAt: null,
    mode: 'bogus',
  }) as unknown as Room;

describe('createWork', () => {
  it('создаёт каталоги и строку в базе; map.json, .bak и works-index.json не появляются', async () => {
    const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
    const paths = workPaths(project, 'w-0001');

    expect(map.schemaVersion).toBe(2);
    expect(map.work.id).toBe('w-0001');
    expect(map.work.status).toBe('active');
    expect(map.sessions).toEqual([]);
    expect(map.messages).toEqual([]);
    expect(map.rooms).toEqual([]);
    expect(paths.dir).toBe(path.join(project, '.parley', 'works', 'w-0001'));
    expect((await readdir(paths.dir)).sort()).toEqual(['artifacts', 'briefs']);
    expect(await isDirectory(paths.briefs)).toBe(true);
    expect(await isDirectory(paths.artifacts)).toBe(true);
    expect(await exists(path.join(home, 'works-index.json'))).toBe(false);
    // Omitted optional plans are normalized to an empty list by the accepted map reader.
    expect(await readMap(project, 'w-0001')).toEqual({ ...map, plans: [] });
    expect(readStoredMap(project, 'w-0001')).toEqual({ ...map, plans: [] });
    expect((await readWorksIndex()).works).toEqual([
      {
        id: 'w-0001',
        projectPath: project,
        title: 'Авторизация',
        status: 'active',
        updatedAt: map.work.updatedAt,
      },
    ]);
  });

  it('id работ выдаются по всей базе, а не по проекту', async () => {
    await createWork(project, { title: 'Авторизация' });
    const second = await createWork(other, { title: 'Редизайн' });

    expect(second.work.id).toBe('w-0002');
    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual(['w-0001', 'w-0002']);
  });

  it('карта прежнего формата, ещё не переехавшая в базу, не затирается: её id пропускается', async () => {
    await createWork(project, { title: 'Первая' });
    const legacy = workPaths(project, 'w-0002');
    await mkdir(legacy.dir, { recursive: true });
    await writeFile(legacy.map, '{}', 'utf8');

    const second = await createWork(project, { title: 'Вторая' });

    expect(second.work.id).toBe('w-0003');
    expect(await readFile(legacy.map, 'utf8')).toBe('{}');
  });

  it('каталоги не создались — строки в базе нет, список работ пуст', async () => {
    // Вместо каталога `works` лежит файл: `briefs` создать негде.
    await mkdir(path.join(project, '.parley'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'works'), 'файл', 'utf8');

    await expect(createWork(project, { title: 'Первая' })).rejects.toThrow();

    expect((await readWorksIndex()).works).toEqual([]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(workDb().isTransaction).toBe(false);
  });

  it('id занят в базе — прежняя ошибка «already exists», новой строки нет', async () => {
    await createWork(project, { title: 'Первая' });
    // Триггер играет писателя, который занял w-0002 между выбором номера и вставкой: вставка находит строку занятой.
    workDb().exec(`CREATE TRIGGER occupy BEFORE INSERT ON works WHEN NEW.id = 'w-0002' BEGIN
      INSERT INTO works (project_path, id, title, status, updated_at, work_json, extra_json)
      VALUES (NEW.project_path, NEW.id, 'чужая', 'active', '', '{}', '{}');
    END`);

    await expect(createWork(project, { title: 'Вторая' })).rejects.toThrow(
      /w-0002 already exists in .* — the workspace was not created/,
    );

    expect((await readWorksIndex()).works.map((work) => work.title)).toEqual(['Первая']);
    expect(workDb().isTransaction).toBe(false);
  });

  it('версия новой работы — метка времени в мс, а не 0; событие записи несёт её же', async () => {
    const events: number[] = [];
    const stop = onMapWritten((event) => events.push(event.version));
    const before = Date.now();

    await createWork(project, { title: 'Первая' });
    stop();

    expect(versionOf('w-0001')).toBeGreaterThanOrEqual(before);
    expect(versionOf('w-0001')).toBeLessThanOrEqual(Date.now());
    expect(events).toEqual([versionOf('w-0001')]);
  });

  it('работу удалил другой процесс и тот же id создан заново: кэш, прогретый до удаления, не попадает (спека хранилища 6.9)', async () => {
    await createWork(project, { title: 'Первая' });
    await readMap(project, 'w-0001');
    // «Чужое» удаление: этот процесс о нём не знает, запись его кэша осталась.
    workDb().prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, 'w-0001');
    // Версии берутся из часов, поэтому между созданиями должна пройти хотя бы миллисекунда.
    await pause(5);

    await createWork(project, { title: 'Вторая' });
    const before = mapCacheStats();

    expect((await readMap(project, 'w-0001')).work.title).toBe('Вторая');
    expect(mapCacheStats().misses - before.misses).toBe(1);
    expect(mapCacheStats().hits - before.hits).toBe(0);
  });
});

describe('updateMap', () => {
  it('карта v1 в базе после первой мутации ложится как v2 и читается без потерь', async () => {
    await createWork(project, { title: 'Авторизация' });
    const v1 = readStoredMap(project, 'w-0001') as unknown as Record<string, unknown>;
    delete v1['rooms'];
    v1['schemaVersion'] = 1;
    v1['sessions'] = [{ id: 's-01', status: 'exited', history: [{ status: 'exited', at: 'x' }] }];
    v1['messages'] = [{ id: 'm-01', from: 's-02', to: 's-01', at: 'x', text: 't', readAt: null }];
    replaceStoredMap(project, 'w-0001', v1);

    const updated = await updateMap(project, 'w-0001', () => {});

    const extra = JSON.parse(
      (workDb().prepare('SELECT extra_json FROM works').get() as { extra_json: string }).extra_json,
    ) as { schemaVersion: number };
    expect(extra.schemaVersion).toBe(2);
    const session = JSON.parse(
      (
        workDb().prepare("SELECT json FROM entries WHERE kind = 'session'").get() as {
          json: string;
        }
      ).json,
    ) as Record<string, unknown>;
    expect(session).toMatchObject({ lifecycle: 'sleeping', result: null });
    const stored = readStoredMap(project, 'w-0001');
    expect(stored.rooms).toEqual([]);
    expect(stored.messages[0]).toMatchObject({ to: ['s-01'], readBy: {}, roomId: null });
    expect(stored).toEqual(updated);
  });

  it('пишет карту в базу и обновляет список работ', async () => {
    await createWork(project, { title: 'Авторизация' });
    const created = versionOf('w-0001');

    const updated = await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
      map.work.status = 'done';
    });

    expect(updated.sessions[0]?.id).toBe('s-01');
    expect(readStoredMap(project, 'w-0001')).toEqual(updated);
    expect(versionOf('w-0001')).toBe(created + 1);
    expect((await readWorksIndex()).works).toEqual([
      {
        id: 'w-0001',
        projectPath: project,
        title: 'Авторизация',
        status: 'done',
        updatedAt: updated.work.updatedAt,
      },
    ]);
  });

  it('в каталоге работы после записи нет ни map.json, ни .bak, ни временных файлов', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', addPlanSession);

    expect((await readdir(workPaths(project, 'w-0001').dir)).sort()).toEqual([
      'artifacts',
      'briefs',
    ]);
  });

  it('запись письма в работу с 5 000 писем меняет в entries ровно одну строку', async () => {
    await createWork(project, { title: 'Переписка' });
    await updateMap(project, 'w-0001', (map) => {
      for (let n = 1; n <= 5000; n += 1) {
        map.messages.push({
          id: `m-${String(n).padStart(2, '0')}`,
          roomId: null,
          from: 's-01',
          to: ['s-02'],
          text: `письмо ${n}`,
          kind: 'note',
          at: '2026-10-24T00:00:00.000Z',
          readBy: {},
        });
      }
      map.work.messageSeq = 5000;
    });
    const rowsBefore = entryRows();
    expect(rowsBefore.size).toBe(5000);
    const changesBefore = totalChanges();

    await updateMap(project, 'w-0001', (map) => {
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'ещё одно' });
    });

    const rowsAfter = entryRows();
    expect(rowsAfter.size).toBe(5001);
    expect(
      [...rowsAfter].filter(([key, value]) => rowsBefore.get(key) !== value).map(([key]) => key),
    ).toEqual(['message/m-5001']);
    // Записано в файл базы: одна строка entries и строка работы (updatedAt и версия) — и больше ничего.
    expect(totalChanges() - changesBefore).toBe(2);
  });

  it('битую карту в базе не переписываем: версия и строки прежние', async () => {
    await createWork(project, { title: 'Авторизация' });
    const broken = readStoredMap(project, 'w-0001');
    const session = addSession(broken, { provider: 'claude', label: 'план', task: 't' });
    Object.assign(session, { role: { source: 'bogus', name: 'x' } });
    replaceStoredMap(project, 'w-0001', broken);
    const before = { version: versionOf('w-0001'), rows: entryRows() };

    await expect(updateMap(project, 'w-0001', addPlanSession)).rejects.toThrow(
      'invalid session role',
    );

    expect(versionOf('w-0001')).toBe(before.version);
    expect(entryRows()).toEqual(before.rows);
    expect(workDb().isTransaction).toBe(false);
  });

  it('повторное чтение неизменной карты идёт из кэша и не делит объект с вызывающим', async () => {
    await createWork(project, { title: 'Авторизация' });
    const before = mapCacheStats();
    const first = await readMap(project, 'w-0001');
    first.work.title = 'испорчено снаружи';

    expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
    expect(mapCacheStats().hits - before.hits).toBeGreaterThanOrEqual(1);
  });

  it('readMap после updateMap в том же процессе — из кэша; после чужой записи — новая версия', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', (map) => {
      map.work.goal = 'своя запись';
    });
    const own = mapCacheStats();

    expect((await readMap(project, 'w-0001')).work.goal).toBe('своя запись');
    expect(mapCacheStats().hits - own.hits).toBe(1);
    expect(mapCacheStats().misses - own.misses).toBe(0);

    const foreign = readStoredMap(project, 'w-0001');
    foreign.work.goal = 'чужая запись';
    replaceStoredMap(project, 'w-0001', foreign);
    const stale = mapCacheStats();

    expect((await readMap(project, 'w-0001')).work.goal).toBe('чужая запись');
    expect(mapCacheStats().misses - stale.misses).toBe(1);
  });

  it('updateMap неизменной карты не читает базу, а результат и кэш независимы', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const before = mapCacheStats();
    const updated = await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Новая';
    });
    updated.work.title = 'испорчено снаружи';

    expect((await readMap(project, 'w-0001')).work.title).toBe('Новая');
    expect(mapCacheStats().misses).toBe(before.misses);
  });

  it('брошенная мутация не портит кэш', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');

    await expect(
      updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Наполовину';
        throw new Error('стоп');
      }),
    ).rejects.toThrow('стоп');

    expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
  });

  it('updateMap на попадании в кэш берёт карту во владение: копии нет, а результат и кэш не делят объект', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const before = mapCacheStats();
      const updated = await updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Новая';
      });

      expect(mapCacheStats().hits - before.hits).toBe(1);
      expect(clone).not.toHaveBeenCalled();
      // Карту, что вернул `updateMap`, мутировали в кэше: после записи запись кэша — свежая загрузка, а не этот объект.
      updated.work.title = 'испорчено снаружи';
      expect((await readMap(project, 'w-0001')).work.title).toBe('Новая');
    } finally {
      clone.mockRestore();
    }
  });

  it('брошенная мутация на попадании в кэш не оставляет следов: следующее чтение — то, что в базе', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const before = mapCacheStats();

    await expect(
      updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Наполовину';
        addPlanSession(map);
        throw new Error('стоп');
      }),
    ).rejects.toThrow('стоп');
    // Мутация шла над кэшированным объектом, а не над копией: иначе тест ничего бы не сторожил.
    expect(mapCacheStats().hits - before.hits).toBe(1);

    const after = await readMap(project, 'w-0001');
    expect(after.work.title).toBe('Авторизация');
    expect(after.sessions).toEqual([]);
    expect(after).toEqual(readStoredMap(project, 'w-0001'));
    expect(workDb().isTransaction).toBe(false);
  });

  it('мутация, после которой normalizeMap бросает, откатывает запись: версия та же, база не изменилась, ошибка у вызывающего', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', addPlanSession);
    const before = {
      version: versionOf('w-0001'),
      stored: readStoredMap(project, 'w-0001'),
      rows: entryRows(),
    };
    const seen: number[] = [];
    const stop = onMapWritten((event) => seen.push(event.version));

    await expect(
      updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Наполовину';
        addPlanSession(map);
        map.rooms.push(bogusRoom());
      }),
    ).rejects.toThrow('invalid room mode');
    stop();

    expect(versionOf('w-0001')).toBe(before.version);
    expect(readStoredMap(project, 'w-0001')).toEqual(before.stored);
    expect(entryRows()).toEqual(before.rows);
    expect(seen).toEqual([]);
    expect(workDb().isTransaction).toBe(false);
    // Кэш цел, а база не осталась в открытой транзакции: следующая запись проходит.
    expect(await readMap(project, 'w-0001')).toEqual(before.stored);
    await updateMap(project, 'w-0001', (map) => {
      map.work.goal = 'дальше';
    });
    expect(versionOf('w-0001')).toBe(before.version + 1);
  });

  it('после записи кэш отдаёт то же, что свежая загрузка из базы', async () => {
    await createWork(project, { title: 'Авторизация' });
    // `normalizeMap` убирает effort, не прошедший токен: писавший процесс не должен читать его иначе, чем свежий.
    await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 't', effort: 'bad"value' });
    });
    const fresh = readStoredMap(project, 'w-0001');
    expect(fresh.sessions[0]!.effort).toBeUndefined();

    const before = mapCacheStats();
    const cached = await readMap(project, 'w-0001');

    expect(mapCacheStats().misses).toBe(before.misses);
    expect(cached.sessions[0]!.effort).toBe(fresh.sessions[0]!.effort);
    expect(cached).toEqual(fresh);
  });

  it('карта, которую нормализация отвергает, не остаётся в кэше: чтение и обновление падают, как из базы', async () => {
    await createWork(project, { title: 'Авторизация' });
    const broken = readStoredMap(project, 'w-0001');
    Object.assign(addSession(broken, { provider: 'claude', label: 'план', task: 't' }), {
      role: { source: 'bogus', name: 'x' },
    });
    replaceStoredMap(project, 'w-0001', broken);

    await expect(readMap(project, 'w-0001')).rejects.toThrow('invalid session role');
    await expect(updateMap(project, 'w-0001', () => {})).rejects.toThrow('invalid session role');
  });

  it('кэш вмещает не больше MAP_CACHE_LIMIT карт: самая давняя по вставке вытесняется', async () => {
    const ids: string[] = [];
    for (let n = 0; n <= MAP_CACHE_LIMIT; n += 1) {
      ids.push((await createWork(project, { title: `Работа ${n}` })).work.id);
    }
    // MAP_CACHE_LIMIT + 1 загрузок подряд: первая карта вытеснена последней.
    for (const id of ids) await readMap(project, id);

    const missesOf = async (id: string): Promise<number> => {
      const before = mapCacheStats().misses;
      await readMap(project, id);
      return mapCacheStats().misses - before;
    };
    expect(await missesOf(ids[1]!)).toBe(0);
    expect(await missesOf(ids[0]!)).toBe(1);
  });

  it('база занята другим соединением — MapLockTimeoutError через lockTimeoutMs, а не вечное ожидание; чтение идёт', async () => {
    await createWork(project, { title: 'Авторизация' });
    const foreign = holdWriteLock();
    try {
      const started = Date.now();
      const error = await updateMap(project, 'w-0001', (map) => (map.work.title = 'Другое'), {
        lockTimeoutMs: 150,
      }).catch((cause: Error) => cause);

      expect(error).toBeInstanceOf(MapLockTimeoutError);
      expect((error as Error).message).toMatch(/lock .*parley\.db was not released within 150 ms/);
      expect(Date.now() - started).toBeLessThan(2000);
      expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
    } finally {
      foreign.release();
    }
  });

  it('отказ записи на попадании в кэш не оставляет следов: ретрай не двоит запись', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const foreign = holdWriteLock();
    try {
      await expect(
        updateMap(project, 'w-0001', addPlanSession, { lockTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(MapLockTimeoutError);
      expect((await readMap(project, 'w-0001')).sessions).toEqual([]);
    } finally {
      foreign.release();
    }

    await updateMap(project, 'w-0001', addPlanSession);

    expect((await readMap(project, 'w-0001')).sessions).toHaveLength(1);
  });

  it('параллельные записи в одном процессе не теряются', async () => {
    await createWork(project, { title: 'Авторизация' });

    await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        updateMap(
          project,
          'w-0001',
          (map) => {
            addSession(map, { provider: 'claude', label: `сессия ${i}`, task: 't' });
          },
          { lockTimeoutMs: 10_000 },
        ),
      ),
    );

    const map = await readMap(project, 'w-0001');
    expect(map.sessions).toHaveLength(10);
    expect(new Set(map.sessions.map((session) => session.id)).size).toBe(10);
  });

  it('50 одновременных updateMap одного процесса проходят без MapLockTimeoutError и все применяются', async () => {
    await createWork(project, { title: 'Авторизация' });

    await Promise.all(
      Array.from({ length: 50 }, (_unused, i) =>
        updateMap(
          project,
          'w-0001',
          (map) => {
            addSession(map, { provider: 'claude', label: `s${i}`, task: 't' });
          },
          { lockTimeoutMs: 100 },
        ),
      ),
    );

    expect((await readMap(project, 'w-0001')).sessions).toHaveLength(50);
  });

  it('мутация, упавшая посреди записи, не мешает идущим за ней: они применяются', async () => {
    await createWork(project, { title: 'Авторизация' });
    const fail = (): void => {
      throw new Error('мутация упала');
    };

    // Двое падают, третий — в любом порядке прихода — должен применить своё.
    const results = await Promise.allSettled([
      updateMap(project, 'w-0001', fail),
      updateMap(project, 'w-0001', fail),
      updateMap(project, 'w-0001', (map) => {
        map.work.goal = 'применено';
      }),
    ]);

    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
    expect((await readMap(project, 'w-0001')).work.goal).toBe('применено');
  });

  it('два процесса пишут одну работу по 200 записей — в итоге 400 сессий, ни одна не потеряна', async () => {
    await createWork(project, { title: 'Авторизация' });
    // Оба — дочерний и этот — начинают с одной отметки времени и отдают друг другу слово между записями.
    const start = Date.now() + 2_500;
    const child = run(
      process.execPath,
      ['--import', tsxLoader, writerScript, project, 'w-0001', 'child', '200', String(start)],
      { env: { ...process.env, PARLEY_HOME: home } },
    );
    await new Promise((resolve) => setTimeout(resolve, start - Date.now() - 3));
    while (Date.now() < start) {
      /* общая отметка старта */
    }
    for (let i = 0; i < 200; i += 1) {
      await updateMap(
        project,
        'w-0001',
        (map) => {
          addSession(map, { provider: 'claude', label: `parent-${i}`, task: 't' });
        },
        { lockTimeoutMs: 30_000 },
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    await child;

    const map = await readMap(project, 'w-0001');
    expect(map.sessions).toHaveLength(400);
    expect(new Set(map.sessions.map((session) => session.id)).size).toBe(400);
    expect(map.sessions.filter((session) => session.label.startsWith('child-'))).toHaveLength(200);
    expect(map.sessions.filter((session) => session.label.startsWith('parent-'))).toHaveLength(200);
  }, 120_000);

  it('карта с чужим id работы не пишется: версия и список работ прежние', async () => {
    await createWork(project, { title: 'Авторизация' });
    const alien = readStoredMap(project, 'w-0001');
    alien.work.id = 'w-0777';
    replaceStoredMap(project, 'w-0001', alien);
    const before = versionOf('w-0001');

    await expect(
      updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Другое';
      }),
    ).rejects.toThrow(/w-0777/);

    expect(versionOf('w-0001')).toBe(before);
    expect((await readWorksIndex()).works.map((work) => [work.id, work.title])).toEqual([
      ['w-0001', 'Авторизация'],
    ]);
  });

  it('два параллельных процесса создают разные работы в базе', async () => {
    // База уже создана: её первым открывает хост (спека хранилища 6.1). Одновременное первое открытие свежего файла двумя
    // процессами упирается в `PRAGMA journal_mode = WAL` мимо `busy_timeout` — это отдельный случай `db.ts`, не записи.
    workDb();
    const creator = (title: string) =>
      run(
        process.execPath,
        ['--import', tsxLoader, writerScript, project, 'new-work', title, '0'],
        {
          env: { ...process.env, PARLEY_HOME: home },
        },
      );

    await Promise.all([creator('первая'), creator('вторая')]);

    const index = await readWorksIndex();
    expect(index.works.map((work) => work.id).sort()).toEqual(['w-0001', 'w-0002']);
    expect(index.works.map((work) => work.title).sort()).toEqual(['вторая', 'первая']);
  }, 60_000);
});

describe('busy_timeout соединения после записи', () => {
  it('после updateMap с lockTimeoutMs соединение снова ждёт 5000 мс, как при открытии', async () => {
    await createWork(project, { title: 'Авторизация' });

    await updateMap(project, 'w-0001', addPlanSession, { lockTimeoutMs: 100 });

    expect(connectionBusyTimeout()).toBe(5000);
  });

  it('и после отказа: брошенная мутация, занятая база', async () => {
    await createWork(project, { title: 'Авторизация' });

    await expect(
      updateMap(
        project,
        'w-0001',
        () => {
          throw new Error('мутация упала');
        },
        { lockTimeoutMs: 100 },
      ),
    ).rejects.toThrow('мутация упала');
    expect(connectionBusyTimeout()).toBe(5000);

    const foreign = holdWriteLock();
    try {
      await expect(
        updateMap(project, 'w-0001', addPlanSession, { lockTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(MapLockTimeoutError);
    } finally {
      foreign.release();
    }
    expect(connectionBusyTimeout()).toBe(5000);
  });

  it('createWork и deleteWorkFiles с lockTimeoutMs тоже возвращают 5000', async () => {
    await createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 });
    expect(connectionBusyTimeout()).toBe(5000);

    await deleteWorkFiles(project, 'w-0001', { lockTimeoutMs: 100 });
    expect(connectionBusyTimeout()).toBe(5000);
  });
});

describe('onMapWritten, workExists и replaceStoredMap', () => {
  it('createWork и updateMap сообщают проект, работу и новую версию; после отписки — тишина', async () => {
    const events: { projectPath: string; workId: string; version: number }[] = [];
    const stop = onMapWritten((event) => events.push(event));

    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', addPlanSession);
    stop();
    await updateMap(project, 'w-0001', addPlanSession);

    const created = events[0]!.version;
    expect(events).toEqual([
      { projectPath: project, workId: 'w-0001', version: created },
      { projectPath: project, workId: 'w-0001', version: created + 1 },
    ]);
    expect(versionOf('w-0001')).toBe(created + 2);
  });

  it('слушатель, который бросает, не ломает уже записанное', async () => {
    await createWork(project, { title: 'Авторизация' });
    const stop = onMapWritten(() => {
      throw new Error('слушатель упал');
    });
    try {
      await expect(updateMap(project, 'w-0001', addPlanSession)).resolves.toMatchObject({
        sessions: [{ id: 's-01' }],
      });
    } finally {
      stop();
    }

    expect((await readMap(project, 'w-0001')).sessions).toHaveLength(1);
  });

  it('workExists: есть строка работы — да; чужой проект и неизвестный id — нет', async () => {
    await createWork(project, { title: 'Авторизация' });

    expect(workExists(project, 'w-0001')).toBe(true);
    expect(workExists(other, 'w-0001')).toBe(false);
    expect(workExists(project, 'w-0002')).toBe(false);
  });

  it('replaceStoredMap заменяет карту целиком без проверки формы и поднимает версию', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', (map) => {
      addPlanSession(map);
      addPlanSession(map);
    });
    const before = versionOf('w-0001');
    const seen: number[] = [];
    const stop = onMapWritten((event) => seen.push(event.version));
    const replacement = readStoredMap(project, 'w-0001');
    replacement.sessions.pop();
    replacement.work.title = 'Заменённая';
    replacement.rooms.push(bogusRoom());

    replaceStoredMap(project, 'w-0001', replacement);
    stop();

    expect(versionOf('w-0001')).toBe(before + 1);
    expect(seen).toEqual([before + 1]);
    expect((await readWorksIndex()).works[0]?.title).toBe('Заменённая');
    expect(
      Number(
        (
          workDb().prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'session'").get() as {
            n: number;
          }
        ).n,
      ),
    ).toBe(1);
    expect(() => readStoredMap(project, 'w-0001')).toThrow('invalid room mode');
    await expect(readMap(project, 'w-0001')).rejects.toThrow('invalid room mode');
  });

  it('replaceStoredMap на работе, которой нет, — WorkNotFoundError', () => {
    expect(() => replaceStoredMap(project, 'w-9999', {})).toThrow(WorkNotFoundError);
  });
});

describe('insertMigratedMap — вставка карты прежнего файла (спека хранилища 6.6)', () => {
  const migratedMap = (): WorkMap => {
    const map: WorkMap = {
      schemaVersion: 2,
      work: {
        id: 'w-0004',
        title: 'Из файла',
        goal: '',
        status: 'active',
        createdAt: '2026-10-04T01:00:00.000Z',
        updatedAt: '2026-10-04T01:00:00.000Z',
      },
      sessions: [],
      messages: [],
      rooms: [],
    };
    addSession(map, { provider: 'claude', label: 'Первая', task: '' });
    addMessage(map, { from: 's-01', to: ['human'], text: 'привет' });
    return map;
  };

  it('кладёт строку работы и строки списков, версия — часы, подписчик узнаёт о работе после коммита', async () => {
    const seen: { projectPath: string; workId: string; version: number }[] = [];
    const stop = onMapWritten((event) => seen.push(event));
    const before = Date.now();
    let checked = false;

    insertMigratedMap(project, 'w-0004', migratedMap(), () => {
      // Внутри транзакции уже видны ещё не записанные строки, и подписчик о работе ещё не знает.
      checked = readStoredMap(project, 'w-0004').sessions.length === 1 && seen.length === 0;
    });
    stop();

    expect(checked).toBe(true);
    expect(versionOf('w-0004')).toBeGreaterThanOrEqual(before);
    expect(seen).toEqual([{ projectPath: project, workId: 'w-0004', version: versionOf('w-0004') }]);
    expect(await readMap(project, 'w-0004')).toMatchObject({ work: { title: 'Из файла' }, messages: [{ text: 'привет' }] });
    expect((await readWorksIndex()).works).toEqual([
      { id: 'w-0004', projectPath: project, title: 'Из файла', status: 'active', updatedAt: '2026-10-04T01:00:00.000Z' },
    ]);
  });

  it('check бросил — откат целиком: ни строки работы, ни строк списков, ни события', () => {
    const seen: number[] = [];
    const stop = onMapWritten((event) => seen.push(event.version));

    expect(() =>
      insertMigratedMap(project, 'w-0004', migratedMap(), () => {
        throw new Error('сверка не сошлась');
      }),
    ).toThrow('сверка не сошлась');
    stop();

    expect(workExists(project, 'w-0004')).toBe(false);
    expect(Number((workDb().prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('работа с таким id уже есть — ошибка, прежние строки не тронуты', async () => {
    insertMigratedMap(project, 'w-0004', migratedMap(), () => undefined);
    const before = versionOf('w-0004');
    const other = migratedMap();
    other.work.title = 'Вторая вставка';

    expect(() => insertMigratedMap(project, 'w-0004', other, () => undefined)).toThrow();

    expect(versionOf('w-0004')).toBe(before);
    expect((await readMap(project, 'w-0004')).work.title).toBe('Из файла');
  });
});

/** Отодвигает `work.updatedAt` в прошлое прямо в базе: иначе «не сдвинулся» не отличить от той же миллисекунды. */
async function ageWork(workId: string, at = '2020-01-01T00:00:00.000Z'): Promise<string> {
  const stored = readStoredMap(project, workId);
  stored.work.updatedAt = at;
  replaceStoredMap(project, workId, stored);
  return at;
}

describe('updateMap: опция touch', () => {
  it('touch: false не меняет work.updatedAt, без опции — сдвигает', async () => {
    await createWork(project, { title: 'Авторизация' });
    const old = await ageWork('w-0001');

    const quiet = await updateMap(project, 'w-0001', (map) => (map.work.goal = 'тихо'), {
      touch: false,
    });
    expect(quiet.work.updatedAt).toBe(old);
    expect((await readMap(project, 'w-0001')).work.updatedAt).toBe(old);
    expect((await readWorksIndex()).works[0]?.updatedAt).toBe(old);

    const loud = await updateMap(project, 'w-0001', (map) => (map.work.goal = 'громко'));
    expect(loud.work.updatedAt).not.toBe(old);
  });
});

describe('читать и писать работу, которой нет — WorkNotFoundError', () => {
  it('работы нет с самого начала: у readMap и у updateMap, в тексте id работы и путь проекта', async () => {
    const error = await readMap(project, 'w-9999').catch((cause: Error) => cause);

    expect(error).toBeInstanceOf(WorkNotFoundError);
    expect((error as Error).message).toContain('w-9999');
    expect((error as Error).message).toContain(project);
    expect((error as Error).message).not.toMatch(/ENOENT/);
    await expect(updateMap(project, 'w-9999', () => {})).rejects.toBeInstanceOf(WorkNotFoundError);
    expect(workDb().isTransaction).toBe(false);
  });

  it('работу удалили другим соединением, пока карта лежала в кэше: и чтение, и запись это видят', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');

    workDb().prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, 'w-0001');

    await expect(readMap(project, 'w-0001')).rejects.toBeInstanceOf(WorkNotFoundError);
    await expect(updateMap(project, 'w-0001', () => {})).rejects.toBeInstanceOf(WorkNotFoundError);
  });

  it('updateMap на пропавшей работе снимает запись кэша, как readMap: строка вернулась под той же версией — читается заново', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const row = workDb()
      .prepare('SELECT * FROM works WHERE project_path = ? AND id = ?')
      .get(project, 'w-0001') as Record<string, string | number>;
    workDb().prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, 'w-0001');

    await expect(updateMap(project, 'w-0001', () => {})).rejects.toBeInstanceOf(WorkNotFoundError);

    // Другой процесс вернул строку с прежней версией, но другим содержимым.
    const work = JSON.parse(String(row['work_json'])) as Record<string, unknown>;
    work['title'] = 'Вернулась другой';
    workDb()
      .prepare(
        `INSERT INTO works (project_path, id, title, status, updated_at, version, work_json, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project,
        'w-0001',
        'Вернулась другой',
        String(row['status']),
        String(row['updated_at']),
        Number(row['version']),
        JSON.stringify(work),
        String(row['extra_json']),
      );
    const before = mapCacheStats();

    expect((await readMap(project, 'w-0001')).work.title).toBe('Вернулась другой');
    expect(mapCacheStats().misses - before.misses).toBe(1);
  });
});

describe('renameWork', () => {
  it('обрезает пробелы и не сдвигает work.updatedAt', async () => {
    await createWork(project, { title: 'Старая' });
    const old = await ageWork('w-0001');

    const map = await renameWork(project, 'w-0001', '  Новая  ');

    expect(map.work.title).toBe('Новая');
    const disk = await readMap(project, 'w-0001');
    expect(disk.work.title).toBe('Новая');
    expect(disk.work.updatedAt).toBe(old);
    expect((await readWorksIndex()).works[0]?.title).toBe('Новая');
  });

  it('пустое название и 121 символ — ошибка, карта не меняется', async () => {
    await createWork(project, { title: 'Старая' });

    await expect(renameWork(project, 'w-0001', '')).rejects.toThrow(
      'workspace title: 1–120 characters',
    );
    await expect(renameWork(project, 'w-0001', '   ')).rejects.toThrow(
      'workspace title: 1–120 characters',
    );
    await expect(renameWork(project, 'w-0001', 'я'.repeat(121))).rejects.toThrow(
      'workspace title: 1–120 characters',
    );
    expect((await readMap(project, 'w-0001')).work.title).toBe('Старая');
  });

  it('невидимые символы формата (U+200B/C/D, U+2060, U+FEFF) — как пробелы: пустое отвергается, края обрезаются', async () => {
    await createWork(project, { title: 'Старая' });
    for (const invisible of ['\u200B\u200B\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', ' \u200B \u2060 ']) {
      await expect(renameWork(project, 'w-0001', invisible)).rejects.toThrow(
        'workspace title: 1–120 characters',
      );
    }
    const map = await renameWork(project, 'w-0001', '\u200B Новая\u200Dx \u2060');
    // ZWJ внутри названия (эмодзи-последовательности) остаётся — обрезаются только края.
    expect(map.work.title).toBe('Новая\u200Dx');
  });

  it('120 эмодзи принимаются: символы считаются по кодовым точкам', async () => {
    await createWork(project, { title: 'Старая' });
    const title = '😀'.repeat(120);
    expect(title.length).toBe(240);

    const map = await renameWork(project, 'w-0001', title);
    expect(map.work.title).toBe(title);
  });
});

describe('setWorkStatus', () => {
  it('archived пишет статус и не сдвигает work.updatedAt', async () => {
    await createWork(project, { title: 'Авторизация' });
    const old = await ageWork('w-0001');

    await setWorkStatus(project, 'w-0001', 'archived');

    const disk = await readMap(project, 'w-0001');
    expect(disk.work.status).toBe('archived');
    expect(disk.work.updatedAt).toBe(old);
    expect((await readWorksIndex()).works[0]).toMatchObject({ status: 'archived', updatedAt: old });
  });
});

describe('readWorksIndex', () => {
  it('список работ идёт из базы в порядке создания, а не из файла', async () => {
    await createWork(project, { title: 'Первая' });
    await createWork(other, { title: 'Вторая' });
    await writeFile(worksIndexPath(), '{ сломано', 'utf8');

    const index = await readWorksIndex();

    expect(index.schemaVersion).toBe(1);
    expect(index.works.map((work) => [work.projectPath, work.id, work.title])).toEqual([
      [project, 'w-0001', 'Первая'],
      [other, 'w-0002', 'Вторая'],
    ]);
  });

  it('прежний файл индекса, если его просят по имени: битый json — ошибка, догадки не строим', async () => {
    await writeFile(worksIndexPath(), '{ сломано', 'utf8');

    await expect(readWorksIndex(worksIndexPath())).rejects.toThrow(
      /workspace index .* cannot be parsed: /,
    );
  });

  it('прежний файл индекса: чужая форма или другая версия схемы — ошибка, нет файла — пустой список', async () => {
    await writeFile(worksIndexPath(), '{"schemaVersion":2,"works":[]}', 'utf8');
    await expect(readWorksIndex(worksIndexPath())).rejects.toThrow(
      /workspace index .* cannot be parsed: unexpected shape/,
    );

    await writeFile(worksIndexPath(), '{"schemaVersion":1}', 'utf8');
    await expect(readWorksIndex(worksIndexPath())).rejects.toThrow(
      /workspace index .* cannot be parsed: unexpected shape/,
    );

    await rm(worksIndexPath());
    expect(await readWorksIndex(worksIndexPath())).toEqual({ schemaVersion: 1, works: [] });
  });
});

describe('pruneWorksIndex', () => {
  it('убирает из списка работы, у которых каталога на диске больше нет', async () => {
    const kept = await createWork(project, { title: 'Живая' });
    const gone = await createWork(other, { title: 'Снесённая' });
    await rm(workPaths(other, gone.work.id).dir, { recursive: true, force: true });

    const removed = await pruneWorksIndex();

    expect(removed).toEqual([expect.objectContaining({ id: gone.work.id, projectPath: other })]);
    const { works } = await readWorksIndex();
    expect(works.map((work) => [work.projectPath, work.id])).toEqual([[project, kept.work.id]]);
    expect(workExists(other, gone.work.id)).toBe(false);
  });

  it('проект исчез целиком вместе с каталогом состояния — его работы тоже снимаются', async () => {
    const gone = await createWork(other, { title: 'Из пропавшего проекта' });
    await readMap(other, gone.work.id);
    await rm(other, { recursive: true, force: true });

    const removed = await pruneWorksIndex();

    expect(removed).toEqual([expect.objectContaining({ id: gone.work.id, projectPath: other })]);
    await expect(readMap(other, gone.work.id)).rejects.toBeInstanceOf(WorkNotFoundError);
  });

  it('целый список не трогает и ничего не возвращает', async () => {
    await createWork(project, { title: 'Живая' });
    const before = await readWorksIndex();

    expect(await pruneWorksIndex()).toEqual([]);
    expect(await readWorksIndex()).toEqual(before);
  });
});

describe('deleteWorkFiles', () => {
  it('сносит каталог работы целиком и снимает её строки из базы вместе с записями списков', async () => {
    const kept = await createWork(project, { title: 'Живая' });
    const gone = await createWork(project, { title: 'Лишняя' });
    await updateMap(project, gone.work.id, addPlanSession);
    await readMap(project, gone.work.id);
    const paths = workPaths(project, gone.work.id);
    await writeFile(path.join(paths.artifacts, 'plan.md'), 'план\n', 'utf8');

    await deleteWorkFiles(project, gone.work.id);

    expect(await exists(paths.dir)).toBe(false);
    expect(await exists(workPaths(project, kept.work.id).dir)).toBe(true);
    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual([kept.work.id]);
    expect(
      Number(
        (
          workDb()
            .prepare('SELECT COUNT(*) AS n FROM entries WHERE work_id = ?')
            .get(gone.work.id) as { n: number }
        ).n,
      ),
    ).toBe(0);
    await expect(readMap(project, gone.work.id)).rejects.toBeInstanceOf(WorkNotFoundError);
  });

  it('каталога уже нет — строка всё равно уходит, ошибки нет', async () => {
    const gone = await createWork(project, { title: 'Снесённая' });
    await rm(workPaths(project, gone.work.id).dir, { recursive: true, force: true });

    await deleteWorkFiles(project, gone.work.id);

    expect((await readWorksIndex()).works).toEqual([]);
  });

  it('при занятой базе не удаляет каталог работы: отказ ничего не стирает', async () => {
    await createWork(project, { title: 'Авторизация' });
    const foreign = holdWriteLock();
    try {
      await expect(
        deleteWorkFiles(project, 'w-0001', { lockTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(MapLockTimeoutError);
    } finally {
      foreign.release();
    }

    expect(await exists(workPaths(project, 'w-0001').dir)).toBe(true);
    expect((await readMap(project, 'w-0001')).work.id).toBe('w-0001');
    expect((await readWorksIndex()).works).toHaveLength(1);
  });
});

describe('осиротевшая блокировка проекта (общая для бэклога и записей общих файлов)', () => {
  const deadPid = async (): Promise<number> => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    return pid;
  };
  const noop = async (): Promise<void> => {};
  const lockPaths = async () => {
    const paths = await sharedProjectPaths(project);
    await mkdir(paths.dir, { recursive: true });
    return paths;
  };

  it('блокировка с pid умершего процесса перехватывается', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, `${await deadPid()}\n`);

    await withSharedProjectLock(paths, noop);

    expect(await exists(paths.lock)).toBe(false);
  });

  it('пустой файл блокировки старше 10 с перехватывается', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, '');
    const old = new Date(Date.now() - 11_000);
    await utimes(paths.lock, old, old);

    await withSharedProjectLock(paths, noop);

    expect(await exists(paths.lock)).toBe(false);
  });

  it('пустой свежий файл блокировки не трогаем: таймаут', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, '');

    await expect(withSharedProjectLock(paths, noop, { lockTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'backlog-lock-timeout',
    });
    expect(await exists(paths.lock)).toBe(true);
  });

  it('блокировка с живым pid не перехватывается', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, `${process.pid}\n`);

    await expect(withSharedProjectLock(paths, noop, { lockTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'backlog-lock-timeout',
    });
    expect(await readFile(paths.lock, 'utf8')).toBe(`${process.pid}\n`);
  });

  it('висячий симлинк на месте блокировки: таймаут, а не горячий цикл', async () => {
    const paths = await lockPaths();
    await symlink(path.join(home, 'нет-такого-файла'), paths.lock);

    const started = Date.now();
    await expect(withSharedProjectLock(paths, noop, { lockTimeoutMs: 200 })).rejects.toMatchObject({
      code: 'backlog-lock-timeout',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('живой pid при старом mtime: pid важнее возраста, блокировка не снимается', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, `${process.pid}\n`);
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lock, old, old);

    await expect(withSharedProjectLock(paths, noop, { lockTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'backlog-lock-timeout',
    });
    expect(await readFile(paths.lock, 'utf8')).toBe(`${process.pid}\n`);
  });

  it('свежий guard перехвата: идёт чужой перехват, ждём до таймаута', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, `${await deadPid()}\n`);
    await writeFile(`${paths.lock}.steal`, '');

    await expect(withSharedProjectLock(paths, noop, { lockTimeoutMs: 150 })).rejects.toMatchObject({
      code: 'backlog-lock-timeout',
    });
    expect(await exists(paths.lock)).toBe(true);
  });

  it('guard старше 10 с — вор упал внутри: guard снимается, блокировка берётся', async () => {
    const paths = await lockPaths();
    await writeFile(paths.lock, `${await deadPid()}\n`);
    await writeFile(`${paths.lock}.steal`, '');
    const old = new Date(Date.now() - 11_000);
    await utimes(`${paths.lock}.steal`, old, old);

    await withSharedProjectLock(paths, noop);

    expect(await exists(paths.lock)).toBe(false);
    expect(await exists(`${paths.lock}.steal`)).toBe(false);
  });

  it('взятая блокировка содержит pid текущего процесса', async () => {
    const paths = await lockPaths();
    let held = '';
    await withSharedProjectLock(paths, async () => {
      held = readFileSync(paths.lock, 'utf8');
    });

    expect(held).toBe(`${process.pid}\n`);
  });
});
describe('deleteSessionFiles', () => {
  /** Работа с сессией и всеми её файлами на диске: бриф, журнал, MCP-конфиг. */
  const withFiles = async (): Promise<string> => {
    const map = await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, map.work.id);
    await mkdir(paths.events, { recursive: true });
    await mkdir(paths.mcp, { recursive: true });
    await writeFile(path.join(paths.briefs, 's-01.md'), '# Работа\n', 'utf8');
    await writeFile(path.join(paths.briefs, 's-02.md'), '# Соседка\n', 'utf8');
    await writeFile(path.join(paths.events, 's-01.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(paths.mcp, 's-01.json'), '{}\n', 'utf8');
    await writeFile(path.join(paths.artifacts, 'plan.md'), 'план\n', 'utf8');
    return map.work.id;
  };

  it('25: удаляет бриф, журнал и MCP-конфиг сессии, артефакты не трогает', async () => {
    const workId = await withFiles();
    const paths = workPaths(project, workId);

    await deleteSessionFiles(project, workId, 's-01');

    expect(await exists(path.join(paths.briefs, 's-01.md'))).toBe(false);
    expect(await exists(path.join(paths.events, 's-01.jsonl'))).toBe(false);
    expect(await exists(path.join(paths.mcp, 's-01.json'))).toBe(false);
    // Артефакты — результат работы, а не след сессии: они остаются (раздел C).
    expect(await exists(path.join(paths.artifacts, 'plan.md'))).toBe(true);
    // Файлы соседних сессий целы.
    expect(await exists(path.join(paths.briefs, 's-02.md'))).toBe(true);
  });

  it('26: файла уже нет — не ошибка', async () => {
    const map = await createWork(project, { title: 'Авторизация' });

    await expect(deleteSessionFiles(project, map.work.id, 's-01')).resolves.toBeUndefined();
  });

  it('27: файл лимитов строки статуса уходит вместе с сессией, соседний остаётся', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    const { limits } = workPaths(project, map.work.id);
    await mkdir(limits, { recursive: true });
    await writeFile(path.join(limits, 's-01.json'), '{}\n', 'utf8');
    await writeFile(path.join(limits, 's-02.json'), '{}\n', 'utf8');

    await deleteSessionFiles(project, map.work.id, 's-01');

    expect(await exists(path.join(limits, 's-01.json'))).toBe(false);
    expect(await exists(path.join(limits, 's-02.json'))).toBe(true);
  });
});


it('deleteSessionFiles убирает и context/<сессия>.json (спека 2026-10-15)', async () => {
  const map = await createWork(project, { title: 'Авторизация' });
  const paths = workPaths(project, map.work.id);
  await mkdir(paths.context, { recursive: true });
  const file = contextFile(paths.dir, 's-01');
  await writeFile(file, '{}');
  await deleteSessionFiles(project, map.work.id, 's-01');
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('read-only shared ignore diagnostics', () => {
  it('does not create a state directory or ignore file on an untouched GET', async () => {
    const paths = await sharedProjectPaths(project);
    expect(await inspectSharedIgnore(paths)).toEqual([]);
    await expect(stat(paths.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves custom/BOM/CRLF bytes and diagnoses an existing missing ignore file', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.dir);
    expect(await inspectSharedIgnore(paths)).toEqual([{ code: 'parley-gitignore-custom' }]);
    const file = path.join(paths.dir, '.gitignore');
    for (const text of ['custom\n', '\uFEFF*\n', '*\r\n']) {
      await writeFile(file, text); expect(await inspectSharedIgnore(paths)).toContainEqual({ code: 'parley-gitignore-custom' });
      expect(await readFile(file, 'utf8')).toBe(text);
    }
  });
  it('does not migrate the old generated signature during inspection, and write preparation still migrates it', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.dir);
    const file = path.join(paths.dir, '.gitignore'); await writeFile(file, '*\n');
    expect(await inspectSharedIgnore(paths)).toEqual([]); expect(await readFile(file, 'utf8')).toBe('*\n');
    expect(await prepareSharedIgnore(paths)).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('*\n!.gitignore\n!backlog.md\n!plans/\n!plans/**\n!memory.md\n!decisions/\n!decisions/**\n!history-shared/\n!history-shared/**\n!recipes/\n!recipes/**\n');
  });
  it('reuses the accepted bounded native ignore query without root ignore writes', async () => {
    const paths = await sharedProjectPaths(project);
    const calls: readonly string[][] = [];
    const options = { readGit: async (args: readonly string[]) => { (calls as string[][]).push([...args]); return { code: 0, stdout: '.parley/backlog.md\n', stderr: '' }; } };
    expect(await inspectSharedIgnore({ ...paths, context: { kind: 'git', projectPath: paths.context.projectPath, mainRoot: paths.context.projectPath, checkoutRoot: paths.context.projectPath } }, options)).toContainEqual({ code: 'parley-dir-ignored' });
    expect(calls[0]).toContain('check-ignore'); expect(calls[0]).toContain('core.fsmonitor=false');
    await expect(stat(path.join(project, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('memory diagnostics use the verified canonical path without writing a read-time migration', async () => {
  const { PRE_MEMORY_STATE_IGNORE } = await import('./state-dir.js');
  const paths = await sharedProjectPaths(project); await mkdir(paths.dir);
  await writeFile(path.join(paths.dir, '.gitignore'), PRE_MEMORY_STATE_IGNORE);
  const calls: string[][] = [];
  const options = { readGit: async (args: readonly string[]) => {
    calls.push([...args]); return { code: args.includes(path.relative(paths.context.projectPath, paths.memory)) ? 0 : 1, stdout: args.includes(path.relative(paths.context.projectPath, paths.memory)) ? '.parley/memory.md\n' : '', stderr: '' };
  } };
  expect(await inspectSharedIgnore({ ...paths, context: { kind: 'git', projectPath: paths.context.projectPath, mainRoot: paths.context.projectPath, checkoutRoot: paths.context.projectPath } }, options)).toContainEqual({ code: 'parley-dir-ignored' });
  expect(calls.some(args => args.includes(path.relative(paths.context.projectPath, paths.memory)))).toBe(true);
  expect(await readFile(path.join(paths.dir, '.gitignore'), 'utf8')).toBe(PRE_MEMORY_STATE_IGNORE);
});
