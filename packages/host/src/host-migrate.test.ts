import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, processStartedAt, transitionSession, updateMap } from '@parley/core';
import type { WorkMap } from '@parley/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../test/helpers.js';
import { HostAlreadyRunning, startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';

/**
 * Перенос каталогов состояния проектов на старте хоста (R6): `<проект>/.harnas` → `<проект>/.parley` — под замком
 * единственности, до сокета и наблюдателей. Логика и её стражи (живая сессия, `map.lock`, симлинк, `.parley` уже
 * есть) проверены в core (`migrate.test.ts`); здесь — что хост её зовёт вовремя, не падает от её отказов и
 * показывает работу из переехавшего каталога.
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

/** Проект, каким его оставила прежняя сборка: каталог состояния `.harnas` с одной работой, индекс — в доме. */
async function legacyProject(
  home: string,
  seed?: (map: WorkMap) => void,
): Promise<{ project: string; workId: string }> {
  const project = await mkdtemp(path.join(tmpdir(), 'parley-host-migrate-'));
  projects.push(project);
  await mkdir(path.join(project, '.harnas'));
  const previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  try {
    const { work } = await createWork(project, { title: 'Старая работа' });
    if (seed !== undefined) await updateMap(project, work.id, seed);
    return { project, workId: work.id };
  } finally {
    if (previous === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = previous;
  }
}

async function listWorks(home: string): Promise<Array<{ projectPath: string; map: WorkMap }>> {
  const paths = hostPaths(home);
  const client = connectRaw(paths.socket);
  await waitConnected(client.socket);
  await hello(client, await readFile(paths.token, 'utf8'));
  client.send({ id: 1, method: 'works.list', params: {} });
  let response = await client.next();
  while (response.id !== 1) response = await client.next();
  client.close();
  return (response.result as { entries: Array<{ projectPath: string; map: WorkMap }> }).entries;
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
    expect(existsSync(path.join(project, '.parley', 'works', workId, 'map.json'))).toBe(true);
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
    expect(existsSync(path.join(project, '.harnas', 'works', workId, 'map.json'))).toBe(true);
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
    expect(existsSync(path.join(project, '.harnas', 'works', workId, 'map.json'))).toBe(true);
    // Отслеживаемое на месте: git не видит ни одного удалённого файла (аренда хоста `host.lease` — новый, не отслеживаемый).
    expect((await git(project, ['status', '--porcelain'])).stdout).not.toMatch(/^ ?D /m);
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

    expect(existsSync(path.join(project, '.parley', 'works', 'w-0001', 'map.json'))).toBe(true);
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
