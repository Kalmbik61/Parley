import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addSession, createWork, readIndex, transitionSession, updateMap, workPaths } from '@parley/core';
import type { EventName } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Миграция карты v2 → v3 в хосте (план задачи 7): когда она идёт, когда ждёт и когда хост убирает `map.v2.json`.
 * Работы собираются в v2 обычными средствами core; письма пишет `updateMap`, пока карта v2.
 */
let home = '';
let project = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: WorksService[] = [];
let warnings: Array<{ message: string; data: unknown }>;

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: (message, data) => warnings.push({ message, data }), error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  broadcasts = [];
  warnings = [];
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(options: { migrationRetryMs?: number } = {}): WorksService {
  const created = createWorksService(fakeHost(), { debounceMs: 50, migrateMaps: true, ...options });
  services.push(created);
  return created;
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
const versionOnDisk = async (workId: string): Promise<number> =>
  (JSON.parse(await readFile(workPaths(project, workId).map, 'utf8')) as { schemaVersion: number }).schemaVersion;
const v2Copy = (workId: string): string => path.join(workPaths(project, workId).dir, 'map.v2.json');

/** Работа на v2 с сессией s-01 (ожидающей) и двумя письмами; `live` — сессия активна, и её pid — этот процесс. */
async function seed(live: boolean): Promise<string> {
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

describe('миграция карты в хосте', () => {
  it('работа без живых сессий мигрирует на старте: v3 на диске, письма в снимке, флага ожидания нет, копия лежит', async () => {
    const id = await seed(false);
    expect(await versionOnDisk(id)).toBe(2);

    const s = service();
    await s.start();
    await s.migrationSettled();

    expect(await versionOnDisk(id)).toBe(3);
    const entry = s.entry(project, id);
    expect(entry?.map.messages.map((message) => message.text)).toEqual(['первое', 'второе']);
    expect(entry?.migrationPending).toBeUndefined();
    expect(s.windowSnapshot()?.entries[0]?.migrationPending).toBeUndefined();
    expect(await exists(v2Copy(id))).toBe(true);
    // Работа осталась в списке и после того, как её перечитал наблюдатель (читатель списка понимает v3).
    await vi.waitFor(() => expect(s.snapshot().entries.map((item) => item.map.work.id)).toEqual([id]), { timeout: 5000 });
    expect(s.entry(project, id)?.map.messages).toHaveLength(2);
  });

  it('работа с живой сессией остаётся на v2 и помечена migrationPending в снимке окна; уснула — мигрирует', async () => {
    const id = await seed(true);
    const before = await readFile(workPaths(project, id).map, 'utf8');

    const s = service({ migrationRetryMs: 150 });
    await s.start();
    await s.migrationSettled();

    expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(before);
    expect(await exists(v2Copy(id))).toBe(false);
    expect(s.entry(project, id)?.migrationPending).toBe(true);
    expect(s.windowSnapshot()?.entries[0]?.migrationPending).toBe(true);
    expect(s.snapshot().entries[0]?.migrationPending).toBe(true);

    // Сессия ушла: повторная проверка (по таймеру) переводит работу на v3 и снимает пометку.
    await updateMap(project, id, (map) => {
      transitionSession(map, 's-01', 'sleeping', { exitCode: 0 });
      map.sessions[0]!.pid = null;
    });
    await vi.waitFor(async () => expect(await versionOnDisk(id)).toBe(3), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(s.entry(project, id)?.migrationPending).toBeUndefined(), { timeout: 10_000, interval: 20 });
    expect(s.entry(project, id)?.map.messages).toHaveLength(2);
  }, 20_000);

  it('map.v2.json остаётся на весь запуск, где была миграция, и убирается при следующем старте хоста', async () => {
    const id = await seed(false);
    const first = service();
    await first.start();
    await first.migrationSettled();
    expect(await exists(v2Copy(id))).toBe(true);
    expect((await readIndex(project, id)).v2Removed).toBe(false);
    // Ещё одно обновление в том же запуске копию не трогает.
    await updateMap(project, id, (map) => void map.work.goal);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await exists(v2Copy(id))).toBe(true);
    await first.stop();

    const second = service();
    await second.start();
    await second.migrationSettled();
    expect(await exists(v2Copy(id))).toBe(false);
    expect((await readIndex(project, id)).v2Removed).toBe(true);
    expect(second.entry(project, id)?.map.messages).toHaveLength(2);
  }, 20_000);
});

describe('копия v2 при потерянных сведениях', () => {
  it('письмо комнаты, которой нет в индексе, оставляет map.v2.json и после следующего запуска; причина с числами — в журнале хоста', async () => {
    const { work } = await createWork(project, { title: 'W' });
    await updateMap(project, work.id, (map) => {
      addMessage(map, { roomId: null, from: 'human', to: [], text: 'прямое' });
      addMessage(map, { roomId: 'r-77', from: 'human', to: [], text: 'без комнаты' });
    });
    const first = service();
    await first.start();
    await first.migrationSettled();
    expect(await versionOnDisk(work.id)).toBe(3);
    await first.stop();

    const second = service();
    await second.start();
    await second.migrationSettled();
    expect(await exists(v2Copy(work.id))).toBe(true);
    expect((await readIndex(project, work.id)).v2Removed).toBe(false);
    const kept = warnings.find((item) => item.message.includes('map.v2.json оставлена навсегда'));
    expect(kept?.data).toMatchObject({ workId: work.id, orphaned: 1, droppedMarks: 0, readByMismatches: 0, orderMismatches: 0 });
  }, 20_000);
});
