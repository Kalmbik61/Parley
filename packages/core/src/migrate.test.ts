import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_RECORD, migrateHome, migrateProjects } from './migrate.js';
import type { MigrationEntry } from './migrate.js';
import { processStartedAt } from './work/liveness.js';
import { addSession, transitionSession } from './work/map.js';
import { createWork, readMap, readWorksIndex, updateMap, worksIndexPath } from './work/store.js';
import type { WorkSession } from './work/types.js';

const AT = new Date('2026-09-30T18:00:00.000Z');
const now = (): Date => AT;

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

/** Репозиторий с одним коммитом всего, что лежит в проекте. Личность автора — на репозиторий: своей у машины теста может не быть. */
async function commitEverything(project: string, ...extra: Array<[string, string]>): Promise<void> {
  await git(project, ['init', '-q']);
  await git(project, ['config', 'user.email', 'тест@parley']);
  await git(project, ['config', 'user.name', 'тест']);
  for (const [file, text] of extra) await writeFile(path.join(project, file), text);
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'первый']);
}

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

const record = async (home: string): Promise<{ schemaVersion: number; migrated: MigrationEntry[] }> =>
  JSON.parse(await readFile(path.join(home, MIGRATION_RECORD), 'utf8')) as {
    schemaVersion: number;
    migrated: MigrationEntry[];
  };

/** Запись с root в sandbox права не режет, и отказ `rename` по правам не проверить. */
const asRoot = process.getuid?.() === 0;

