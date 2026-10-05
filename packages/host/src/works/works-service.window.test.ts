import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addRoom, addSession, createWork, setWorkStatus, updateMap } from '@parley/core';
import { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, MAX_LINE_BYTES } from '@parley/protocol';
import type { EventData, EventName, WorksSnapshot } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

let home = '';
let project = '';
let services: WorksService[] = [];
let clients: FakeClient[] = [];
let broadcasts: Array<{ event: EventName; data: unknown; to: string[] }> = [];
let warnings: string[] = [];

interface FakeClient extends Client {
  sent: Array<{ event?: string; data?: unknown }>;
}

function fakeClient(features: string[]): FakeClient {
  const sent: FakeClient['sent'] = [];
  const client: FakeClient = {
    id: randomUUID(),
    name: 'test',
    features: new Set(features),
    sent,
    send(message) {
      sent.push(message as { event?: string; data?: unknown });
      return true;
    },
    writableLength: () => 0,
    close() {},
  };
  clients.push(client);
  return client;
}

/** Хост с настоящей раздачей по клиентам: `broadcast` уважает фильтр и пишет, кому ушло. */
function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    clients: () => clients,
    liveSessions: () => 0,
    broadcast: (event, data, only) => {
      const to = clients.filter((client) => only === undefined || only(client));
      broadcasts.push({ event, data: data as EventData<EventName>, to: to.map((client) => client.id) });
      for (const client of to) client.send({ event, data });
    },
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

function service(): WorksService {
  const created = createWorksService(fakeHost(), { debounceMs: 5 });
  services.push(created);
  return created;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  clients = [];
  broadcasts = [];
  warnings = [];
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа с комнатой и перепиской: `count` писем по `size` знаков. */
async function seedWork(title: string, count: number, size: number, status?: 'archived'): Promise<string> {
  const map = await createWork(project, { title, goal: 'цель' });
  await updateMap(project, map.work.id, (current) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'x' });
    addSession(current, { provider: 'claude', label: 'код', task: 'y', parent: 's-01' });
    addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
    for (let i = 0; i < count; i += 1) addMessage(current, { from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(size, 'я') });
  });
  if (status !== undefined) await setWorkStatus(project, map.work.id, status);
  return map.work.id;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

