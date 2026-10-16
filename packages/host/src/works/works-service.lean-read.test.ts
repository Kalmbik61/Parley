import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, addMessage, addRoom, addSession, createWork, migrateMapToJournal, transitionSession, updateMap } from '@parley/core';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Сверка живости и перечитывание карты нового проекта не читают журналы писем: им нужны сессии из индекса. Письма
 * работы уже в снимке (их ведёт хвост), поэтому лишнее чтение журнала на каждый `refresh` — чистая трата.
 * Шов — `open` из `node:fs/promises`: ядро открывает журнал комнаты через него, и тест считает открытия.
 */
let home = '';
let project = '';
let services: WorksService[] = [];
let opened: string[] = [];
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
  opened = [];
  (fsPromises as { open: unknown }).open = (async (...args: Parameters<typeof realOpen>) => {
    if (String(args[0]).endsWith('messages.jsonl')) opened.push(String(args[0]));
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

/** Работа на журналах (v3): комната с письмом и сессия; `candidate` — сессия active с живым pid (кандидат сверки живости). */
async function seedJournalWork(candidate: boolean): Promise<void> {
  const { work } = await createWork(project, { title: 'W' });
  await updateMap(project, work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
    const room = addRoom(map, { title: 'Комната', creator: HUMAN, members: [session.id], lead: session.id });
    addMessage(map, { roomId: room.id, from: HUMAN, to: [session.id], text: 'письмо' });
  });
  expect(await migrateMapToJournal(project, work.id)).toMatchObject({ status: 'migrated' });
  if (candidate) {
    await updateMap(project, work.id, (map) => {
      const session = map.sessions[0]!;
      session.pid = process.pid;
      transitionSession(map, session.id, 'active');
    });
  }
}

/** Сколько раз открыт журнал комнаты, пока сервис стартует. */
async function journalOpensDuringStart(): Promise<number> {
  const s = createWorksService(fakeHost(), { debounceMs: 50 });
  services.push(s);
  await s.start();
  const count = opened.filter((file) => file.includes(`${path.sep}rooms${path.sep}`)).length;
  await s.stop();
  services = services.filter((candidate) => candidate !== s);
  return count;
}

describe('сверка живости на карте-журнале', () => {
  it('работа с живым кандидатом не стоит лишнего чтения журналов против работы без кандидата', async () => {
    await seedJournalWork(false);
    opened = [];
    const without = await journalOpensDuringStart();

    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
    process.env.PARLEY_HOME = home;
    opened = [];
    await seedJournalWork(true);
    opened = [];
    const withCandidate = await journalOpensDuringStart();

    expect(without).toBeGreaterThan(0);
    expect(withCandidate).toBe(without);
  });
});