describe('migrateHome — перенос ~/.harnas → ~/.parley (R6)', () => {
  /** «Домашний каталог человека» — прямо в `/tmp`: путь unix-сокета старого хоста ограничен 103 байтами. */
  let userHome = '';
  const servers: Server[] = [];
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    userHome = await mkdtemp('/tmp/mh-');
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await chmod(userHome, 0o700);
    await rm(userHome, { recursive: true, force: true });
  });

  const legacy = (): string => path.join(userHome, '.harnas');
  const current = (): string => path.join(userHome, '.parley');

  /** Дом, каким его оставила прежняя сборка: индекс, настройки, данные окна. */
  async function seedLegacyHome(): Promise<void> {
    await mkdir(path.join(legacy(), 'desktop'), { recursive: true });
    await writeFile(path.join(legacy(), 'works-index.json'), '{"schemaVersion":1,"works":[]}\n');
    await writeFile(path.join(legacy(), 'config.json'), '{"fontSize":17}\n');
    await writeFile(path.join(legacy(), 'desktop', 'layouts.json'), '{"version":2,"works":{}}\n');
  }

  /** Замок хоста с pid живого процесса и его настоящим временем старта: хост, которого не видно, а он жив. */
  async function liveHostLock(): Promise<void> {
    await mkdir(path.join(legacy(), 'host'), { recursive: true });
    await writeFile(path.join(legacy(), 'host', 'host.pid'), `${process.pid}\n${(await processStartedAt(process.pid)) ?? ''}\n`);
  }

  /** Прежний дом на месте и не тронут. */
  async function expectUntouched(): Promise<void> {
    expect(await readFile(path.join(legacy(), 'config.json'), 'utf8')).toBe('{"fontSize":17}\n');
    expect(await exists(path.join(legacy(), MIGRATION_RECORD))).toBe(false);
  }

  it('обычный случай: rename — тот же каталог под новым именем, данные на месте, записан перенос', async () => {
    await seedLegacyHome();
    const before = await stat(legacy());

    const result = await migrateHome({ env: {}, userHome, now });

    expect(result).toEqual({ status: 'moved', from: legacy(), to: current() });
    expect(await exists(legacy())).toBe(false);
    // Тот же inode: переименование, а не копия с удалением.
    expect((await stat(current())).ino).toBe(before.ino);
    expect(await readFile(path.join(current(), 'config.json'), 'utf8')).toBe('{"fontSize":17}\n');
    expect(await readFile(path.join(current(), 'works-index.json'), 'utf8')).toBe('{"schemaVersion":1,"works":[]}\n');
    expect(await readFile(path.join(current(), 'desktop', 'layouts.json'), 'utf8')).toBe('{"version":2,"works":{}}\n');
    expect(await record(current())).toEqual({
      schemaVersion: 1,
      migrated: [{ what: 'home', from: legacy(), to: current(), at: AT.toISOString() }],
    });
  });

  it('запись, которую хост оставил в прежнем доме (проекты переехали раньше дома), переезжает с ним и дополняется', async () => {
    await seedLegacyHome();
    const projectLine: MigrationEntry = { what: 'project', from: '/p/.harnas', to: '/p/.parley', at: '2026-09-29T10:00:00.000Z' };
    await writeFile(path.join(legacy(), MIGRATION_RECORD), `${JSON.stringify({ schemaVersion: 1, migrated: [projectLine] })}\n`);

    await migrateHome({ env: {}, userHome, now });

    expect((await record(current())).migrated).toEqual([
      projectLine,
      { what: 'home', from: legacy(), to: current(), at: AT.toISOString() },
    ]);
  });

  it('повторный вызов: переносить нечего, запись не дублируется', async () => {
    await seedLegacyHome();
    await migrateHome({ env: {}, userHome, now });

    expect(await migrateHome({ env: {}, userHome, now })).toEqual({ status: 'skipped', reason: 'no-legacy', from: legacy() });
    expect((await record(current())).migrated).toHaveLength(1);
  });

  it('нет ни одного дома — переносить нечего, ничего не создаётся', async () => {
    expect(await migrateHome({ env: {}, userHome, now })).toEqual({ status: 'skipped', reason: 'no-legacy', from: legacy() });
    expect(await exists(current())).toBe(false);
  });

  it('дом задан PARLEY_HOME или прежним HARNAS_HOME — не переносим; пустая переменная — не задана', async () => {
    await seedLegacyHome();

    for (const env of [{ PARLEY_HOME: '/дом/теста' }, { HARNAS_HOME: '/прежний/дом' }]) {
      expect(await migrateHome({ env, userHome, now })).toMatchObject({ status: 'skipped', reason: 'explicit-home' });
      expect(await exists(current())).toBe(false);
      await expectUntouched();
    }

    expect(await migrateHome({ env: { PARLEY_HOME: '', HARNAS_HOME: '' }, userHome, now })).toMatchObject({ status: 'moved' });
  });

  it('~/.parley уже есть — не переносим: оба каталога на месте, выбор дома за R4', async () => {
    await seedLegacyHome();
    await mkdir(current());
    await writeFile(path.join(current(), 'config.json'), '{"fontSize":12}\n');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'current-exists' });

    await expectUntouched();
    expect(await readFile(path.join(current(), 'config.json'), 'utf8')).toBe('{"fontSize":12}\n');
  });

  it('~/.parley — и файл, и ссылка — тоже «уже есть»: rename поверх них не идёт', async () => {
    await seedLegacyHome();
    await writeFile(current(), 'файл\n');
    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'current-exists' });
    await rm(current());

    await symlink(legacy(), current());
    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'current-exists' });
    await expectUntouched();
  });

  it('~/.harnas — симлинк на каталог: не переносим, ссылка и цель целы', async () => {
    const target = path.join(userHome, 'настоящий-дом');
    await mkdir(target);
    await writeFile(path.join(target, 'config.json'), '{"fontSize":17}\n');
    await symlink(target, legacy());

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'legacy-not-directory' });

    expect(await exists(current())).toBe(false);
    expect((await stat(legacy())).isDirectory()).toBe(true);
    expect(await readFile(path.join(target, 'config.json'), 'utf8')).toBe('{"fontSize":17}\n');
  });

  it('~/.harnas — обычный файл: не переносим', async () => {
    await writeFile(legacy(), 'файл\n');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'legacy-not-directory' });
    expect(await exists(current())).toBe(false);
  });

  it('старый хост жив по замку host/host.pid — не переносим', async () => {
    await seedLegacyHome();
    await liveHostLock();

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'host-alive' });

    expect(await exists(current())).toBe(false);
    await expectUntouched();
  });

  it('старый хост жив по сокету (замка нет) — не переносим', async () => {
    await seedLegacyHome();
    await mkdir(path.join(legacy(), 'host'), { recursive: true });
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(legacy(), 'host', 'host.sock'), resolve);
    });

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'host-alive' });

    expect(await exists(current())).toBe(false);
    await expectUntouched();
  });

  it('хост упал и оставил осколки (замок с мёртвым pid, сокет без слушателя) — дом переносится вместе с ними', async () => {
    await seedLegacyHome();
    await mkdir(path.join(legacy(), 'host'), { recursive: true });
    await writeFile(path.join(legacy(), 'host', 'host.pid'), '999999\n\n');
    await writeFile(path.join(legacy(), 'host', 'host.sock'), '');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });

    expect(await exists(path.join(current(), 'host', 'host.pid'))).toBe(true);
    expect(await exists(legacy())).toBe(false);
  });

  it('чужой pid-замок, время старта которого разошлось с записанным (pid достался другому) — осколок, дом переносится', async () => {
    await seedLegacyHome();
    await mkdir(path.join(legacy(), 'host'), { recursive: true });
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    await writeFile(path.join(legacy(), 'host', 'host.pid'), `${child.pid}\n2020-01-01T00:00:00.000Z\n`);

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
  });

  it('*.lock в корне дома (запись индекса идёт) — не переносим', async () => {
    await seedLegacyHome();
    await writeFile(path.join(legacy(), 'works-index.lock'), '');

    expect(await migrateHome({ env: {}, userHome, now })).toEqual({
      status: 'skipped',
      reason: 'locked',
      from: legacy(),
      detail: 'works-index.lock',
    });

    expect(await exists(current())).toBe(false);
    await expectUntouched();
  });

  it('.lock глубже корня дома (у работы проекта, у хоста) перенос не держит', async () => {
    await seedLegacyHome();
    await mkdir(path.join(legacy(), 'host'));
    await writeFile(path.join(legacy(), 'host', 'something.lock'), '');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
  });

  /** Работа с индексом прежнего дома: `createWork` и `updateMap` берут дом из `PARLEY_HOME`. */
  async function inLegacyHome<T>(body: () => Promise<T>): Promise<T> {
    process.env.PARLEY_HOME = legacy();
    try {
      return await body();
    } finally {
      delete process.env.PARLEY_HOME;
    }
  }

  /**
   * Проект из индекса прежнего дома, каким его оставила прежняя сборка: каталог состояния `.harnas` с работой и
   * сессией, которую поднимал человек командой из терминала (`work session new`) — в карте она `pending` без pid.
   */
  async function legacyProject(name: string, stateDirName = '.harnas'): Promise<{ project: string; workId: string; sessionId: string }> {
    const project = path.join(userHome, name);
    await mkdir(path.join(project, stateDirName), { recursive: true });
    return inLegacyHome(async () => {
      const { work } = await createWork(project, { title: `Работа ${name}` });
      let sessionId = '';
      await updateMap(project, work.id, (map) => {
        const session = addSession(map, { provider: 'claude', label: 'из терминала', task: '' });
        session.launchedBy = 'cli';
        sessionId = session.id;
      });
      return { project, workId: work.id, sessionId };
    });
  }

  /** Процесс агента, поднятого из терминала: путь из каталога состояния стоит в его командной строке (`--mcp-config`). */
  async function startAgent(stateRoot: string, workId: string, sessionId: string): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', path.join(stateRoot, 'works', workId, 'mcp', `${sessionId}.json`)],
      { stdio: 'ignore' },
    );
    children.push(child);
    await once(child, 'spawn');
    return child;
  }

  async function stopAgent(child: ChildProcess): Promise<void> {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }

  it('в индексе проект с сессией из терминала (pending без pid): агент держит путь в командной строке — дом не переносим; ушёл — переносится', async () => {
    await seedLegacyHome();
    const { project, workId, sessionId } = await legacyProject('shop');
    const agent = await startAgent(path.join(project, '.harnas'), workId, sessionId);

    const result = await migrateHome({ env: {}, userHome, now });

    expect(result).toMatchObject({ status: 'skipped', reason: 'live-session', from: legacy() });
    expect(result.status === 'skipped' ? result.detail : '').toContain(`pid ${agent.pid}`);
    expect(await exists(current())).toBe(false);
    await expectUntouched();

    await stopAgent(agent);
    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
  });

  it('то же у проекта, который хост уже перенёс на .parley, пока дом ещё прежний: проверяются оба имени каталога состояния', async () => {
    await seedLegacyHome();
    const { project, workId, sessionId } = await legacyProject('shop', '.parley');
    const agent = await startAgent(path.join(project, '.parley'), workId, sessionId);

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'live-session' });

    await stopAgent(agent);
    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
  });

  it('сессия по карте (active, свой pid и время старта) в проекте из индекса — дом не переносим', async () => {
    await seedLegacyHome();
    const { project, workId, sessionId } = await legacyProject('shop');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    await inLegacyHome(() =>
      updateMap(project, workId, (map) => {
        transitionSession(map, sessionId, 'active');
        const session = map.sessions.find((candidate) => candidate.id === sessionId);
        if (session) Object.assign(session, { pid: child.pid ?? 0 });
      }),
    );

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'live-session' });
    await expectUntouched();
  });

  it('у работы из индекса держится map.lock (пишет MCP-сервер агента) — дом не переносим', async () => {
    await seedLegacyHome();
    const { project, workId } = await legacyProject('shop');
    await writeFile(path.join(project, '.harnas', 'works', workId, 'map.lock'), '');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'locked' });
    await expectUntouched();
  });

  it('проект из индекса исчез, а других процессов нет — дом переносится; записи индекса без проектов дом не держат', async () => {
    await seedLegacyHome();
    const gone = await legacyProject('gone');
    await rm(gone.project, { recursive: true, force: true });

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
  });

  it('таблицу процессов получить нельзя (нет ps) — дом не переносим: живую сессию из терминала не отличить', async () => {
    await seedLegacyHome();
    await legacyProject('shop');
    const before = process.env.PATH;
    process.env.PATH = path.join(userHome, 'нет-такого-каталога');
    try {
      expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'unreadable', from: legacy() });
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
    await expectUntouched();
  });

  it('индекс работ прежнего дома не разобрался — дом не переносим: живость сессий по нему не проверить', async () => {
    await seedLegacyHome();
    await writeFile(path.join(legacy(), 'works-index.json'), '{ broken');

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'skipped', reason: 'unreadable', from: legacy() });
    expect(await exists(current())).toBe(false);
    await expectUntouched();
  });

  it.skipIf(asRoot)('rename не удался — результат, а не исключение; прежний дом на месте', async () => {
    await seedLegacyHome();
    // Запись в каталог запрещена: переименовать в нём нечего.
    await chmod(userHome, 0o500);

    const result = await migrateHome({ env: {}, userHome, now });

    expect(result).toMatchObject({ status: 'skipped', reason: 'rename-failed', from: legacy() });
    await chmod(userHome, 0o700);
    await expectUntouched();
    expect(await exists(current())).toBe(false);
  });

  it('сбой записи о переносе перенос не отменяет', async () => {
    await seedLegacyHome();
    // Вместо файла записи — каталог: `rename` временного файла поверх него не пройдёт.
    await mkdir(path.join(legacy(), MIGRATION_RECORD));

    expect(await migrateHome({ env: {}, userHome, now })).toMatchObject({ status: 'moved' });
    expect(await exists(legacy())).toBe(false);
  });
});

