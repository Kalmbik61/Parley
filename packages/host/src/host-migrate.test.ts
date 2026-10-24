import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, processStartedAt, readMap, readWorksIndex, transitionSession, workExists } from '@parley/core';
import type { WorkMap } from '@parley/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../test/helpers.js';
import { HostAlreadyRunning, startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';

/**
 * Перенос каталогов состояния проектов на старте хоста (R6): `<проект>/.harnas` → `<проект>/.parley` — под замком
 * единственности, до сокета и наблюдателей. Логика и её стражи (живая сессия, `map.lock`, симлинк, `.parley` уже
 * есть) проверены в core (`migrate.test.ts`); здесь — что хост её зовёт вовремя, не падает от её отказов и
 * показывает работу из переехавшего каталога. Работы лежат файлами прежней сборки (`map.json` и `works-index.json`
 * дома): на первом старте хост сперва переносит каталоги, затем переселяет карты в базу, затем правит пути артефактов
 * (спека хранилища 6.6).
 */

const git = (dir: string, args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

async function newHome(): Promise<string> {
  const home = await tempHome();
  homes.push(home);
  return home;
}

/** Пустая карта работы — такой её оставляла прежняя сборка. */
const legacyMap = (id: string, title: string): WorkMap => ({
  schemaVersion: 2,
  work: { id, title, goal: '', status: 'active', createdAt: '2026-09-30T18:00:00.000Z', updatedAt: '2026-09-30T18:00:00.000Z' },
  sessions: [],
  messages: [],
  rooms: [],
});

/**
 * Работа в формате до базы: `map.json` в каталоге состояния проекта и запись в `works-index.json` дома. Базы не
 * касается — хост должен переселить её сам.
 */
async function writeLegacyWork(home: string, project: string, stateDirName: string, map: WorkMap): Promise<void> {
  const dir = path.join(project, stateDirName, 'works', map.work.id);
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  await mkdir(path.join(dir, 'briefs'), { recursive: true });
  await writeFile(path.join(dir, 'map.json'), `${JSON.stringify(map, null, 2)}\n`);
  const indexFile = path.join(home, 'works-index.json');
  let works: unknown[] = [];
  try {
    works = (JSON.parse(await readFile(indexFile, 'utf8')) as { works: unknown[] }).works;
  } catch {
    // Индекса ещё нет.
  }
  works.push({ id: map.work.id, projectPath: project, title: map.work.title, status: map.work.status, updatedAt: map.work.updatedAt });
  await writeFile(indexFile, `${JSON.stringify({ schemaVersion: 1, works }, null, 2)}\n`);
}

/** Проект, каким его оставила прежняя сборка: каталог состояния `.harnas` с одной работой, индекс — в доме. */
async function legacyProject(
  home: string,
  seed?: (map: WorkMap) => void,
): Promise<{ project: string; workId: string }> {
  const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
  projects.push(project);
  const map = legacyMap('w-0001', 'Старая работа');
  seed?.(map);
  await writeLegacyWork(home, project, '.harnas', map);
  return { project, workId: map.work.id };
}

async function worksListResponse(home: string): Promise<{ result?: unknown; error?: { code: string; data?: Record<string, unknown> } }> {
  const paths = hostPaths(home);
  const client = connectRaw(paths.socket);
  await waitConnected(client.socket);
  await hello(client, await readFile(paths.token, 'utf8'));
  client.send({ id: 1, method: 'works.list', params: {} });
  let response = await client.next();
  while (response.id !== 1) response = await client.next();
  client.close();
  return response;
}

async function listWorks(home: string): Promise<Array<{ projectPath: string; map: WorkMap }>> {
  return ((await worksListResponse(home)).result as { entries: Array<{ projectPath: string; map: WorkMap }> }).entries;
}

async function logged(home: string): Promise<Array<{ level: string; msg: string } & Record<string, unknown>>> {
  return (await readFile(hostPaths(home).log, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { level: string; msg: string });
}

describe('startHost переносит каталог состояния проектов (R6)', () => {
  it('проект со старым .harnas: к готовности хоста это уже .parley со своим .gitignore, работа видна, перенос записан и залогирован', async () => {
    const home = await newHome();
    const { project, workId } = await legacyProject(home);

    const running = await startHost({ home });
    hosts.push(running);

    expect(existsSync(path.join(project, '.harnas'))).toBe(false);
    // Карта переехала в базу вслед за каталогом: файла нет, рядом — его копия.
    expect(existsSync(path.join(project, '.parley', 'works', workId, 'map.v2.json'))).toBe(true);
    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');

    const record = JSON.parse(await readFile(path.join(home, 'migrated-from-harnas.json'), 'utf8')) as {
      migrated: Array<Record<string, string>>;
    };
    expect(record.migrated).toEqual([
      {
        what: 'project',
        from: path.join(project, '.harnas'),
        to: path.join(project, '.parley'),
        at: expect.any(String),
      },
    ]);
    expect(await logged(home)).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'каталог состояния проекта перенесён', projectPath: project }),
    );

    const entries = await listWorks(home);
    expect(entries.map((entry) => [entry.projectPath, entry.map.work.title])).toEqual([[project, 'Старая работа']]);
  });

  it('пути артефактов в карте переписаны к готовности хоста: работа из списка отдаёт путь, который ведёт к файлу', async () => {
    const home = await newHome();
    const { project, workId } = await legacyProject(home, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 'задача' });
      session.artifacts = [{ kind: 'план', path: `.harnas/works/${map.work.id}/artifacts/plan.md` }];
    });
    await writeFile(path.join(project, '.harnas', 'works', workId, 'artifacts', 'plan.md'), 'план\n');

    const running = await startHost({ home });
    hosts.push(running);

    const [entry] = await listWorks(home);
    const artifact = entry?.map.sessions[0]?.artifacts[0];
    expect(artifact?.path).toBe(`.parley/works/${workId}/artifacts/plan.md`);
    expect(existsSync(path.join(project, artifact?.path ?? ''))).toBe(true);
  });

  it('у работы проекта живая сессия: проект остаётся при .harnas, хост работает с ним как раньше, причина — в журнале', async () => {
    const home = await newHome();
    const startedAtProcess = await processStartedAt(process.pid);
    const { project, workId } = await legacyProject(home, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
      transitionSession(map, session.id, 'active');
      session.pid = process.pid;
      session.startedAtProcess = startedAtProcess;
    });

    const running = await startHost({ home });
    hosts.push(running);

    expect(existsSync(path.join(project, '.parley'))).toBe(false);
    // Каталог остался прежним, а карта всё равно в базе: переезд карты ждёт только `map.lock`, а не живой процесс.
    expect(existsSync(path.join(project, '.harnas', 'works', workId, 'map.v2.json'))).toBe(true);
    expect(existsSync(path.join(home, 'migrated-from-harnas.json'))).toBe(false);
    expect(await logged(home)).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'каталог состояния проекта не перенесён',
        projectPath: project,
        reason: 'live-session',
        detail: `${workId}/s-01`,
      }),
    );

    const entries = await listWorks(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.map.sessions[0]?.lifecycle).toBe('active');
  });

  it('.harnas закоммичен в git проекта: проект остаётся при нём, хост поднят, в журнале — info, а не предупреждение', async () => {
    const home = await newHome();
    const { project, workId } = await legacyProject(home);
    await git(project, ['init', '-q']);
    await git(project, ['config', 'user.email', 'тест@parley']);
    await git(project, ['config', 'user.name', 'тест']);
    await git(project, ['add', '-A']);
    await git(project, ['commit', '-q', '-m', 'состояние работы в истории']);

    const running = await startHost({ home });
    hosts.push(running);

    expect(existsSync(path.join(project, '.parley'))).toBe(false);
    expect(existsSync(path.join(project, '.harnas', 'works', workId, 'map.v2.json'))).toBe(true);
    // Отслеживаемое на месте: из репозитория ушёл один `map.json` — карта переехала в базу, файл переименован (спека
    // хранилища 6.6). Аренда хоста `host.lease` — новый, не отслеживаемый файл.
    const status = (await git(project, ['status', '--porcelain'])).stdout;
    expect(status.split('\n').filter((line) => /^ ?D /.test(line))).toEqual([` D .harnas/works/${workId}/map.json`]);
    expect(await logged(home)).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'каталог состояния проекта не перенесён',
        projectPath: project,
        reason: 'tracked',
      }),
    );
    expect(existsSync(hostPaths(home).socket)).toBe(true);
  });

  it('проект уже на .parley: ничего не переносится, в журнале о переносе ни слова', async () => {
    const home = await newHome();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
    projects.push(project);
    const previous = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = home;
    try {
      await createWork(project, { title: 'Новая работа' });
    } finally {
      if (previous === undefined) delete process.env['PARLEY_HOME'];
      else process.env['PARLEY_HOME'] = previous;
    }

    const running = await startHost({ home });
    hosts.push(running);

    // Работа уже в базе (файла карты у неё нет): каталог её файлов на месте, о переносе — ни слова.
    expect(existsSync(path.join(project, '.parley', 'works', 'w-0001'))).toBe(true);
    expect((await logged(home)).filter((line) => line.msg.includes('каталог состояния'))).toEqual([]);
    expect(existsSync(path.join(home, 'migrated-from-harnas.json'))).toBe(false);
  });

  it('индекс не разобрался: хост всё равно поднят, отказ переноса — в журнале; перенос хост не останавливает', async () => {
    const home = await newHome();
    await writeFile(path.join(home, 'works-index.json'), '{ broken');

    const running = await startHost({ home });
    hosts.push(running);

    expect(await logged(home)).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'перенос каталогов состояния проектов не выполнен' }),
    );
    expect(existsSync(hostPaths(home).socket)).toBe(true);
    // Пустая база не сходит за «работ нет»: снимок отказывает с причиной, окно покажет баннер, а индекс остался как был.
    expect((await worksListResponse(home)).error).toMatchObject({ code: 'internal', data: { reason: 'works-unreadable' } });
    expect(await readFile(path.join(home, 'works-index.json'), 'utf8')).toBe('{ broken');
  });

  it('второй хост того же дома отказывает до переноса: проекты переносит только держатель замка', async () => {
    const home = await newHome();
    const first = await startHost({ home });
    hosts.push(first);
    const { project, workId } = await legacyProject(home);

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);

    // Первый хост мог успеть заметить новую работу и записать в неё аренду — карта и каталог на месте.
    expect(existsSync(path.join(project, '.parley'))).toBe(false);
    expect(existsSync(path.join(project, '.harnas', 'works', workId, 'map.json'))).toBe(true);
  });
});

