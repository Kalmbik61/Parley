import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendMessage, writeCursor } from './journal.js';
import { addSession } from './map.js';
import { migrateMapToJournal } from './migrate-map.js';
import { addRoom } from './rooms.js';
import { createWork, updateMap, workPaths } from './store.js';
import { readWorks, watchWorks, type WorkEntry, type WorkFileChange } from './works.js';

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

const titles = (works: WorkEntry[]): string[] => works.map((entry) => entry.map.work.title);

describe('readWorks', () => {
  it('отдаёт работы текущего проекта и работы других проектов из индекса', async () => {
    await createWork(project, { title: 'Авторизация' });
    await createWork(other, { title: 'Редизайн' });

    const works = await readWorks(project);

    expect(titles(works).sort()).toEqual(['Авторизация', 'Редизайн']);
    const mine = works.find((entry) => entry.map.work.title === 'Авторизация');
    expect(mine?.projectPath).toBe(project);
    expect(works.find((entry) => entry.map.work.title === 'Редизайн')?.projectPath).toBe(other);
  });

  it('видит работу проекта, которой нет в глобальном индексе', async () => {
    await createWork(project, { title: 'Авторизация' });
    // Индекс глобальный: он пуст после переноса PARLEY_HOME или клона проекта
    // с закоммиченным .parley — карты на диске при этом никуда не делись.
    await writeFile(
      path.join(home, 'works-index.json'),
      '{"schemaVersion":1,"works":[]}\n',
      'utf8',
    );

    expect(titles(await readWorks(project))).toEqual(['Авторизация']);
  });

  it('одна и та же работа не двоится', async () => {
    await createWork(project, { title: 'Авторизация' });
    expect(await readWorks(project)).toHaveLength(1);
  });

  it('битая и пропавшая карта не уносят весь список', async () => {
    await createWork(project, { title: 'Авторизация' });
    const broken = await createWork(project, { title: 'Битая' });
    await writeFile(workPaths(project, broken.work.id).map, '{ не json', 'utf8');
    const gone = await createWork(other, { title: 'Удалённая' });
    await rm(workPaths(other, gone.work.id).dir, { recursive: true, force: true });

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
});

/** Работа на карте-журнале (v3) с комнатой r-01 и сессией s-01. */
async function journalWork(dir: string, title: string): Promise<string> {
  const { work } = await createWork(dir, { title });
  await updateMap(dir, work.id, (map) => {
    addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addRoom(map, { title: 'Комната', creator: 's-01', members: ['s-01'] });
  });
  const result = await migrateMapToJournal(dir, work.id, { run: new Date().toISOString() });
  expect(result.status).toBe('migrated');
  return work.id;
}

describe('readWorks: повторное использование прежних записей', () => {
  it('карта, у которой не изменились mtime и размер, не разбирается заново; изменённая читается', async () => {
    const first = await createWork(project, { title: 'Первая' });
    await createWork(project, { title: 'Вторая' });
    const before = await readWorks(project);
    await updateMap(project, first.work.id, (map) => {
      map.work.goal = 'новая цель';
    });
    const after = await readWorks(project, before);
    const byId = (list: WorkEntry[], id: string): WorkEntry => list.find((entry) => entry.map.work.id === id)!;
    const untouched = before.find((entry) => entry.map.work.id !== first.work.id)!;
    expect(byId(after, untouched.map.work.id)).toBe(untouched);
    expect(byId(after, first.work.id)).not.toBe(byId(before, first.work.id));
    expect(byId(after, first.work.id).map.work.goal).toBe('новая цель');
  });
});

describe('watchWorks: журналы и курсоры', () => {
  async function until(predicate: () => boolean, poke: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      await poke();
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (Date.now() - started > timeoutMs) throw new Error('события не дождались');
    }
  }

  it('строка в журнале комнаты и прямом журнале и курсор сессии приходят в onChange с работой и комнатой; список не перечитывается', async () => {
    const workId = await journalWork(project, 'Журнал');
    const changes: WorkFileChange[] = [];
    let lists = 0;
    const watcher = watchWorks(() => (lists += 1), project, { debounceMs: 10, onChange: (change) => changes.push(change) });
    try {
      // Запоздалые события подготовки (запись индекса при миграции) к делу не относятся.
      await new Promise((resolve) => setTimeout(resolve, 700));
      lists = 0;
      await until(
        () => changes.some((c) => c.kind === 'journal' && c.roomId === 'r-01') && changes.some((c) => c.kind === 'journal' && c.roomId === null),
        async () => {
          await appendMessage(project, workId, 'r-01', { from: 's-01', to: [], text: 'в комнату' });
          await appendMessage(project, workId, null, { from: 's-01', to: ['human'], text: 'прямое' });
        },
      );
      await until(
        () => changes.some((c) => c.kind === 'cursor' && c.sessionId === 's-01'),
        async () => {
          await writeCursor(project, workId, 's-01', 'r-01', 'm-r01-1');
        },
      );
      expect(changes.filter((c) => c.kind === 'journal').every((c) => c.workId === workId && c.projectPath === project)).toBe(true);
      // Ни одна запись журнала или курсора не вернулась перечитыванием списка работ.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(lists).toBe(0);
    } finally {
      watcher.close();
    }
  }, 30_000);

  it('изменение индекса по-прежнему перечитывает список и сообщает разобранные байты; onChange молчит', async () => {
    const workId = await journalWork(project, 'Индекс');
    const changes: WorkFileChange[] = [];
    const parsed: number[] = [];
    const seen: WorkEntry[][] = [];
    const watcher = watchWorks(
      (works, _seq, bytes) => {
        seen.push(works);
        parsed.push(bytes);
      },
      project,
      { debounceMs: 10, onChange: (change) => changes.push(change) },
    );
    try {
      await until(
        () => seen.some((list) => list[0]?.map.work.goal === 'цель индекса'),
        () =>
          updateMap(project, workId, (map) => {
            map.work.goal = 'цель индекса';
          }).then(() => undefined),
      );
      expect(changes).toEqual([]);
      expect(parsed.some((bytes) => bytes > 0)).toBe(true);
    } finally {
      watcher.close();
    }
  }, 30_000);
});
