import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFile } from '../context-fill.js';
import { addSession, parseMap } from './map.js';
import type { WorkMap } from './types.js';
import {
  createWork,
  deleteSessionFiles,
  deleteWorkFiles,
  MAP_CACHE_LIMIT,
  MAP_SNAPSHOT_LIMIT,
  mapCacheStats,
  MapLockTimeoutError,
  pruneWorksIndex,
  readMap,
  readWorksIndex,
  renameWork,
  setWorkStatus,
  updateMap,
  parleyHome,
  WorkNotFoundError,
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
const writerScript = fileURLToPath(new URL('../../test/work-writer.ts', import.meta.url));
const lockRaceScript = fileURLToPath(new URL('../../test/work-lock-race.ts', import.meta.url));
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

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

describe('createWork', () => {
  it('создаёт раскладку на диске и запись в глобальном индексе', async () => {
    const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
    const paths = workPaths(project, 'w-0001');

    expect(map.schemaVersion).toBe(2);
    expect(map.work.id).toBe('w-0001');
    expect(map.work.status).toBe('active');
    expect(map.sessions).toEqual([]);
    expect(map.messages).toEqual([]);
    expect(map.rooms).toEqual([]);
    expect(paths.dir).toBe(path.join(project, '.parley', 'works', 'w-0001'));
    expect(await isDirectory(paths.briefs)).toBe(true);
    expect(await isDirectory(paths.artifacts)).toBe(true);
    // Omitted optional plans are normalized to an empty list by the accepted map reader.
    expect(await readMap(project, 'w-0001')).toEqual({ ...map, plans: [] });

    expect(worksIndexPath()).toBe(path.join(home, 'works-index.json'));
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

  it('id работ выдаются по глобальному индексу, а не по проекту', async () => {
    await createWork(project, { title: 'Авторизация' });
    const second = await createWork(other, { title: 'Редизайн' });

    expect(second.work.id).toBe('w-0002');
    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual(['w-0001', 'w-0002']);
  });

  it('кладёт map.json.bak сразу: восстанавливать карту есть чем с первой записи', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');

    expect((await readdir(paths.dir)).sort()).toEqual([
      'artifacts',
      'briefs',
      'map.json',
      'map.json.bak',
    ]);
    expect(await readFile(paths.bak, 'utf8')).toBe(await readFile(paths.map, 'utf8'));
  });

  it('не затирает карту, которая уже лежит на диске: занятый id пропускается', async () => {
    await createWork(project, { title: 'Первая' });
    await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 't' });
    });
    // Индекс глобальный и может быть пуст: clone проекта с закоммиченным .parley,
    // перенос PARLEY_HOME, копия проекта. Карта w-0001 при этом на диске есть.
    await rm(worksIndexPath());

    const second = await createWork(project, { title: 'Вторая' });

    expect(second.work.id).toBe('w-0002');
    const first = await readMap(project, 'w-0001');
    expect(first.work.title).toBe('Первая');
    expect(first.sessions).toHaveLength(1);
  });

  it('запись в индексе появляется только вместе с картой: карта не записалась — индекс не тронут', async () => {
    // Наблюдатель PARLEY_HOME читает список по записи индекса: запись без карты он
    // пропустил бы, и первая работа нового проекта не появилась бы у хоста (кусок 3.5).
    const lock = workPaths(project, 'w-0001').lock;
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '');

    await expect(createWork(project, { title: 'Первая' }, { lockTimeoutMs: 50 })).rejects.toThrow(
      /lock .* was not released within 50 ms/,
    );
    expect((await readWorksIndex()).works).toEqual([]);
  });
});

