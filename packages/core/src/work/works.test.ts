import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { createWork, updateMap, workPaths } from './store.js';
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
