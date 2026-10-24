import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb, workDb } from './db.js';
import { addSession } from './map.js';
import { createWork, readStoredMap, replaceStoredMap, updateMap, workPaths } from './store.js';
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
  /**
   * Ждём события, повторяя действие: рекурсивный fs.watch прогревается не мгновенно
   * (та же причина, что и в watch.test.ts).
   */
  async function expectWorks(
    seen: WorkEntry[][],
    poke: () => Promise<void>,
    predicate: (works: WorkEntry[]) => boolean,
    timeoutMs = 15_000,
  ): Promise<WorkEntry[]> {
    const started = Date.now();
    for (;;) {
      await poke();

      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        const found = seen.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (Date.now() - started > timeoutMs) throw new Error('события не дождались');
    }
  }

  it('перечитывает работы после изменения карты', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), project, { debounceMs: 10 });

    try {
      const works = await expectWorks(
        seen,
        () =>
          updateMap(project, created.work.id, (map) => {
            map.work.goal = 'логин по e-mail';
          }).then(() => undefined),
        (list) => list[0]?.map.work.goal === 'логин по e-mail',
      );
      expect(works).toHaveLength(1);
    } finally {
      watcher.close();
    }
  });

  it('после close колбэк больше не зовётся', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), project, { debounceMs: 10 });
    watcher.close();

    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'после закрытия';
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    const watcher = watchWorks((works) => seen.push(works), project, {
      debounceMs: 10,
      read: async (projectPath) => {
        reads += 1;
        if (reads === 1) await gate;
        return readWorks(projectPath);
      },
    });

    try {
      let n = 0;
      const started = Date.now();
      // Прогрев fs.watch: пишем, пока первое чтение не началось.
      while (reads === 0) {
        n += 1;
        await updateMap(project, created.work.id, (map) => {
          map.work.goal = `цель ${n}`;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (Date.now() - started > 15_000) throw new Error('события не дождались');
      }
      // Первое чтение держится, а записи идут: каждая шлёт события карты и индекса.
      for (let i = 0; i < 5; i += 1) {
        await updateMap(project, created.work.id, (map) => {
          map.work.goal = `во время чтения ${i}`;
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reads).toBe(1);

      release();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(reads).toBe(2);
      expect(seen.at(-1)?.[0]?.map.work.goal).toBe('во время чтения 4');
    } finally {
      watcher.close();
    }
  });

  it('без watchHome запись базы в доме читать не заставляет: карты в каталоге проекта больше нет, следить там не за чем', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    const watcher = watchWorks(() => {}, project, {
      debounceMs: 10,
      watchHome: false,
      read: async (projectPath) => {
        reads += 1;
        return readWorks(projectPath);
      },
    });

    try {
      for (let n = 0; n < 5; n += 1) {
        await updateMap(project, created.work.id, (map) => {
          map.work.goal = `цель ${n}`;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(reads).toBe(0);
    } finally {
      watcher.close();
    }
  });

  it('ошибка чтения не останавливает наблюдателя: следующее событие читает снова; бросок read синхронно — тоже', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    const errors: unknown[] = [];
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), project, {
      debounceMs: 10,
      onError: (error) => errors.push(error),
      read: (projectPath) => {
        reads += 1;
        if (reads === 1) throw new Error('синхронный бросок');
        if (reads === 2) return Promise.reject(new Error('отказ чтения'));
        return readWorks(projectPath);
      },
    });
    try {
      await expectWorks(
        seen,
        () =>
          updateMap(project, created.work.id, (map) => {
            map.work.goal = `цель ${reads}`;
          }).then(() => undefined),
        (list) => list.length === 1,
      );
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
    const watcher = watchWorks((works) => seen.push(works), project, {
      debounceMs: 10,
      read: async (projectPath) => {
        reads += 1;
        await gate;
        return readWorks(projectPath);
      },
    });
    const started = Date.now();
    let n = 0;
    while (reads === 0) {
      n += 1;
      await updateMap(project, created.work.id, (map) => {
        map.work.goal = `цель ${n}`;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (Date.now() - started > 15_000) throw new Error('события не дождались');
    }
    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'во время чтения';
    });
    watcher.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual([]);
    expect(reads).toBe(1);
  });
});
