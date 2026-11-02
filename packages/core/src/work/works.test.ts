import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorkDb, WORK_DB_FILE, workDb } from './db.js';
import { writeLetters, type NewLetter } from './letter-store.js';
import { addSession } from './map.js';
import { addRoom } from './rooms.js';
import { createWork, deleteWorkFiles, parleyHome, readStoredMap, replaceStoredMap, updateMap, workDataVersion, workPaths, workVersion, workVersionKey } from './store.js';
import type { Room } from './types.js';
import { captureWorks, readWorks, watchWorks, type WorkEntry } from './works.js';

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

  it('у каждой работы списка версия базы, под которой взята карта: та же версия — та же карта, запись её меняет', async () => {
    const first = await createWork(project, { title: 'Первая' });
    const second = await createWork(other, { title: 'Вторая' });
    const versionsOf = async (): Promise<Array<number | undefined>> => (await readWorks(project)).map((entry) => entry.version);

    const before = await versionsOf();
    expect(before).toEqual([workVersion(project, first.work.id), workVersion(other, second.work.id)]);
    // Повторное чтение из кэша списка — те же номера.
    expect(await versionsOf()).toEqual(before);

    await updateMap(project, first.work.id, (map) => {
      map.work.goal = 'новая цель';
    });
    const after = await versionsOf();
    expect(after[0]).toBe(workVersion(project, first.work.id));
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
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

  /** Работа с комнатой r-01 (создатель s-01, участник s-02): письма пишутся в неё. */
  const seedRoom = async (): Promise<string> => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-02'] }, '2026-10-24T00:00:00.000Z');
    });
    return created.work.id;
  };

  const roomLetter = (text: string): NewLetter => ({ from: 's-01', to: [], roomId: 'r-01', text, kind: 'note' });

  it('запись только писем не будит наблюдателя (спека rooms.mail 6.7)', async () => {
    const workId = await seedRoom();
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 5, pollMs: 20 });

    try {
      writeLetters(project, workId, (letters) => {
        letters.add(roomLetter('первое'));
      });
      writeLetters(project, workId, (letters) => {
        letters.add(roomLetter('второе'));
      });
      await sleep(100);

      // Наблюдатель стартового чтения не делает: его первый вызов — это уже ответ на запись.
      expect(seen).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('смешанная запись, письма вместе с комнатой, будит наблюдателя', async () => {
    const workId = await seedRoom();
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 5, pollMs: 20 });

    try {
      await updateMap(project, workId, (map, letters) => {
        addRoom(map, { title: 'фронт', creator: 's-01', members: ['s-02'] }, '2026-10-24T00:00:00.000Z');
        letters.add(roomLetter('в новой комнате'));
      });

      await vi.waitFor(() => expect(seen.at(-1)?.[0]?.map.rooms).toHaveLength(2), { timeout: 2000, interval: 10 });
    } finally {
      watcher.close();
    }
  });

  it('запись только писем из другого соединения будит наблюдателя опросом', async () => {
    const workId = await seedRoom();
    writeLetters(project, workId, (letters) => {
      letters.add(roomLetter('будет помечено'));
    });
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 5, pollMs: 20 });

    try {
      // Так выглядит для наблюдателя `writeLetters` другого процесса: строки писем и версия работы в одной транзакции.
      const foreign = foreignConnection();
      try {
        foreign.exec('BEGIN IMMEDIATE');
        foreign.prepare('UPDATE messages SET deleted = 1 WHERE project_path = ? AND work_id = ?').run(project, workId);
        foreign.prepare('UPDATE works SET version = version + 1 WHERE project_path = ? AND id = ?').run(project, workId);
        foreign.exec('COMMIT');
      } finally {
        foreign.close();
      }

      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000, interval: 10 });
    } finally {
      watcher.close();
    }
  });

  it('запись только писем после чужой, которую опрос ещё не разобрал, будит наблюдателя', async () => {
    const workId = await seedRoom();
    const seen: WorkEntry[][] = [];
    // Опрос выключен: будить может только событие своей записи, и оно обязано заметить, что версия до неё не та, что известна наблюдателю.
    const watcher = watchWorks((works) => seen.push(works), { debounceMs: 5, pollMs: NO_POLL });

    try {
      foreignGoal(project, workId, 'чужая цель');
      writeLetters(project, workId, (letters) => {
        letters.add(roomLetter('после чужой записи'));
      });

      await vi.waitFor(() => expect(seen.at(-1)?.[0]?.map.work.goal).toBe('чужая цель'), { timeout: 2000, interval: 10 });
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

  it('чтение без версии работы повторяется: без новой записи onWorks зовётся дважды, с точной версией во второй раз', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    let reads = 0;
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks((works) => seen.push(works), {
      debounceMs: 10,
      pollMs: NO_POLL,
      // Первое чтение «вклинилось в запись»: список без версии работы. Второе точное.
      read: async () => {
        reads += 1;
        const works = await readWorks();
        if (reads > 1) return works;
        return works.map((work) => {
          const bare = { ...work };
          delete bare.version;
          return bare;
        });
      },
    });

    try {
      await updateMap(project, created.work.id, (map) => {
        map.work.goal = 'единственная запись';
      });
      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 2000, interval: 10 });
      // Повтор один: во втором чтении версия есть, и третьего чтения никто не просит.
      await sleep(200);
      expect(reads).toBe(2);
      expect(seen).toHaveLength(2);
      expect(seen[0]?.[0]?.version).toBeUndefined();
      expect(seen[1]?.[0]?.version).toBe(workVersion(project, created.work.id));
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

  it('сбой чтения версий при смене data_version — одно сообщение на серию; после удачного опроса новый сбой снова сообщается', async () => {
    await createWork(project, { title: 'Авторизация' });
    const errors: unknown[] = [];
    const watcher = watchWorks(() => {}, { debounceMs: 10, pollMs: 20, onError: (error) => errors.push(error) });

    /** Чужое соединение переименовывает таблицу: data_version сменится, а запрос версий работ упадёт. */
    const foreignRename = (from: string, to: string): void => {
      const foreign = foreignConnection();
      try {
        foreign.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
      } finally {
        foreign.close();
      }
    };

    try {
      foreignRename('works', 'works_away');
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 2000, interval: 10 });
      // data_version не запомнен, и каждый следующий опрос снова падает на том же запросе — но молча.
      await sleep(250);
      expect(errors).toHaveLength(1);

      foreignRename('works_away', 'works');
      await sleep(150);
      expect(errors).toHaveLength(1);

      foreignRename('works', 'works_away');
      await vi.waitFor(() => expect(errors).toHaveLength(2), { timeout: 2000, interval: 10 });
      await sleep(250);
      expect(errors).toHaveLength(2);
    } finally {
      watcher.close();
    }
  });
});


