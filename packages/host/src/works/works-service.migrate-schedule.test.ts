import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addSession, createWork, transitionSession, updateMap, workPaths } from '@parley/core';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Когда и сколько раз хост берётся за миграцию карты (v2 → v3): не внутри `refresh`, не на каждом обновлении и не вечно.
 * Швы — обёртки над `migrateMapToJournal`, `hasLiveSession` и `workSchemaVersion` ядра: считаются вызовы, время не мерится.
 */
const seams = vi.hoisted(() => ({
  migrate: undefined as undefined | ((workId: string) => Promise<unknown> | undefined),
}));
vi.mock('@parley/core', async (original) => {
  const actual = await original<typeof import('@parley/core')>();
  return {
    ...actual,
    migrateMapToJournal: vi.fn(async (...args: Parameters<typeof actual.migrateMapToJournal>) => {
      const replaced = seams.migrate?.(args[1]);
      return replaced === undefined ? actual.migrateMapToJournal(...args) : replaced;
    }),
    hasLiveSession: vi.fn(actual.hasLiveSession),
    workSchemaVersion: vi.fn(actual.workSchemaVersion),
  };
});
const core = await import('@parley/core');

let home = '';
let project = '';
let events: string[];
let infos: Array<{ message: string; data: unknown }>;
let errors: Array<{ message: string; data: unknown }>;
let services: WorksService[] = [];

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: {
      info: (message, data) => {
        events.push(`info:${message}`);
        infos.push({ message, data });
      },
      warn: () => {},
      error: (message, data) => errors.push({ message, data }),
    },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event) => events.push(`broadcast:${event}`),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  events = [];
  infos = [];
  errors = [];
  seams.migrate = undefined;
  vi.mocked(core.migrateMapToJournal).mockClear();
  vi.mocked(core.hasLiveSession).mockClear();
  vi.mocked(core.workSchemaVersion).mockClear();
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(options: { migrationRetryMs?: number } = {}): WorksService {
  const created = createWorksService(fakeHost(), { debounceMs: 20, migrateMaps: true, ...options });
  services.push(created);
  return created;
}

const versionOnDisk = async (workId: string): Promise<number> =>
  (JSON.parse(await readFile(workPaths(project, workId).map, 'utf8')) as { schemaVersion: number }).schemaVersion;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const migrateCalls = (workId: string): number => vi.mocked(core.migrateMapToJournal).mock.calls.filter((call) => call[1] === workId).length;

/** Работа на v2 с сессией и двумя письмами; `live` — сессия активна, и её pid — этот процесс. */
async function seed(live = false): Promise<string> {
  const { work } = await createWork(project, { title: 'W' });
  await updateMap(project, work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
    if (live) {
      session.pid = process.pid;
      transitionSession(map, session.id, 'active');
    }
    addMessage(map, { roomId: null, from: 'human', to: [session.id], text: 'первое' });
    addMessage(map, { roomId: null, from: 'human', to: [session.id], text: 'второе' });
  });
  return work.id;
}

/** Обновления без смены миграционного состояния: запись в карту будит наблюдателя, он зовёт `refresh`. */
async function pokeRefreshes(workId: string, times: number): Promise<void> {
  for (let at = 0; at < times; at += 1) {
    await updateMap(project, workId, (map) => void (map.work.goal = `цель ${at}`)).catch(() => {});
    await sleep(80);
  }
}

describe('расписание миграции карты в хосте', () => {
  it('первый start() не ждёт миграции: она заперта, а хост уже отдал снимок', async () => {
    const id = await seed();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const actual = await vi.importActual<typeof import('@parley/core')>('@parley/core');
    seams.migrate = (workId) => (workId === id ? gate.then(() => actual.migrateMapToJournal(project, workId)) : undefined);

    const s = service();
    const started = await Promise.race([s.start().then(() => 'started'), sleep(1500).then(() => 'blocked')]);

    expect(started).toBe('started');
    expect(events).toContain('broadcast:works.changed');
    expect(await versionOnDisk(id)).toBe(2);
    open();
    await s.migrationSettled();
    expect(await versionOnDisk(id)).toBe(3);
  });

  it('сбой одной работы не мешает остальным, не повторяется на следующих обновлениях и не пишется в журнал снова; итог — одной строкой', async () => {
    const [broken, first, second] = [await seed(), await seed(), await seed()];
    seams.migrate = (workId) => {
      if (workId === broken) throw new Error('диск сломан');
      return undefined;
    };

    const s = service();
    await s.start();
    await s.migrationSettled();
    await pokeRefreshes(first, 4);
    await s.migrationSettled();

    expect(await versionOnDisk(first)).toBe(3);
    expect(await versionOnDisk(second)).toBe(3);
    expect(await versionOnDisk(broken)).toBe(2);
    expect(migrateCalls(broken)).toBe(1);
    expect(errors.filter((item) => item.message.includes('проверка не удалась'))).toHaveLength(1);
    const summaries = infos.filter((item) => item.message.startsWith('карта: миграция завершена'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.data).toMatchObject({ migrated: 2, failed: 1, waiting: 0 });
  });

  it('пропуск по причине, которая не меняется (карта не v2), не повторяется на каждом обновлении', async () => {
    const id = await seed();
    seams.migrate = (workId) => (workId === id ? Promise.resolve({ status: 'skipped', reason: 'not-v2' }) : undefined);

    const s = service();
    await s.start();
    await s.migrationSettled();
    await pokeRefreshes(id, 4);
    await s.migrationSettled();

    expect(migrateCalls(id)).toBe(1);
  });

  it('живая сессия: проверка повторяется ограниченное число раз (три повтора с удвоением), пометка остаётся, больше хост не пытается', async () => {
    const id = await seed(true);
    const s = service({ migrationRetryMs: 20 });
    await s.start();
    await s.migrationSettled();
    await vi.waitFor(() => expect(vi.mocked(core.hasLiveSession).mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 5000, interval: 10 });
    await pokeRefreshes(id, 4);
    await sleep(400);

    expect(vi.mocked(core.hasLiveSession).mock.calls).toHaveLength(4);
    expect(migrateCalls(id)).toBe(0);
    expect(await versionOnDisk(id)).toBe(2);
    expect(s.entry(project, id)?.migrationPending).toBe(true);
  }, 20_000);

  it('сессия уснула во время повторов — работа переводится на v3, пометка снимается', async () => {
    const id = await seed(true);
    const s = service({ migrationRetryMs: 150 });
    await s.start();
    await s.migrationSettled();
    expect(s.entry(project, id)?.migrationPending).toBe(true);

    await updateMap(project, id, (map) => {
      transitionSession(map, 's-01', 'sleeping', { exitCode: 0 });
      map.sessions[0]!.pid = null;
    });
    await vi.waitFor(async () => expect(await versionOnDisk(id)).toBe(3), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(s.entry(project, id)?.migrationPending).toBeUndefined(), { timeout: 5000, interval: 20 });
  }, 20_000);

  it('две работы за один проход: обе на v3, итог одной строкой', async () => {
    const [one, two] = [await seed(), await seed()];
    const s = service();
    await s.start();
    await s.migrationSettled();

    expect(await versionOnDisk(one)).toBe(3);
    expect(await versionOnDisk(two)).toBe(3);
    const summaries = infos.filter((item) => item.message.startsWith('карта: миграция завершена'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.data).toMatchObject({ migrated: 2, failed: 0, waiting: 0 });
  });
});