describe('updateMap', () => {
  it('карта v1 на диске после первой мутации ложится как v2 и читается без потерь', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const v1 = JSON.parse(await readFile(paths.map, 'utf8')) as Record<string, unknown>;
    delete v1['rooms'];
    v1['schemaVersion'] = 1;
    v1['sessions'] = [{ id: 's-01', status: 'exited', history: [{ status: 'exited', at: 'x' }] }];
    v1['messages'] = [{ id: 'm-01', from: 's-02', to: 's-01', at: 'x', text: 't', readAt: null }];
    await writeFile(paths.map, JSON.stringify(v1), 'utf8');

    const updated = await updateMap(project, 'w-0001', () => {});

    const raw = JSON.parse(await readFile(paths.map, 'utf8')) as WorkMap;
    expect(raw.schemaVersion).toBe(2);
    expect(raw.rooms).toEqual([]);
    expect(raw.sessions[0]).toMatchObject({ lifecycle: 'sleeping', result: null });
    expect(raw.messages[0]).toMatchObject({ to: ['s-01'], readBy: {}, roomId: null });
    expect(parseMap(await readFile(paths.map, 'utf8'), paths.map)).toEqual(updated);
  });

  it('пишет карту, кладёт прежнюю версию в .bak и обновляет индекс', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const before = await readFile(paths.map, 'utf8');

    const updated = await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
      map.work.status = 'done';
    });

    expect(updated.sessions[0]?.id).toBe('s-01');
    expect(await readFile(paths.bak, 'utf8')).toBe(before);
    expect(parseMap(await readFile(paths.map, 'utf8'), paths.map)).toEqual(updated);
    expect(updated.work.updatedAt >= JSON.parse(before).work.updatedAt).toBe(true);
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

  it('вторая запись в течение 10 минут не переписывает .bak', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const created = await readFile(paths.map, 'utf8');
    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Первая';
    });
    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Вторая';
    });

    expect(await readFile(paths.bak, 'utf8')).toBe(created);
  });

  it('копия старше 10 минут обновляется: в ней версия перед этой записью', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Первая';
    });
    const before = await readFile(paths.map, 'utf8');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(paths.bak, old, old);

    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Вторая';
    });

    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('пропавший .bak кладётся следующей записью', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    await rm(paths.bak);
    const before = await readFile(paths.map, 'utf8');

    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Первая';
    });

    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('.bak из будущего (часы сдвинули) не застревает', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Первая';
    });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await utimes(paths.bak, future, future);
    const before = await readFile(paths.map, 'utf8');

    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Вторая';
    });

    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('после обновления копии по сроку в каталоге работы не остаётся .tmp', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(paths.bak, old, old);
    const before = await readFile(paths.map, 'utf8');

    await updateMap(project, 'w-0001', (map) => {
      map.work.title = 'Новая';
    });

    expect(
      (await readdir(workPaths(project, 'w-0001').dir)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('после записи в каталоге работы не остаётся временных файлов', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 't' });
    });

    expect((await readdir(workPaths(project, 'w-0001').dir)).sort()).toEqual([
      'artifacts',
      'briefs',
      'map.json',
      'map.json.bak',
    ]);
  });

  it('битую карту не переписываем, а .bak хранит прежнюю версию', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const before = await readFile(paths.map, 'utf8');
    await writeFile(paths.map, '{ сломано', 'utf8');

    await expect(
      updateMap(project, 'w-0001', (map) => {
        addSession(map, { provider: 'claude', label: 'план', task: 't' });
      }),
    ).rejects.toThrow(/map .* cannot be parsed/);

    expect(await readFile(paths.map, 'utf8')).toBe('{ сломано');
    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('повторное чтение неизменной карты идёт из кэша и не делит объект с вызывающим', async () => {
    await createWork(project, { title: 'Авторизация' });
    const before = mapCacheStats();
    const first = await readMap(project, 'w-0001');
    first.work.title = 'испорчено снаружи';

    expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
    expect(mapCacheStats().hits - before.hits).toBeGreaterThanOrEqual(1);
  });

  it('карту переписали мимо кэша — следующее чтение видит новую версию', async () => {
    await createWork(project, { title: 'Авторизация' });
    await readMap(project, 'w-0001');
    const paths = workPaths(project, 'w-0001');
    const raw = JSON.parse(await readFile(paths.map, 'utf8')) as WorkMap;
    raw.work.title = 'Снаружи';
    await writeFile(`${paths.map}.ext`, JSON.stringify(raw));
    await rename(`${paths.map}.ext`, paths.map);

    expect((await readMap(project, 'w-0001')).work.title).toBe('Снаружи');
  });

  it('updateMap неизменной карты не читает файл, а результат и кэш независимы', async () => {
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

  it('после записи кэш отдаёт то же, что свежий разбор файла', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    // `parseMap` убирает effort, не прошедший токен: писавший процесс не должен читать его иначе, чем свежий.
    await updateMap(project, 'w-0001', (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 't', effort: 'bad"value' });
    });
    const fresh = parseMap(await readFile(paths.map, 'utf8'), paths.map);
    expect(fresh.sessions[0]!.effort).toBeUndefined();

    const before = mapCacheStats();
    const cached = await readMap(project, 'w-0001');

    expect(mapCacheStats().misses).toBe(before.misses);
    expect(cached.sessions[0]!.effort).toBe(fresh.sessions[0]!.effort);
    expect(cached).toEqual(fresh);
  });

  it('карта, которую свежий разбор отвергнет, не остаётся в кэше: чтение и обновление падают, как с диска', async () => {
    await createWork(project, { title: 'Авторизация' });
    await updateMap(project, 'w-0001', (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
      Object.assign(session, { role: { source: 'bogus', name: 'x' } });
    });

    await expect(readMap(project, 'w-0001')).rejects.toThrow('invalid session role');
    await expect(updateMap(project, 'w-0001', () => {})).rejects.toThrow('invalid session role');
  });

  it('кэш вмещает не больше MAP_CACHE_LIMIT карт: самая давняя по вставке вытесняется', async () => {
    const ids: string[] = [];
    for (let n = 0; n <= MAP_CACHE_LIMIT; n += 1) {
      ids.push((await createWork(project, { title: `Работа ${n}` })).work.id);
    }
    // MAP_CACHE_LIMIT + 1 разборов подряд: первая карта вытеснена последней.
    for (const id of ids) await readMap(project, id);

    const missesOf = async (id: string): Promise<number> => {
      const before = mapCacheStats().misses;
      await readMap(project, id);
      return mapCacheStats().misses - before;
    };
    expect(await missesOf(ids[1]!)).toBe(0);
    expect(await missesOf(ids[0]!)).toBe(1);
  });

  it('занятая блокировка — ошибка, а не ожидание', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    await writeFile(paths.lock, '', { flag: 'wx' });

    const started = Date.now();
    await expect(
      updateMap(project, 'w-0001', (map) => (map.work.title = 'Другое'), { lockTimeoutMs: 150 }),
    ).rejects.toThrow(/lock .*map\.lock was not released within 150 ms/);

    expect(Date.now() - started).toBeLessThan(2000);
    expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
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

  it('писатели в очереди падают по таймауту по одному: ожидание в очереди его не съедает', async () => {
    await createWork(project, { title: 'Авторизация' });
    // Файловый замок занят «чужим процессом» (живой pid): трое одинаковых писателей встают в очередь процесса,
    // и каждому отсчёт своих 100 мс начинается, только когда дошла его очередь.
    await writeFile(workPaths(project, 'w-0001').lock, `${process.pid}\n`, { flag: 'wx' });

    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        updateMap(project, 'w-0001', () => {}, { lockTimeoutMs: 100 }),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(MapLockTimeoutError);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('мутация, упавшая под замком, не вешает очередь: идущие за ней применяются', async () => {
    await createWork(project, { title: 'Авторизация' });
    const fail = (): void => {
      throw new Error('мутация упала');
    };

    // Двое падают, третий — в любом порядке прихода — должен применить своё: за каждым упавшим кто-то да стоит.
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

  it('два параллельных процесса-писателя не теряют записи', async () => {
    await createWork(project, { title: 'Авторизация' });
    const writer = (prefix: string) =>
      run(process.execPath, ['--import', tsxLoader, writerScript, project, 'w-0001', prefix, '8'], {
        env: { ...process.env, PARLEY_HOME: home },
      });

    await Promise.all([writer('a'), writer('b')]);

    const map = await readMap(project, 'w-0001');
    expect(map.sessions).toHaveLength(16);
    expect(new Set(map.sessions.map((session) => session.id)).size).toBe(16);
    expect(map.sessions.filter((session) => session.label.startsWith('a'))).toHaveLength(8);
    expect(map.sessions.filter((session) => session.label.startsWith('b'))).toHaveLength(8);
  }, 60_000);

  it('несуществующая работа — ошибка про карту, а не ENOENT про map.lock', async () => {
    const error = await updateMap(project, 'w-9999', () => {}).catch((cause: Error) => cause);

    expect(error.message).toContain(workPaths(project, 'w-9999').map);
    expect(error.message).not.toMatch(/map\.lock/);
  });

  it('карта с чужим id работы не пишется и не заводит запись в индексе', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    const alien = JSON.parse(await readFile(paths.map, 'utf8')) as WorkMap;
    alien.work.id = 'w-0777';
    await writeFile(paths.map, JSON.stringify(alien), 'utf8');

    await expect(
      updateMap(project, 'w-0001', (map) => {
        map.work.title = 'Другое';
      }),
    ).rejects.toThrow(/w-0777/);

    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual(['w-0001']);
    expect((JSON.parse(await readFile(paths.map, 'utf8')) as WorkMap).work.title).toBe(
      'Авторизация',
    );
  });

  it('отказ блокировки индекса оставляет карту прежней: ретрай не двоит запись', async () => {
    await createWork(project, { title: 'Авторизация' });
    const indexLock = path.join(home, 'works-index.lock');
    await writeFile(indexLock, '', { flag: 'wx' });
    const append = (map: WorkMap): void => {
      addSession(map, { provider: 'claude', label: 'план', task: 't' });
    };

    await expect(updateMap(project, 'w-0001', append, { lockTimeoutMs: 100 })).rejects.toThrow(
      /lock .*works-index\.lock was not released within 100 ms/,
    );

    expect((await readMap(project, 'w-0001')).sessions).toEqual([]);

    await rm(indexLock);
    await updateMap(project, 'w-0001', append);

    expect((await readMap(project, 'w-0001')).sessions).toHaveLength(1);
    expect((await readWorksIndex()).works).toHaveLength(1);
  });

  it('deleteWorkFiles при отказе блокировки индекса не удаляет каталог работы', async () => {
    await createWork(project, { title: 'Авторизация' });
    await writeFile(path.join(home, 'works-index.lock'), `${process.pid}\n`);

    await expect(deleteWorkFiles(project, 'w-0001', { lockTimeoutMs: 100 })).rejects.toBeInstanceOf(
      MapLockTimeoutError,
    );

    expect((await readMap(project, 'w-0001')).work.id).toBe('w-0001');
    expect((await readWorksIndex()).works).toHaveLength(1);
  });

  describe('осиротевшая блокировка индекса', () => {
    const deadPid = async (): Promise<number> => {
      const child = spawn(process.execPath, ['-e', '']);
      const pid = child.pid as number;
      await new Promise((resolve) => child.once('exit', resolve));
      return pid;
    };

    it('блокировка с pid умершего процесса перехватывается', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${await deadPid()}\n`);

      await createWork(project, { title: 'Авторизация' });

      expect((await readWorksIndex()).works).toHaveLength(1);
      expect(await exists(indexLock)).toBe(false);
    });

    it('пустой файл блокировки старше 10 с перехватывается', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, '');
      const old = new Date(Date.now() - 11_000);
      await utimes(indexLock, old, old);

      await createWork(project, { title: 'Авторизация' });

      expect((await readWorksIndex()).works).toHaveLength(1);
      expect(await exists(indexLock)).toBe(false);
    });

    it('пустой свежий файл блокировки не трогаем: таймаут', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, '');

      await expect(createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 })).rejects.toBeInstanceOf(
        MapLockTimeoutError,
      );
      expect(await exists(indexLock)).toBe(true);
    });

    it('блокировка с живым pid не перехватывается', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${process.pid}\n`);

      await expect(createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 })).rejects.toBeInstanceOf(
        MapLockTimeoutError,
      );
      expect(await readFile(indexLock, 'utf8')).toBe(`${process.pid}\n`);
    });

    it('висячий симлинк на месте блокировки: таймаут, а не горячий цикл', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await symlink(path.join(home, 'нет-такого-файла'), indexLock);

      const started = Date.now();
      await expect(createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 200 })).rejects.toBeInstanceOf(
        MapLockTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('живой pid при старом mtime: pid важнее возраста, блокировка не снимается', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${process.pid}\n`);
      const old = new Date(Date.now() - 60_000);
      await utimes(indexLock, old, old);

      await expect(createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 })).rejects.toBeInstanceOf(
        MapLockTimeoutError,
      );
      expect(await readFile(indexLock, 'utf8')).toBe(`${process.pid}\n`);
    });

    it('свежий guard перехвата: идёт чужой перехват, ждём до таймаута', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${await deadPid()}\n`);
      await writeFile(`${indexLock}.steal`, '');

      await expect(createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 150 })).rejects.toBeInstanceOf(
        MapLockTimeoutError,
      );
      expect(await exists(indexLock)).toBe(true);
    });

    it('guard старше 10 с — вор упал внутри: guard снимается, блокировка берётся', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${await deadPid()}\n`);
      await writeFile(`${indexLock}.steal`, '');
      const old = new Date(Date.now() - 11_000);
      await utimes(`${indexLock}.steal`, old, old);

      await createWork(project, { title: 'Авторизация' });

      expect((await readWorksIndex()).works).toHaveLength(1);
      expect(await exists(indexLock)).toBe(false);
      expect(await exists(`${indexLock}.steal`)).toBe(false);
    });

    it('releaseLock не удаляет подменённый файл блокировки', async () => {
      await createWork(project, { title: 'Авторизация' });
      const lock = workPaths(project, 'w-0001').lock;

      // Подмена синхронно внутри мутатора: асинхронный мутатор никто не ждёт.
      await updateMap(project, 'w-0001', () => {
        rmSync(lock);
        writeFileSync(lock, 'чужая блокировка');
      });

      expect(await readFile(lock, 'utf8')).toBe('чужая блокировка');
    });

    it('несколько процессов разом перехватывают одну мёртвую блокировку карты: ни одно обновление не потеряно', async () => {
      await createWork(project, { title: 'Авторизация' });
      await writeFile(workPaths(project, 'w-0001').lock, `${await deadPid()}\n`);
      const start = Date.now() + 2_500;
      const tokens = ['a', 'b', 'c', 'd', 'e', 'f'];

      await Promise.all(
        tokens.map((token) =>
          run(process.execPath, ['--import', tsxLoader, lockRaceScript, project, 'w-0001', token, String(start)], {
            env: { ...process.env, PARLEY_HOME: home },
          }),
        ),
      );

      const goal = (await readMap(project, 'w-0001')).work.goal.split(' ').filter(Boolean);
      expect([...goal].sort()).toEqual(tokens);
    }, 30_000);

    it('таймаут называет хозяина: живой pid и сколько держит', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, `${process.pid}\n`);
      const old = new Date(Date.now() - 4_000);
      await utimes(indexLock, old, old);

      const error = await createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 }).catch((cause: Error) => cause);

      expect(error).toBeInstanceOf(MapLockTimeoutError);
      expect((error as Error).message).toMatch(
        new RegExp(`was not released within 100 ms \\(held by pid ${process.pid}, alive, for [45] s\\)$`),
      );
    });

    it('таймаут: файл без pid — «no owner pid» и возраст файла', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await writeFile(indexLock, 'не-pid');
      const old = new Date(Date.now() - 3 * 3_600_000);
      await utimes(indexLock, old, old);
      await writeFile(`${indexLock}.steal`, '');

      const error = await createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 }).catch((cause: Error) => cause);

      expect((error as Error).message).toMatch(/\(no owner pid, file age 3 h\)$/);
    });

    it('таймаут: мёртвый хозяин, пока перехват идёт у другого, — «dead»', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      const dead = await deadPid();
      await writeFile(indexLock, `${dead}\n`);
      await writeFile(`${indexLock}.steal`, '');

      const error = await createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 }).catch((cause: Error) => cause);

      expect((error as Error).message).toMatch(new RegExp(`\\(held by pid ${dead}, dead, for \\d+ s\\)$`));
    });

    it('таймаут без читаемого файла блокировки — без хвоста', async () => {
      const indexLock = path.join(home, 'works-index.lock');
      await symlink(path.join(home, 'нет-такого-файла'), indexLock);

      const error = await createWork(project, { title: 'Авторизация' }, { lockTimeoutMs: 100 }).catch((cause: Error) => cause);

      expect((error as Error).message).toMatch(/was not released within 100 ms$/);
    });

    it('взятая блокировка содержит pid текущего процесса', async () => {
      await createWork(project, { title: 'Авторизация' });
      let mapLock = '';
      await updateMap(project, 'w-0001', () => {
        mapLock = readFileSync(workPaths(project, 'w-0001').lock, 'utf8');
      });

      expect(mapLock).toBe(`${process.pid}\n`);
    });
  });

  it('два параллельных процесса создают разные работы в индексе', async () => {
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

/** Отодвигает `work.updatedAt` в прошлое прямо на диске: иначе «не сдвинулся» не отличить от той же миллисекунды. */
async function ageWork(workId: string, at = '2020-01-01T00:00:00.000Z'): Promise<string> {
  const file = workPaths(project, workId).map;
  const raw = JSON.parse(await readFile(file, 'utf8')) as WorkMap;
  raw.work.updatedAt = at;
  await writeFile(file, JSON.stringify(raw), 'utf8');
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

describe('updateMap: работы нет — WorkNotFoundError', () => {
  it('работы нет с самого начала', async () => {
    await expect(updateMap(project, 'w-9999', () => {})).rejects.toBeInstanceOf(WorkNotFoundError);
  });

  it('работа удалена, пока запись ждала map.lock (раунд исправлений 1, находка 2)', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    // Лок занят «другим писателем» — запись встанет в ожидание уже после проверки карты.
    const held = await open(paths.lock, 'wx');
    const pending = updateMap(project, 'w-0001', (map) => (map.work.goal = 'x'));
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await held.close();
    // Каталог уходит одним rename, как если бы его убрал другой процесс: `rm -r` удалял бы его по
    // частям, и ожидание лока успевало снова создать в нём map.lock — тогда падал бы сам rm
    // (ENOTEMPTY), а не запись (флейк под нагрузкой и на машинах CI).
    const gone = `${paths.dir}.gone`;
    await rename(paths.dir, gone);
    await rm(gone, { recursive: true, force: true });

    expect(await outcome).toBeInstanceOf(WorkNotFoundError);
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
  it('битый json — ошибка, догадки не строим', async () => {
    await writeFile(worksIndexPath(), '{ сломано', 'utf8');

    await expect(readWorksIndex()).rejects.toThrow(/workspace index .* cannot be parsed: /);
  });

  it('чужая форма или другая версия схемы — ошибка', async () => {
    await writeFile(worksIndexPath(), '{"schemaVersion":2,"works":[]}', 'utf8');
    await expect(readWorksIndex()).rejects.toThrow(
      /workspace index .* cannot be parsed: unexpected shape/,
    );

    await writeFile(worksIndexPath(), '{"schemaVersion":1}', 'utf8');
    await expect(readWorksIndex()).rejects.toThrow(
      /workspace index .* cannot be parsed: unexpected shape/,
    );
  });
});

describe('pruneWorksIndex', () => {
  it('убирает из индекса записи, у которых карты на диске больше нет', async () => {
    const kept = await createWork(project, { title: 'Живая' });
    const gone = await createWork(other, { title: 'Снесённая' });
    await rm(workPaths(other, gone.work.id).dir, { recursive: true, force: true });

    const removed = await pruneWorksIndex();

    expect(removed).toEqual([expect.objectContaining({ id: gone.work.id, projectPath: other })]);
    const { works } = await readWorksIndex();
    expect(works.map((work) => [work.projectPath, work.id])).toEqual([[project, kept.work.id]]);
  });

  it('целый индекс не трогает и ничего не возвращает', async () => {
    await createWork(project, { title: 'Живая' });
    const before = await readFile(worksIndexPath(), 'utf8');

    expect(await pruneWorksIndex()).toEqual([]);
    expect(await readFile(worksIndexPath(), 'utf8')).toBe(before);
  });
});

describe('deleteWorkFiles', () => {
  it('сносит каталог работы целиком и снимает её запись из индекса', async () => {
    const kept = await createWork(project, { title: 'Живая' });
    const gone = await createWork(project, { title: 'Лишняя' });
    const paths = workPaths(project, gone.work.id);
    await writeFile(path.join(paths.artifacts, 'plan.md'), 'план\n', 'utf8');

    await deleteWorkFiles(project, gone.work.id);

    expect(await exists(paths.dir)).toBe(false);
    expect(await exists(workPaths(project, kept.work.id).map)).toBe(true);
    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual([kept.work.id]);
  });

  it('каталога уже нет — запись из индекса всё равно уходит, ошибки нет', async () => {
    const gone = await createWork(project, { title: 'Снесённая' });
    await rm(workPaths(project, gone.work.id).dir, { recursive: true, force: true });

    await deleteWorkFiles(project, gone.work.id);

    expect((await readWorksIndex()).works).toEqual([]);
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
