import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import type { WorkMap } from './types.js';
import {
  createWork,
  deleteSessionFiles,
  deleteWorkFiles,
  pruneWorksIndex,
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

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

describe('песочница тестов', () => {
  it('без HARNAS_HOME дом уходит во временный каталог, а не в настоящий ~/.harnas', () => {
    // Жёсткое правило задания: настоящие ~/.harnas и ~/.claude тесты не трогают.
    // Запись из недосчитанного промиса случается и после `afterEach` (см.
    // `test/sandbox-home.ts`), поэтому проверяем сам запасной путь.
    delete process.env.HARNAS_HOME;
    expect(worksIndexPath().startsWith(tmpdir())).toBe(true);
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
    expect(await readMap(project, 'w-0001')).toEqual(updated);
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
      /блокировк/i,
    );

    expect((await readMap(project, 'w-0001')).sessions).toEqual([]);

    await rm(indexLock);
    await updateMap(project, 'w-0001', append);

    expect((await readMap(project, 'w-0001')).sessions).toHaveLength(1);
    expect((await readWorksIndex()).works).toHaveLength(1);
  });

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

describe('readWorksIndex', () => {
  it('битый json — ошибка, догадки не строим', async () => {
    await writeFile(worksIndexPath(), '{ сломано', 'utf8');

    await expect(readWorksIndex()).rejects.toThrow(/не парсится/);
  });

  it('чужая форма или другая версия схемы — ошибка', async () => {
    await writeFile(worksIndexPath(), '{"schemaVersion":2,"works":[]}', 'utf8');
    await expect(readWorksIndex()).rejects.toThrow(/не парсится/);

    await writeFile(worksIndexPath(), '{"schemaVersion":1}', 'utf8');
    await expect(readWorksIndex()).rejects.toThrow(/не парсится/);
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
});
