import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorkDb, WORK_DB_FILE, workDb } from './db.js';
import { addSession } from './map.js';
import { createWork, deleteWorkFiles, parleyHome, readStoredMap, replaceStoredMap, updateMap, workDataVersion, workPaths } from './store.js';
import type { Room } from './types.js';
import { readWorks, watchWorks, type WorkEntry } from './works.js';

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

const titles = (works: WorkEntry[]): string[] => works.map((entry) => entry.map.work.title);

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

/** Строка работы целиком: так тест «убирает» работу и возвращает её под той же версией, как сделал бы другой процесс. */
const takeRow = (projectPath: string, workId: string): (() => void) => {
  const row = workDb()
    .prepare('SELECT * FROM works WHERE project_path = ? AND id = ?')
    .get(projectPath, workId) as Record<string, string | number>;
  workDb().prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(projectPath, workId);
  return () => {
    workDb()
      .prepare(
        `INSERT INTO works (project_path, id, title, status, updated_at, version, work_json, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(row['project_path']),
        String(row['id']),
        String(row['title']),
        String(row['status']),
        String(row['updated_at']),
        Number(row['version']),
        String(row['work_json']),
        String(row['extra_json']),
      );
  };
};

describe('readWorks', () => {
  it('отдаёт работы текущего проекта и работы других проектов из базы', async () => {
    await createWork(project, { title: 'Авторизация' });
    await createWork(other, { title: 'Редизайн' });

    const works = await readWorks(project);

    expect(titles(works).sort()).toEqual(['Авторизация', 'Редизайн']);
    const mine = works.find((entry) => entry.map.work.title === 'Авторизация');
    expect(mine?.projectPath).toBe(project);
    expect(works.find((entry) => entry.map.work.title === 'Редизайн')?.projectPath).toBe(other);
  });

  it('список один на всю базу: прежний works-index.json в доме на него не влияет, каталоги проектов не читаются', async () => {
    await createWork(project, { title: 'Авторизация' });
    await writeFile(
      path.join(home, 'works-index.json'),
      '{"schemaVersion":1,"works":[]}\n',
      'utf8',
    );

    expect(titles(await readWorks(project))).toEqual(['Авторизация']);
    // Проект, в котором работ нет, список не сужает.
    expect(titles(await readWorks(path.join(other, 'нет-такого')))).toEqual(['Авторизация']);
  });

  it('одна и та же работа не двоится', async () => {
    await createWork(project, { title: 'Авторизация' });
    expect(await readWorks(project)).toHaveLength(1);
  });

  it('работа, которую normalizeMap не принимает, в список не попадает и не уносит остальные', async () => {
    await createWork(project, { title: 'Авторизация' });
    const broken = await createWork(project, { title: 'Битая' });
    const stored = readStoredMap(project, broken.work.id);
    stored.rooms.push(bogusRoom());
    replaceStoredMap(project, broken.work.id, stored);
    await createWork(other, { title: 'Редизайн' });

    expect(titles(await readWorks(project)).sort()).toEqual(['Авторизация', 'Редизайн']);
  });

  it('работа без каталога на диске остаётся в списке: снимает её только prune', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await rm(workPaths(project, created.work.id).dir, { recursive: true, force: true });

    expect(titles(await readWorks(project))).toEqual(['Авторизация']);
  });

  it('видит сессии, добавленные в карту', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const works = await readWorks(project);
    expect(works[0]?.map.sessions.map((session) => session.label)).toEqual(['бэкенд']);
  });

  it('неизменённая карта второй раз не разбирается, изменённая — разбирается', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const first = (await readWorks(project))[0];
    expect(first?.bytes).toBeGreaterThan(0);

    const second = (await readWorks(project))[0];
    expect(second?.bytes).toBe(0);
    expect(second?.map).toBe(first?.map);

    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'логин по e-mail';
    });
    const third = (await readWorks(project))[0];
    expect(third?.bytes).toBeGreaterThan(0);
    expect(third?.map.work.goal).toBe('логин по e-mail');
    expect((await readWorks(project))[0]?.bytes).toBe(0);
  });

  it('запись одной работы не сбрасывает кэш остальных: версия у каждой своя', async () => {
    const first = await createWork(project, { title: 'Первая' });
    await createWork(other, { title: 'Вторая' });
    await readWorks(project);

    await updateMap(project, first.work.id, (map) => {
      map.work.goal = 'новая цель';
    });
    const works = await readWorks(project);

    expect(works.map((entry) => [entry.map.work.title, entry.bytes === 0])).toEqual([
      ['Первая', false],
      ['Вторая', true],
    ]);
  });

  it('разобранная карта в тестах заморожена: правка «на месте» бросает, а не портит общий объект', async () => {
    await createWork(project, { title: 'Авторизация' });
    const [entry] = await readWorks(project);
    expect(() => {
      (entry?.map.work as { title: string }).title = 'испорчено';
    }).toThrow(TypeError);
    expect(() => entry?.map.sessions.push({} as never)).toThrow(TypeError);
  });

  it('заморозка касается копии списка: readMap и updateMap живут своими объектами', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await readWorks(project);

    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'правится свободно';
    });

    expect((await readWorks(project))[0]?.map.work.goal).toBe('правится свободно');
  });

  it('карта работы, пропавшей из списка, из кэша уходит: вернулась с той же версией — разбирается заново', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    expect((await readWorks(project))[0]?.bytes).toBeGreaterThan(0);
    expect((await readWorks(project))[0]?.bytes).toBe(0);
    const restore = takeRow(project, created.work.id);
    expect(await readWorks(project)).toEqual([]);
    restore();
    expect((await readWorks(project))[0]?.bytes).toBeGreaterThan(0);
  });

  it('без единой работы список пуст', async () => {
    expect(await readWorks(project)).toEqual([]);
  });
});

describe('watchWorks', () => {
  /** Второе соединение с той же базой: для наблюдателя это запись другого процесса (CLI, MCP агента без канала). */
  const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const foreignConnection = (): InstanceType<typeof Database> => new Database(path.join(parleyHome(), WORK_DB_FILE));

  /** Чужая запись одной работы: правит `work.goal` и поднимает версию, как сделал бы `updateMap` в другом процессе. */
  const foreignGoal = (projectPath: string, workId: string, goal: string): void => {
    const foreign = foreignConnection();
    try {
      const row = foreign
        .prepare('SELECT work_json FROM works WHERE project_path = ? AND id = ?')
        .get(projectPath, workId) as { work_json: string };
      const work = JSON.parse(row.work_json) as { goal: string };
      work.goal = goal;
      foreign
        .prepare('UPDATE works SET work_json = ?, version = version + 1 WHERE project_path = ? AND id = ?')
        .run(JSON.stringify(work), projectPath, workId);
    } finally {
      foreign.close();
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Опрос data_version нужен только тестам про чужие записи: остальным он мешал бы, поэтому там он «выключен» большим периодом. */
  const NO_POLL = 600_000;

  it('перечитывает работы по записи этого процесса — без опроса и без файлов', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 10, pollMs: NO_POLL });

    try {
      await updateMap(project, created.work.id, (map) => {
        map.work.goal = 'логин по e-mail';
      });
      await vi.waitFor(() => expect(seen.at(-1)?.[0]?.map.work.goal).toBe('логин по e-mail'), {
        timeout: 2000,
        interval: 10,
      });
      expect(seen.at(-1)).toHaveLength(1);
    } finally {
      watcher.close();
    }
  });

  it('создание и снятие работы в этом процессе тоже будят наблюдателя', async () => {
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 10, pollMs: NO_POLL });

    try {
      const created = await createWork(project, { title: 'Авторизация' });
      await vi.waitFor(() => expect(seen.at(-1)).toHaveLength(1), { timeout: 2000, interval: 10 });

      await deleteWorkFiles(project, created.work.id);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual([]), { timeout: 2000, interval: 10 });
    } finally {
      watcher.close();
    }
  });

  it('запись другого соединения видна опросом data_version', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 10, pollMs: 20 });

    try {
      foreignGoal(project, created.work.id, 'чужая цель');
      await vi.waitFor(() => expect(seen.at(-1)?.[0]?.map.work.goal).toBe('чужая цель'), {
        timeout: 2000,
        interval: 10,
      });
    } finally {
      watcher.close();
    }
  });

  it('работа, снятая другим соединением, пропадает из списка', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await createWork(other, { title: 'Остаётся' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 10, pollMs: 20 });

    try {
      const foreign = foreignConnection();
      try {
        foreign.prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, created.work.id);
      } finally {
        foreign.close();
      }
      await vi.waitFor(() => expect(titles(seen.at(-1) ?? [])).toEqual(['Остаётся']), { timeout: 2000, interval: 10 });
    } finally {
      watcher.close();
    }
  });

  it('чужая запись, не тронувшая версий работ, чтение не запускает', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    const watcher = watchWorks(() => {}, {
      debounceMs: 10,
      pollMs: 20,
      read: async () => {
        reads += 1;
        return readWorks();
      },
    });

    try {
      const dataVersion = workDataVersion();
      const foreign = foreignConnection();
      try {
        // Коммит есть (data_version сменится), а версия строки `works` та же.
        foreign.prepare('UPDATE works SET title = ? WHERE id = ?').run('другой заголовок', created.work.id);
      } finally {
        foreign.close();
      }
      expect(workDataVersion()).not.toBe(dataVersion);
      await sleep(300);
      expect(reads).toBe(0);
    } finally {
      watcher.close();
    }
  });

  it('после close колбэк больше не зовётся, ни на событие, ни на опрос', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 10, pollMs: 20 });
    watcher.close();

    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'после закрытия';
    });
    foreignGoal(project, created.work.id, 'чужая после закрытия');
    await sleep(300);
    expect(seen).toEqual([]);
  });

  it('события во время чтения дают одно повторное чтение, а не по чтению на событие', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), {
      debounceMs: 10,
      pollMs: NO_POLL,
      read: async () => {
        reads += 1;
        if (reads === 1) await gate;
        return readWorks();
      },
    });

    try {
      await updateMap(project, created.work.id, (map) => {
        map.work.goal = 'первая запись';
      });
      await vi.waitFor(() => expect(reads).toBe(1), { timeout: 2000, interval: 10 });
      // Первое чтение держится, а записи идут: каждая шлёт событие.
      for (let i = 0; i < 5; i += 1) {
        await updateMap(project, created.work.id, (map) => {
          map.work.goal = `во время чтения ${i}`;
        });
      }
      await sleep(200);
      expect(reads).toBe(1);

      release();
      await vi.waitFor(() => expect(reads).toBe(2), { timeout: 2000, interval: 10 });
      await sleep(200);
      expect(reads).toBe(2);
      expect(seen.at(-1)?.[0]?.map.work.goal).toBe('во время чтения 4');
    } finally {
      watcher.close();
    }
  });

  it('ошибка чтения не останавливает наблюдателя: следующее событие читает снова; бросок read синхронно — тоже', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    const errors: unknown[] = [];
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), {
      debounceMs: 10,
      pollMs: NO_POLL,
      onError: (error) => errors.push(error),
      read: () => {
        reads += 1;
        if (reads === 1) throw new Error('синхронный бросок');
        if (reads === 2) return Promise.reject(new Error('отказ чтения'));
        return readWorks();
      },
    });
    try {
      for (let n = 0; n < 3; n += 1) {
        await updateMap(project, created.work.id, (map) => {
          map.work.goal = `цель ${n}`;
        });
        await sleep(60);
      }
      await vi.waitFor(() => expect(seen.at(-1)).toHaveLength(1), { timeout: 2000, interval: 10 });
      expect(errors).toHaveLength(2);
    } finally {
      watcher.close();
    }
  });

  it('close посреди чтения: результат не отдаётся и повтор не планируется', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), {
      debounceMs: 10,
      pollMs: NO_POLL,
      read: async () => {
        reads += 1;
        await gate;
        return readWorks();
      },
    });
    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'первая запись';
    });
    await vi.waitFor(() => expect(reads).toBe(1), { timeout: 2000, interval: 10 });
    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'во время чтения';
    });
    watcher.close();
    release();
    await sleep(200);
    expect(seen).toEqual([]);
    expect(reads).toBe(1);
  });

  it('сбой опроса (база дома недоступна) — одно сообщение, а не по одному на каждый опрос', async () => {
    await createWork(project, { title: 'Авторизация' });
    const errors: unknown[] = [];
    const watcher = watchWorks(() => {}, { debounceMs: 10, pollMs: 20, onError: (error) => errors.push(error) });
    const blocker = path.join(home, 'не-каталог');
    await writeFile(blocker, '');
    process.env.PARLEY_HOME = path.join(blocker, 'дом');

    try {
      await sleep(250);
      expect(errors).toHaveLength(1);
    } finally {
      process.env.PARLEY_HOME = home;
      watcher.close();
    }
  });
});