describe('migrateProjects — перенос <проект>/.harnas → <проект>/.parley (R6)', () => {
  let home = '';
  let root = '';
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    root = await mkdtemp(path.join(tmpdir(), 'parley-projects-'));
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    for (const child of children.splice(0)) await stop(child);
    delete process.env.PARLEY_HOME;
    await chmod(root, 0o700);
    await Promise.all([home, root].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Настоящий дочерний процесс: живость проверяется на нём, а не на моке. `argv` — хвост его командной строки. */
  function start(...argv: string[]): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...argv], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  /**
   * Агент, поднятый из терминала: путь из каталога состояния стоит в его командной строке — так `claude` держит
   * свой `--mcp-config`. Ждёт, пока процесс запущен: до этого `ps` показал бы командную строку родителя.
   */
  async function startAgent(stateRoot: string, workId: string, sessionId: string): Promise<ChildProcess> {
    const child = start(path.join(stateRoot, 'works', workId, 'mcp', `${sessionId}.json`));
    await once(child, 'spawn');
    return child;
  }

  /** В карте — то, что оставляет `work session new`: `pending` без pid, запустил не хост. */
  async function seedTerminalSession(project: string, workId: string): Promise<string> {
    let id = '';
    await updateMap(project, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'из терминала', task: '' });
      session.launchedBy = 'cli';
      id = session.id;
    });
    return id;
  }

  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }

  /** Проект, каким его оставила прежняя сборка: каталог состояния `.harnas` с одной работой. */
  async function legacyProject(name: string): Promise<{ project: string; workId: string }> {
    const project = path.join(root, name);
    await mkdir(path.join(project, '.harnas'), { recursive: true });
    const { work } = await createWork(project, { title: `Работа ${name}` });
    await writeFile(path.join(project, '.harnas', 'works', work.id, 'artifacts', 'note.txt'), 'заметка\n');
    return { project, workId: work.id };
  }

  /** Заводит сессию в работе и ставит ей поля процесса. */
  async function seedSession(project: string, workId: string, patch: Partial<WorkSession>): Promise<string> {
    let id = '';
    await updateMap(project, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'сессия', task: '' });
      id = session.id;
      transitionSession(map, id, patch.lifecycle === 'sleeping' ? 'active' : (patch.lifecycle ?? 'active'));
      if (patch.lifecycle === 'sleeping') transitionSession(map, id, 'sleeping');
      Object.assign(session, patch);
    });
    return id;
  }

  const legacyDir = (project: string): string => path.join(project, '.harnas');
  const currentDir = (project: string): string => path.join(project, '.parley');

  /** Проект при прежнем каталоге: ни `.parley`, ни потерянных файлов. */
  async function expectUntouched(project: string, workId: string): Promise<void> {
    expect(await exists(currentDir(project))).toBe(false);
    expect(await exists(path.join(legacyDir(project), 'works', workId, 'map.json'))).toBe(true);
    expect(await readFile(path.join(legacyDir(project), 'works', workId, 'artifacts', 'note.txt'), 'utf8')).toBe('заметка\n');
  }

  it('обычный случай: rename, .parley/.gitignore со строкой *, запись о переносе в доме; индекс не тронут', async () => {
    const { project, workId } = await legacyProject('shop');
    const indexBefore = await readFile(worksIndexPath(), 'utf8');
    const before = await stat(legacyDir(project));

    const results = await migrateProjects({ now });

    expect(results).toEqual([{ projectPath: project, status: 'moved', from: legacyDir(project), to: currentDir(project) }]);
    expect(await exists(legacyDir(project))).toBe(false);
    expect((await stat(currentDir(project))).ino).toBe(before.ino);
    expect(await readFile(path.join(currentDir(project), 'works', workId, 'map.json'), 'utf8')).toContain('Работа shop');
    expect(await readFile(path.join(currentDir(project), 'works', workId, 'artifacts', 'note.txt'), 'utf8')).toBe('заметка\n');
    expect(await readFile(path.join(currentDir(project), '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n!backlog.md\n!plans/\n!plans/**\n!memory.md\n!decisions/\n!decisions/**\n!history-shared/\n!history-shared/**\n');
    expect(await record(home)).toEqual({
      schemaVersion: 1,
      migrated: [{ what: 'project', from: legacyDir(project), to: currentDir(project), at: AT.toISOString() }],
    });
    expect(await readFile(worksIndexPath(), 'utf8')).toBe(indexBefore);
  });

  it('повторный проход: переносить нечего, запись не дублируется', async () => {
    const { project } = await legacyProject('shop');
    await migrateProjects({ now });

    expect(await migrateProjects({ now })).toEqual([
      { projectPath: project, status: 'skipped', reason: 'no-legacy', from: legacyDir(project) },
    ]);
    expect((await record(home)).migrated).toHaveLength(1);
  });

  it('запись дописывается: перенос дома уже оставил в ней строку — она цела', async () => {
    const { project } = await legacyProject('shop');
    const homeLine: MigrationEntry = { what: 'home', from: '/u/.harnas', to: '/u/.parley', at: '2026-09-29T10:00:00.000Z' };
    await writeFile(path.join(home, MIGRATION_RECORD), `${JSON.stringify({ schemaVersion: 1, migrated: [homeLine] })}\n`);

    await migrateProjects({ now });

    expect((await record(home)).migrated).toEqual([
      homeLine,
      { what: 'project', from: legacyDir(project), to: currentDir(project), at: AT.toISOString() },
    ]);
  });

  it('несколько проектов — каждый сам: запись по строке на проект в порядке индекса; проект в индексе дважды — один раз', async () => {
    const a = await legacyProject('a');
    const b = await legacyProject('b');
    // Вторая работа в проекте a: запись индекса с тем же projectPath.
    await createWork(a.project, { title: 'Вторая в a' });

    const results = await migrateProjects({ now });

    expect(results.map((result) => [result.projectPath, result.status])).toEqual([
      [a.project, 'moved'],
      [b.project, 'moved'],
    ]);
    expect((await record(home)).migrated.map((entry) => entry.from)).toEqual([legacyDir(a.project), legacyDir(b.project)]);
  });

  it('уже есть .parley — не переносим: .harnas цел, читатель их не сливает', async () => {
    const { project, workId } = await legacyProject('shop');
    await mkdir(currentDir(project));

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([{ status: 'skipped', reason: 'current-exists' }]);
    expect(await exists(path.join(legacyDir(project), 'works', workId, 'map.json'))).toBe(true);
    expect(await exists(path.join(currentDir(project), '.gitignore'))).toBe(false);
    expect(await exists(path.join(home, MIGRATION_RECORD))).toBe(false);
  });

  it('.harnas — симлинк на каталог: не переносим', async () => {
    const { project, workId } = await legacyProject('shop');
    const target = path.join(root, 'общее-состояние');
    await rename(legacyDir(project), target);
    await symlink(target, legacyDir(project));

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([{ status: 'skipped', reason: 'legacy-not-directory' }]);
    expect(await exists(currentDir(project))).toBe(false);
    expect(await exists(path.join(target, 'works', workId, 'map.json'))).toBe(true);
  });

  it('у сессии живой процесс (active, свой pid и время старта) — проект не переносим', async () => {
    const { project, workId } = await legacyProject('shop');
    const child = start();
    const sessionId = await seedSession(project, workId, {
      pid: child.pid ?? 0,
      startedAtProcess: await processStartedAt(child.pid ?? 0),
    });

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([{ status: 'skipped', reason: 'live-session', detail: `${workId}/${sessionId}` }]);
    await expectUntouched(project, workId);

    // Процесс ушёл — на следующем старте проект переезжает.
    await stop(child);
    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('мёртвый pid в карте (хост упал, процесс не дожил) — проект переносится', async () => {
    const { project, workId } = await legacyProject('shop');
    const dead = start();
    const startedAtProcess = await processStartedAt(dead.pid ?? 0);
    await stop(dead);
    await seedSession(project, workId, { pid: dead.pid ?? 0, startedAtProcess });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('sleeping с живым своим процессом держит проект; с чужим временем старта (pid достался другому) — нет', async () => {
    const { project, workId } = await legacyProject('shop');
    const child = start();
    // Так миграция v1 оставляет бывшую `done`: спит, а процесс жив.
    const own = await seedSession(project, workId, {
      lifecycle: 'sleeping',
      pid: child.pid ?? 0,
      startedAtProcess: await processStartedAt(child.pid ?? 0),
    });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'live-session', detail: `${workId}/${own}` }]);

    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === own);
      if (session) session.startedAtProcess = '2020-01-01T00:00:00.000Z';
    });
    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('сессии pending и closed процесса не держат, даже с pid в записи', async () => {
    const { project, workId } = await legacyProject('shop');
    const child = start();
    const startedAtProcess = await processStartedAt(child.pid ?? 0);
    await seedSession(project, workId, { lifecycle: 'closed', pid: child.pid ?? 0, startedAtProcess });
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'ждёт', task: 'задача' });
    });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('active без pid (команду напечатал CLI): недавно начатая — живая, давняя — нет', async () => {
    const { project, workId } = await legacyProject('shop');
    const startedAt = AT.toISOString();
    const id = await seedSession(project, workId, { launchedBy: 'cli', startedAt });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'live-session', detail: `${workId}/${id}` }]);

    const later = (): Date => new Date(AT.getTime() + 24 * 60 * 60 * 1000);
    expect(await migrateProjects({ now: later })).toMatchObject([{ status: 'moved' }]);
  });

  it('сессия из терминала (pending без pid): агент держит путь в командной строке — проект не переносим; ушёл — переносится', async () => {
    const { project, workId } = await legacyProject('shop');
    const id = await seedTerminalSession(project, workId);
    const agent = await startAgent(legacyDir(project), workId, id);

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([{ status: 'skipped', reason: 'live-session', detail: `pid ${agent.pid}` }]);
    await expectUntouched(project, workId);

    // Терминал закрыт — на следующем старте проект переезжает; в карте сессия по-прежнему pending.
    await stop(agent);
    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
    expect((await readMap(project, workId)).sessions[0]?.lifecycle).toBe('pending');
  });

  it('командная строка чужого проекта путь этого не держит, даже если имя каталога начинается так же', async () => {
    const shop = await legacyProject('shop');
    const sibling = await legacyProject('shop-old');
    const id = await seedTerminalSession(sibling.project, sibling.workId);
    await startAgent(legacyDir(sibling.project), sibling.workId, id);

    const results = await migrateProjects({ now });

    expect(results.map((result) => [result.projectPath, result.status])).toEqual([
      [shop.project, 'moved'],
      [sibling.project, 'skipped'],
    ]);
  });

  it('таблицу процессов получить нельзя (нет ps) — отказ, а не перенос вслепую', async () => {
    const { project, workId } = await legacyProject('shop');
    const before = process.env.PATH;
    process.env.PATH = path.join(root, 'нет-такого-каталога');
    try {
      expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'unreadable' }]);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
    await expectUntouched(project, workId);
  });

  it('.harnas закоммичен в git проекта — не переносим: отслеживаемые файлы остаются на месте, а .parley под своим .gitignore не закоммитить', async () => {
    const { project, workId } = await legacyProject('shop');
    await commitEverything(project);

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'tracked', from: legacyDir(project) }]);

    await expectUntouched(project, workId);
    expect((await git(project, ['status', '--porcelain'])).stdout).toBe('');
    expect(await exists(path.join(home, MIGRATION_RECORD))).toBe(false);
  });

  it('отслеживается один файл из .harnas — проект всё равно остаётся при прежнем каталоге', async () => {
    const { project, workId } = await legacyProject('shop');
    await git(project, ['init', '-q']);
    await git(project, ['config', 'user.email', 'тест@parley']);
    await git(project, ['config', 'user.name', 'тест']);
    await git(project, ['add', '-f', path.join('.harnas', 'works', workId, 'artifacts', 'note.txt')]);
    await git(project, ['commit', '-q', '-m', 'артефакт']);

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'tracked' }]);
    await expectUntouched(project, workId);
  });

  it('.git есть, но это не репозиторий (git отвечает отказом) — отслеживать нечему, проект переносится', async () => {
    const { project } = await legacyProject('shop');
    await mkdir(path.join(project, '.git'));

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('проект в репозитории, .harnas в .gitignore и не отслеживается — переносится', async () => {
    const { project } = await legacyProject('shop');
    // `.gitignore` лежит до `git add -A`: состояние работы в коммит не попадает.
    await commitEverything(project, ['.gitignore', '.harnas/\n']);

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
    expect((await git(project, ['status', '--porcelain', '-uall'])).stdout).toBe('?? .parley/.gitignore\n');
    await git(project, ['add', '-A']);
    expect((await git(project, ['diff', '--cached', '--name-only'])).stdout).toBe('.parley/.gitignore\n');
  });

  it('пути артефактов внутри прежнего каталога переписываются на .parley; прочие пути, проза и порядок работ остаются', async () => {
    const { project, workId } = await legacyProject('shop');
    const note = `.harnas/works/${workId}/artifacts/note.txt`;
    let sessionId = '';
    await updateMap(project, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 'задача' });
      sessionId = session.id;
      session.summary = `план лежит в ${note}`;
      session.artifacts = [
        { kind: 'заметка', path: note },
        { kind: 'с точкой', path: `./${note}` },
        { kind: 'спека', path: 'docs/spec.md' },
        { kind: 'вложенный', path: `sub/${note}` },
        { kind: 'похожий', path: '.harnas-backup/x.md' },
      ];
    });
    const before = await readMap(project, workId);
    const indexBefore = await readFile(worksIndexPath(), 'utf8');

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);

    const after = await readMap(project, workId);
    const session = after.sessions.find((candidate) => candidate.id === sessionId);
    const moved = `.parley/works/${workId}/artifacts/note.txt`;
    expect(session?.artifacts).toEqual([
      { kind: 'заметка', path: moved },
      { kind: 'с точкой', path: `./${moved}` },
      { kind: 'спека', path: 'docs/spec.md' },
      { kind: 'вложенный', path: `sub/${note}` },
      { kind: 'похожий', path: '.harnas-backup/x.md' },
    ]);
    // Записанный путь ведёт к настоящему файлу, как вёл до переноса.
    expect(await exists(path.join(project, session?.artifacts[0]?.path ?? ''))).toBe(true);
    // Сказанное прозой — запись о том, что было сказано; её не переписывают.
    expect(session?.summary).toBe(`план лежит в ${note}`);
    // Правка не событие работы: updatedAt стоит на месте, индекс не менялся.
    expect(after.work.updatedAt).toBe(before.work.updatedAt);
    expect(await readFile(worksIndexPath(), 'utf8')).toBe(indexBefore);
  });

  it('сохранённые брифы: относительные пути в каталог состояния переписываются, абсолютные и чужие — нет', async () => {
    const { project, workId } = await legacyProject('shop');
    const brief = path.join(legacyDir(project), 'works', workId, 'briefs', 's-01.md');
    const other = `/elsewhere/proj/.harnas/works/${workId}/artifacts/x.md`;
    await writeFile(
      brief,
      [
        'Артефакты:',
        `- план — .harnas/works/${workId}/artifacts/note.txt`,
        `См. \`.harnas/works/${workId}/map.json\` и ${other}`,
        `my.harnas/works/${workId} — не наш путь`,
        '',
      ].join('\n'),
    );

    await migrateProjects({ now });

    expect(await readFile(path.join(currentDir(project), 'works', workId, 'briefs', 's-01.md'), 'utf8')).toBe(
      [
        'Артефакты:',
        `- план — .parley/works/${workId}/artifacts/note.txt`,
        `См. \`.parley/works/${workId}/map.json\` и ${other}`,
        `my.harnas/works/${workId} — не наш путь`,
        '',
      ].join('\n'),
    );
  });

  it('map.lock у работы — проект не переносим', async () => {
    const { project, workId } = await legacyProject('shop');
    await writeFile(path.join(legacyDir(project), 'works', workId, 'map.lock'), '');

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'locked', detail: workId }]);

    await expectUntouched(project, workId);
  });

  it('проект целиком или никак: занятая работа держит соседнюю, другой проект переезжает', async () => {
    const busy = await legacyProject('busy');
    await writeFile(path.join(legacyDir(busy.project), 'works', busy.workId, 'map.lock'), '');
    const second = await createWork(busy.project, { title: 'Свободная работа того же проекта' });
    const free = await legacyProject('free');

    const results = await migrateProjects({ now });

    expect(results.map((result) => [result.projectPath, result.status])).toEqual([
      [busy.project, 'skipped'],
      [free.project, 'moved'],
    ]);
    expect(await exists(path.join(legacyDir(busy.project), 'works', second.work.id, 'map.json'))).toBe(true);
    expect(await exists(currentDir(busy.project))).toBe(false);
  });

  it('мёртвая запись индекса (проекта больше нет) пропускается, остальные переезжают', async () => {
    const gone = await legacyProject('gone');
    const alive = await legacyProject('alive');
    await rm(gone.project, { recursive: true, force: true });

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([
      { projectPath: gone.project, status: 'skipped', reason: 'no-legacy' },
      { projectPath: alive.project, status: 'moved' },
    ]);
    expect(await exists(gone.project)).toBe(false);
  });

  it('путь проекта в индексе теперь обычный файл — запись пропускается без исключения', async () => {
    const odd = await legacyProject('odd');
    await rm(odd.project, { recursive: true, force: true });
    await writeFile(odd.project, 'файл\n');

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'no-legacy' }]);
  });

  it('карта не разобралась — проект не переносим: живость по ней не проверить', async () => {
    const { project, workId } = await legacyProject('shop');
    await writeFile(path.join(legacyDir(project), 'works', workId, 'map.json'), '{ broken');

    const results = await migrateProjects({ now });

    expect(results).toMatchObject([{ status: 'skipped', reason: 'unreadable' }]);
    expect(await exists(currentDir(project))).toBe(false);
    expect(await readFile(path.join(legacyDir(project), 'works', workId, 'map.json'), 'utf8')).toBe('{ broken');
  });

  it('каталог работы без карты сессий не держит', async () => {
    const { project } = await legacyProject('shop');
    await mkdir(path.join(legacyDir(project), 'works', 'w-0099', 'artifacts'), { recursive: true });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
  });

  it('в .harnas ни одной работы (пустой каталог) — переносится', async () => {
    const { project, workId } = await legacyProject('shop');
    await rm(path.join(legacyDir(project), 'works'), { recursive: true });

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'moved' }]);
    expect(await exists(path.join(currentDir(project), 'works', workId))).toBe(false);
    expect(await readFile(path.join(currentDir(project), '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n!backlog.md\n!plans/\n!plans/**\n!memory.md\n!decisions/\n!decisions/**\n!history-shared/\n!history-shared/**\n');
  });

  it('свой .gitignore в прежнем каталоге остаётся как есть', async () => {
    const { project } = await legacyProject('shop');
    await writeFile(path.join(legacyDir(project), '.gitignore'), '*\n!keep\n');

    await migrateProjects({ now });

    expect(await readFile(path.join(currentDir(project), '.gitignore'), 'utf8')).toBe('*\n!keep\n');
  });

  it('проект без прежнего каталога (уже на .parley) — молча, ничего не трогается', async () => {
    const project = path.join(root, 'fresh');
    await createWork(project, { title: 'Новая' });
    const before = await readFile(path.join(project, '.parley', 'works', 'w-0001', 'map.json'), 'utf8');

    expect(await migrateProjects({ now })).toMatchObject([{ status: 'skipped', reason: 'no-legacy' }]);
    expect(await readFile(path.join(project, '.parley', 'works', 'w-0001', 'map.json'), 'utf8')).toBe(before);
    expect(await exists(path.join(home, MIGRATION_RECORD))).toBe(false);
  });

  it.skipIf(asRoot)('rename не удался — результат, а не исключение; проект на месте', async () => {
    const { project, workId } = await legacyProject('shop');
    await chmod(project, 0o500);

    const results = await migrateProjects({ now });

    await chmod(project, 0o700);
    expect(results).toMatchObject([{ status: 'skipped', reason: 'rename-failed' }]);
    await expectUntouched(project, workId);
  });

  it('индекс работ не разобрался — исключение: хост сам покажет этот отказ', async () => {
    await legacyProject('shop');
    await writeFile(worksIndexPath(), '{ broken');

    await expect(migrateProjects({ now })).rejects.toThrow('cannot be parsed');
  });

  it('индекса нет — переносить некому', async () => {
    expect(await migrateProjects({ now })).toEqual([]);
    expect((await readWorksIndex()).works).toEqual([]);
  });
});