describe('bounded coherent work observation', () => {
  it('owns a coherent version/map and invalidates catalogue/lifetime changes, not later ordinary writes', async () => {
    const a = await createWork(project, { title: 'a' }), b = await createWork(other, { title: 'b' });
    const captured = captureWorks(entry => entry);
    expect(captured.values.map(entry => entry.map.work.id)).toEqual([a.work.id, b.work.id]);
    expect(captured.values[0]!.version).toBe(workVersion(project, a.work.id));
    await updateMap(project, a.work.id, map => { map.work.goal = 'new'; });
    expect(captured.isCurrent()).toBe(true);
    expect(captured.values[0]!.map.work.goal).not.toBe('new');
    const fresh = captureWorks(entry => entry);
    expect(fresh.values[0]!.map.work.goal).toBe('new');
    await createWork(project, { title: 'added' }); expect(captured.isCurrent()).toBe(false);
    const beforeDelete = captureWorks(entry => entry);
    await deleteWorkFiles(other, b.work.id); expect(beforeDelete.isCurrent()).toBe(false);
  });

  it.each([25, 75, 100])('never postpones first admission under %ims invalidations and coalesces in-flight follow-up', async interval => {
    const created = await createWork(project, { title: 'hot' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let release!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const watcher = watchWorks(() => {}, { debounceMs: 100, pollMs: 10000, read: async () => { reads += 1; if (reads === 1) await gate; return readWorks(); } });
    try {
      for (let elapsed = 0; elapsed < 300; elapsed += interval) {
        await updateMap(project, created.work.id, map => { map.work.goal = String(elapsed); });
        await vi.advanceTimersByTimeAsync(interval);
        if (elapsed + interval >= 100) expect(reads).toBe(1);
      }
      release(); await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(300); expect(reads).toBe(2);
      await updateMap(project, created.work.id, map => { map.work.goal = 'closed'; });
      watcher.close(); await vi.advanceTimersByTimeAsync(300); expect(reads).toBe(2);
    } finally { watcher.close(); vi.useRealTimers(); }
  });
});


it('coherent capture isolates corrupt maps without hiding healthy works', async () => {
  const a = await createWork(project, { title: 'corrupt' }), b = await createWork(other, { title: 'healthy' });
  workDb().prepare('UPDATE works SET work_json = ?, version = version + 1 WHERE project_path = ? AND id = ?').run('{', project, a.work.id);
  const captured = captureWorks(entry => entry);
  expect(captured.values.map(entry => entry.map.work.id)).toEqual([b.work.id]);
  expect(captured.isCurrent()).toBe(true);
});


it('distinguishes same-clock same-key/version/birth/rowid recreations and invalidates captures on connection replacement', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1900000000000);
  try {
    const a = await createWork(project, { title: 'life A' });
    const versionKey = workVersionKey(project, a.work.id);
    const captured = captureWorks(entry => entry), before = await readWorks();
    await deleteWorkFiles(project, a.work.id);
    const b = await createWork(project, { title: 'life B' });
    expect(b.work.id).toBe(a.work.id); expect(b.work.createdAt).toBe(a.work.createdAt);
    expect(workVersionKey(project, b.work.id)).not.toBe(versionKey);
    expect(workVersion(project, b.work.id)).toBe(captured.values[0]!.version);
    expect(captured.isCurrent()).toBe(false);
    const current = captureWorks(entry => entry);
    expect(current.values[0]!.incarnation).toBeGreaterThan(captured.values[0]!.incarnation);
    expect(current.values[0]!.map.work.title).toBe('life B');
    expect((await readWorks())[0]!.map.work.title).toBe('life B');
    expect((await readWorks())[0]!.map).not.toBe(before[0]!.map);
    closeWorkDb();
    expect(current.isCurrent()).toBe(false);
    expect(captureWorks(entry => entry).values[0]!.map).not.toBe(current.values[0]!.map);
  } finally { vi.useRealTimers(); }
});

