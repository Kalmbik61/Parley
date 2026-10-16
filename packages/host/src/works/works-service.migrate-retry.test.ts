import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addSession, createWork, updateMap, workPaths } from '@parley/core';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Сбой проверки при миграции (EMFILE, гонка чтения) — не вердикт «переводить не нужно»: работа повторяется ограниченное число
 * раз и пока помечена `migrationPending`. Сбой подставлен на шве `open` из `node:fs/promises`: им `workSchemaVersion`
 * открывает `map.json` в начале проверки работы.
 */
let home = '';
let project = '';
let services: WorksService[] = [];
let failures = 0;
let failOpen = 0;
const realOpen = fsPromises.open;

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  failures = 0;
  failOpen = 0;
  (fsPromises as { open: unknown }).open = (async (...args: Parameters<typeof realOpen>) => {
    if (failOpen > 0 && String(args[0]).endsWith('map.json')) {
      failOpen -= 1;
      failures += 1;
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return realOpen(...args);
  }) as typeof realOpen;
  syncBuiltinESMExports();
});

afterEach(async () => {
  (fsPromises as { open: unknown }).open = realOpen;
  syncBuiltinESMExports();
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const versionOnDisk = async (workId: string): Promise<number> =>
  (JSON.parse(await readFile(workPaths(project, workId).map, 'utf8')) as { schemaVersion: number }).schemaVersion;

async function seed(): Promise<string> {
  const { work } = await createWork(project, { title: 'W' });
  await updateMap(project, work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addMessage(map, { roomId: null, from: 'human', to: [session.id], text: 'письмо' });
  });
  return work.id;
}

function service(): WorksService {
  const created = createWorksService(fakeHost(), { debounceMs: 50, migrateMaps: true, migrationRetryMs: 40 });
  services.push(created);
  return created;
}

describe('миграция: сбой проверки повторяется', () => {
  it('разовый сбой: работа помечена migrationPending, повтор по таймеру переводит её на v3 и снимает пометку', async () => {
    const id = await seed();
    // Старт читает карту через readFile; `open` по map.json первым делом зовёт проверка версии в миграции.
    failOpen = 1;
    const s = service();
    await s.start();
    await s.migrationSettled();

    expect(failures).toBe(1);
    expect(await versionOnDisk(id)).toBe(2);
    expect(s.entry(project, id)?.migrationPending).toBe(true);

    await vi.waitFor(async () => expect(await versionOnDisk(id)).toBe(3), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(s.entry(project, id)?.migrationPending).toBeUndefined(), { timeout: 10_000, interval: 20 });
    expect(s.entry(project, id)?.map.messages).toHaveLength(1);
  }, 20_000);

  it('постоянный сбой: попыток первая и три повтора, потом работа ждёт следующего запуска хоста; пометка остаётся', async () => {
    const id = await seed();
    failOpen = Number.POSITIVE_INFINITY;
    const s = service();
    await s.start();
    await s.migrationSettled();

    // Повторы идут с удвоением (40, 80, 160 мс); ждём, пока не пройдут все.
    await vi.waitFor(() => expect(failures).toBe(4), { timeout: 10_000, interval: 20 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await s.migrationSettled();

    expect(failures).toBe(4);
    expect(await versionOnDisk(id)).toBe(2);
    expect(s.entry(project, id)?.migrationPending).toBe(true);
  }, 20_000);
});