describe('startHost moves workspace maps into the database (storage spec 6.6)', () => {
  /** Подключённый клиент, прошедший `hello`: события, которые хост шлёт сразу после него, лежат в его очереди. */
  async function connect(home: string) {
    const paths = hostPaths(home);
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    await hello(client, await readFile(paths.token, 'utf8'));
    return client;
  }

  it('a host started on a home with an old map.json publishes the work in its first snapshot and leaves map.v2.json beside it', async () => {
    const home = await newHome();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
    projects.push(project);
    await writeLegacyWork(home, project, '.parley', legacyMap('w-0001', 'Work from a file'));

    const running = await startHost({ home });
    hosts.push(running);

    const entries = await listWorks(home);
    expect(entries.map((entry) => [entry.projectPath, entry.map.work.title])).toEqual([[project, 'Work from a file']]);
    const dir = path.join(project, '.parley', 'works', 'w-0001');
    expect(existsSync(path.join(dir, 'map.v2.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'map.json'))).toBe(false);
    expect(existsSync(path.join(home, 'works-index.json'))).toBe(false);
    expect(existsSync(path.join(home, 'works-index.v2.json'))).toBe(true);
  });

  it('first start from files only: the folder moves, the map lands in the database, artifact paths are rewritten', async () => {
    const home = await newHome();
    const { project, workId } = await legacyProject(home, (map) => {
      addSession(map, { provider: 'claude', label: 'plan', task: 'task' }).artifacts = [
        { kind: 'plan', path: `.harnas/works/${map.work.id}/artifacts/plan.md` },
      ];
    });
    await writeFile(path.join(project, '.harnas', 'works', workId, 'artifacts', 'plan.md'), 'plan\n');
    // Только файлы прежней сборки: базы с работами у дома ещё нет.
    expect(existsSync(path.join(home, 'parley.db'))).toBe(false);

    const running = await startHost({ home });
    hosts.push(running);

    expect(existsSync(path.join(project, '.harnas'))).toBe(false);
    const dir = path.join(project, '.parley', 'works', workId);
    expect(existsSync(path.join(dir, 'map.v2.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'map.json'))).toBe(false);
    // Строки в базе, а пути артефактов в них уже под новым именем: правка шла после переезда карт, а не до него.
    expect(workExists(project, workId)).toBe(true);
    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual([workId]);
    const artifact = (await readMap(project, workId)).sessions[0]?.artifacts[0];
    expect(artifact?.path).toBe(`.parley/works/${workId}/artifacts/plan.md`);
    expect(existsSync(path.join(project, artifact?.path ?? ''))).toBe(true);
  });

  it('a map that cannot be moved stays in its file, and a window that connects gets a map-migration-failed notice', async () => {
    const home = await newHome();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
    projects.push(project);
    await writeLegacyWork(home, project, '.parley', legacyMap('w-0001', 'Broken'));
    const file = path.join(project, '.parley', 'works', 'w-0001', 'map.json');
    await writeFile(file, '{ broken');

    const running = await startHost({ home });
    hosts.push(running);

    const client = await connect(home);
    let message = await client.next();
    while (message.event !== 'host.notice') message = await client.next();
    client.close();
    // Путь `map.json` (окно берёт из него номер работы и имя проекта), со следующей строки — причина.
    expect(message.data).toEqual({ kind: 'map-migration-failed', ref: null, text: expect.stringMatching(/^.+\n.+$/s), at: expect.any(String) });
    expect((message.data as { text: string }).text.split('\n')[0]).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('{ broken');
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(existsSync(path.join(home, 'works-index.json'))).toBe(true);
    expect(await listWorks(home)).toEqual([]);
  });

  it('a work busy with an old-build writer (live map.lock) stays in its file and the window gets a map-migration-failed notice for it', async () => {
    const home = await newHome();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
    projects.push(project);
    await writeLegacyWork(home, project, '.parley', legacyMap('w-0001', 'Busy'));
    const file = path.join(project, '.parley', 'works', 'w-0001', 'map.json');
    // Замок с pid живого процесса (этого же): так выглядит запись прежней сборки.
    await writeFile(path.join(project, '.parley', 'works', 'w-0001', 'map.lock'), `${process.pid}\n`);

    const running = await startHost({ home });
    hosts.push(running);

    const client = await connect(home);
    let message = await client.next();
    while (message.event !== 'host.notice') message = await client.next();
    client.close();
    const notice = message.data as { kind: string; text: string };
    expect(notice.kind).toBe('map-migration-failed');
    expect(notice.text.split('\n')).toEqual([file, 'busy: map.lock is held by a running process']);
    expect(existsSync(file)).toBe(true);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(existsSync(path.join(home, 'works-index.json'))).toBe(true);
  });
});