it('observes foreign equal-version reincarnation and cannot hit an old underlying map cache', async () => {
  const a = await createWork(project, { title: 'life A' }); await createWork(other, { title: 'other' });
  await readWorks();
  const captured = captureWorks(entry => entry), seen: WorkEntry[][] = [];
  const watcher = watchWorks(works => seen.push(works), { debounceMs: 5, pollMs: 10 });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path.join(home, WORK_DB_FILE));
  try {
    const row = db.prepare('SELECT * FROM works WHERE project_path = ? AND id = ?').get(project, a.work.id)!;
    const work = JSON.parse(String(row['work_json'])); work.title = 'life B';
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    db.prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, a.work.id);
    db.prepare('INSERT INTO works(project_path,id,title,status,updated_at,version,work_json,extra_json) VALUES(?,?,?,?,?,?,?,?)').run(project,a.work.id,'life B',row['status']!,row['updated_at']!,row['version']!,JSON.stringify(work),row['extra_json']!);
    db.exec('COMMIT');
    expect(captured.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(seen.at(-1)?.find(entry => entry.map.work.id === a.work.id)?.map.work.title).toBe('life B'));
    expect(captureWorks(entry => entry).values.find(entry => entry.map.work.id === a.work.id)!.map.work.title).toBe('life B');
  } finally { db.close(); watcher.close(); }
});
