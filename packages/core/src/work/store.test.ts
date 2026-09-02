import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import {
  createWork,
  readMap,
  readWorksIndex,
  updateMap,
  workPaths,
  worksIndexPath,
} from './store.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
/** Пишущий скрипт запускается отдельным процессом через tsx: настоящая параллельность. */
const writerScript = fileURLToPath(new URL('../../test/work-writer.ts', import.meta.url));
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

let home = '';
let project = '';
let other = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  other = await mkdtemp(path.join(tmpdir(), 'harnas-other-'));
  process.env.HARNAS_HOME = home;
});

afterEach(async () => {
  delete process.env.HARNAS_HOME;
  await Promise.all([home, project, other].map((dir) => rm(dir, { recursive: true, force: true })));
});

const isDirectory = async (dir: string): Promise<boolean> => (await stat(dir)).isDirectory();

describe('createWork', () => {
  it('создаёт раскладку на диске и запись в глобальном индексе', async () => {
    const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
    const paths = workPaths(project, 'w-0001');

    expect(map.schemaVersion).toBe(1);
    expect(map.work.id).toBe('w-0001');
    expect(map.work.status).toBe('active');
    expect(map.sessions).toEqual([]);
    expect(map.messages).toEqual([]);
    expect(paths.dir).toBe(path.join(project, '.harnas', 'works', 'w-0001'));
    expect(await isDirectory(paths.briefs)).toBe(true);
    expect(await isDirectory(paths.artifacts)).toBe(true);
    expect(await readMap(project, 'w-0001')).toEqual(map);

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
    // Индекс глобальный и может быть пуст: clone проекта с закоммиченным .harnas,
    // перенос HARNAS_HOME, копия проекта. Карта w-0001 при этом на диске есть.
    await rm(worksIndexPath());

    const second = await createWork(project, { title: 'Вторая' });

    expect(second.work.id).toBe('w-0002');
    const first = await readMap(project, 'w-0001');
    expect(first.work.title).toBe('Первая');
    expect(first.sessions).toHaveLength(1);
  });
});

describe('updateMap', () => {
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
    expect(await readMap(project, 'w-0001')).toEqual(updated);
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
    ).rejects.toThrow(/не парсится/);

    expect(await readFile(paths.map, 'utf8')).toBe('{ сломано');
    expect(await readFile(paths.bak, 'utf8')).toBe(before);
  });

  it('занятая блокировка — ошибка, а не ожидание', async () => {
    await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, 'w-0001');
    await writeFile(paths.lock, '', { flag: 'wx' });

    const started = Date.now();
    await expect(
      updateMap(project, 'w-0001', (map) => (map.work.title = 'Другое'), { lockTimeoutMs: 150 }),
    ).rejects.toThrow(/блокировк/i);

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

  it('два параллельных процесса-писателя не теряют записи', async () => {
    await createWork(project, { title: 'Авторизация' });
    const writer = (prefix: string) =>
      run(process.execPath, ['--import', tsxLoader, writerScript, project, 'w-0001', prefix, '8'], {
        env: { ...process.env, HARNAS_HOME: home },
      });

    await Promise.all([writer('a'), writer('b')]);

    const map = await readMap(project, 'w-0001');
    expect(map.sessions).toHaveLength(16);
    expect(new Set(map.sessions.map((session) => session.id)).size).toBe(16);
    expect(map.sessions.filter((session) => session.label.startsWith('a'))).toHaveLength(8);
    expect(map.sessions.filter((session) => session.label.startsWith('b'))).toHaveLength(8);
  }, 60_000);

  it('два параллельных процесса создают разные работы в индексе', async () => {
    const creator = (title: string) =>
      run(
        process.execPath,
        ['--import', tsxLoader, writerScript, project, 'new-work', title, '0'],
        {
          env: { ...process.env, HARNAS_HOME: home },
        },
      );

    await Promise.all([creator('первая'), creator('вторая')]);

    const index = await readWorksIndex();
    expect(index.works.map((work) => work.id).sort()).toEqual(['w-0001', 'w-0002']);
    expect(index.works.map((work) => work.title).sort()).toEqual(['вторая', 'первая']);
  }, 60_000);
});