describe('снимки для окна (P35)', () => {
  it('окно с compact-works получает компактный снимок с номером, прежнее окно — полный: письма не потеряны', async () => {
    const workId = await seedWork('А', 400, 200);
    const compactClient = fakeClient([COMPACT_WORKS_FEATURE]);
    const legacyClient = fakeClient([]);
    const s = service();
    await s.start();

    const window = s.windowSnapshot();
    const legacy = s.legacySnapshot();
    expect(window?.revision).toBeGreaterThan(0);
    const compactMap = window?.entries[0]?.map;
    expect(compactMap?.messages.length).toBeLessThan(400);
    expect(compactMap?.messages.at(-1)?.id).toBe('m-400');
    expect(compactMap?.compact?.messages).toMatchObject({ total: 400, latestId: 'm-400' });
    expect(legacy?.entries[0]?.map.messages).toHaveLength(400);
    expect(legacy?.entries[0]?.map.compact).toBeUndefined();
    // Сервисам хоста по-прежнему отдаётся полная карта.
    expect(s.snapshot().entries[0]?.map.messages).toHaveLength(400);
    expect(s.entry(project, workId)?.map.messages).toHaveLength(400);

    const forCompact = compactClient.sent.filter((message) => message.event === 'works.changed').at(-1)?.data as WorksSnapshot;
    const forLegacy = legacyClient.sent.filter((message) => message.event === 'works.changed').at(-1)?.data as WorksSnapshot;
    expect(forCompact.entries[0]?.map.compact).toBeDefined();
    expect(forLegacy.entries[0]?.map.messages).toHaveLength(400);
  });

  it('номер снимка растёт на каждую рассылку и совпадает у works.list и события', async () => {
    await seedWork('А', 3, 20);
    const compactClient = fakeClient([COMPACT_WORKS_FEATURE]);
    const s = service();
    await s.start();
    const first = s.windowSnapshot()?.revision as number;
    // Наблюдатель файлов (FSEvents) оживает не мгновенно: запись сразу после старта он мог бы не заметить.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await updateMap(project, 'w-0001', (current) => {
      addMessage(current, { from: 's-02', to: [], roomId: 'r-01', text: 'ещё' });
    });
    // Снимок обновляется и от служебных записей (аренда хоста), поэтому ждём именно новое письмо.
    await vi.waitFor(() => expect(s.windowSnapshot()?.entries[0]?.map.compact?.messages.latestId).toBe('m-04'), { timeout: 10_000, interval: 10 });
    const second = s.windowSnapshot();
    expect(second?.revision).toBeGreaterThan(first);
    const events = compactClient.sent.filter((message) => message.event === 'works.changed').map((message) => (message.data as WorksSnapshot).revision as number);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    expect(new Set(events).size).toBe(events.length);
    expect(events.at(-1)).toBe(second?.revision);
  }, 20_000);

  it('воспроизведение 1 аудита (900 писем по 10 000 знаков): полный снимок выше кадра, компактный — в разы ниже; старому окну — ни одного кадра, только запись в журнал', async () => {
    await seedWork('А', 900, 10_000);
    const compactClient = fakeClient([COMPACT_WORKS_FEATURE]);
    const legacyClient = fakeClient([]);
    const s = service();
    await s.start();
    expect(bytes(s.snapshot())).toBeGreaterThan(MAX_LINE_BYTES);
    expect(s.legacySnapshot()).toBeNull();
    const window = s.windowSnapshot() as WorksSnapshot;
    expect(bytes(window)).toBeLessThan(2 * 1024 * 1024);

    // Прежнему окну — ни снимка, ни неизвестного ему вида уведомления; хост один раз записывает причину.
    expect(legacyClient.sent).toEqual([]);
    expect(warnings.filter((message) => message.includes('compact-works'))).toHaveLength(1);
    expect(compactClient.sent.filter((message) => message.event === 'works.changed').length).toBeGreaterThan(0);
    // Ни один кадр, ушедший клиентам, не превышает предел.
    for (const client of clients) for (const message of client.sent) expect(bytes(message)).toBeLessThan(MAX_LINE_BYTES);
  });

  it('воспроизведение 2 (2 100 решений по 4 000 знаков): компактный снимок в пределах бюджета', async () => {
    const map = await createWork(project, { title: 'Решения', goal: '' });
    await updateMap(project, map.work.id, (current) => {
      addSession(current, { provider: 'claude', label: 'план', task: 'x' });
      addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01'], lead: 's-01' });
      for (let i = 0; i < 2100; i += 1) addMessage(current, { from: 's-01', to: [], roomId: 'r-01', kind: 'decision', text: `${i}:`.padEnd(4000, 'я') });
    });
    const s = service();
    await s.start();
    expect(bytes(s.snapshot())).toBeGreaterThan(MAX_LINE_BYTES);
    expect(bytes(s.windowSnapshot())).toBeLessThan(2 * 1024 * 1024);
  });

  it('10 тыс. писем в четырёх работах и архивная работа: бюджет делится, архив без писем, кадр далеко от предела', async () => {
    for (const title of ['1', '2', '3', '4']) await seedWork(title, 2500, 1500);
    await seedWork('архив', 2500, 1500, 'archived');
    const s = service();
    await s.start();
    const window = s.windowSnapshot() as WorksSnapshot;
    expect(window.entries).toHaveLength(5);
    const archived = window.entries.find((entry) => entry.map.work.title === 'архив')?.map;
    expect(archived?.messages).toEqual([]);
    expect(archived?.compact?.messages.total).toBe(2500);
    expect(archived?.compact?.unread.rooms['r-01']).toBe(2500);
    for (const entry of window.entries) expect(entry.map.compact?.messages.total).toBe(2500);
    expect(bytes(window)).toBeLessThan(4 * 1024 * 1024);
    expect(bytes(s.snapshot())).toBeGreaterThan(MAX_LINE_BYTES);
  });

  it('полный снимок чуть ниже предела старому окну отдаётся как есть', async () => {
    await seedWork('А', 50, 200);
    const s = service();
    await s.start();
    expect(bytes(s.snapshot())).toBeLessThan(LEGACY_SNAPSHOT_MAX_BYTES);
    expect(s.legacySnapshot()?.entries[0]?.map.messages).toHaveLength(50);
  });

  it('снимок выше потолка — запасной вариант: письма не берутся, тексты короче; всё равно не влезает — null, кадр не уходит, одно уведомление только новому окну', async () => {
    const map = await createWork(project, { title: 'Большая', goal: '' });
    await updateMap(project, map.work.id, (current) => {
      for (let i = 0; i < 300; i += 1) addSession(current, { provider: 'claude', label: `с${i}`, task: 'ж'.repeat(10_000) });
    });
    const s = service();
    await s.start();
    const fallback = s.windowSnapshot() as WorksSnapshot;
    expect(bytes(fallback)).toBeLessThan(5 * 1024 * 1024);
    expect(fallback.entries[0]?.map.sessions[0]?.task).toContain('cut: ');
    expect(fallback.entries[0]?.map.compact?.cut.length).toBeGreaterThan(0);

    // Две тысячи сессий с задачами по 10 000 знаков: и сжатый вариант больше потолка.
    await updateMap(project, map.work.id, (current) => {
      for (let i = 0; i < 2200; i += 1) addSession(current, { provider: 'claude', label: `д${i}`, task: 'ж'.repeat(10_000) });
    });
    const compactClient = fakeClient([COMPACT_WORKS_FEATURE]);
    const legacyClient = fakeClient([]);
    await vi.waitFor(() => expect(s.windowSnapshot()).toBeNull(), { timeout: 15_000, interval: 20 });
    const notices = compactClient.sent.filter((message) => message.event === 'host.notice');
    expect(notices.map((message) => (message.data as { kind: string }).kind)).toEqual(['snapshot-too-large']);
    expect(compactClient.sent.filter((message) => message.event === 'works.changed')).toHaveLength(0);
    expect(legacyClient.sent).toEqual([]);
    for (const client of clients) for (const message of client.sent) expect(bytes(message)).toBeLessThan(MAX_LINE_BYTES);
  }, 30_000);
});
