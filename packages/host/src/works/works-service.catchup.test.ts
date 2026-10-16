import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addRoom, addSession, appendMessage, createWork, migrateMapToJournal, updateMap, workPaths } from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { EventName } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Потерянное событие наблюдателя (на macOS FSEvents теряет записи, см. `watch-settle.ts`): письмо в журнале есть, а событие о
 * нём не пришло. Подмена `watchWorks` глушит `onChange` по флагу; дочитывание журналов идёт на проходах `refresh` и дочитывания.
 */
vi.setConfig({ testTimeout: 30_000 });

const gate = vi.hoisted(() => ({ silenced: false }));
vi.mock('@parley/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/core')>();
  return {
    ...actual,
    watchWorks: (...args: Parameters<typeof actual.watchWorks>) => {
      const [onWorks, projectPath, options] = args;
      const onChange = options?.onChange;
      return actual.watchWorks(onWorks, projectPath, {
        ...options,
        ...(onChange === undefined ? {} : { onChange: (change) => { if (!gate.silenced) onChange(change); } }),
      });
    },
  };
});

let home = '';
let project = '';
let services: WorksService[] = [];
let clients: Client[] = [];
let broadcasts: Array<{ event: EventName; to: string[] }> = [];

function fakeClient(features: string[]): Client {
  const client: Client = { id: randomUUID(), name: 'test', features: new Set(features), send: () => true, writableLength: () => 0, close() {} };
  clients.push(client);
  return client;
}

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => clients,
    liveSessions: () => 0,
    broadcast: (event, _data, only) => {
      broadcasts.push({ event, to: clients.filter((client) => only === undefined || only(client)).map((client) => client.id) });
    },
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  clients = [];
  broadcasts = [];
  gate.silenced = false;
});

afterEach(async () => {
  gate.silenced = false;
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedJournal(title: string): Promise<string> {
  const { work } = await createWork(project, { title });
  await updateMap(project, work.id, (map) => {
    addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addSession(map, { provider: 'claude', label: 'b', task: 't' });
    addRoom(map, { title: 'Комната', creator: 's-01', members: ['s-01', 's-02'] });
    addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'старое' });
  });
  expect((await migrateMapToJournal(project, work.id, { run: new Date().toISOString() })).status).toBe('migrated');
  return work.id;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const mailEvents = (): typeof broadcasts => broadcasts.filter((item) => item.event === 'rooms.mail' && item.to.length > 0);
const line = (seq: number, text: string): string =>
  `${JSON.stringify({ seq, id: `m-r01-${seq}`, roomId: 'r-01', from: 's-02', to: ['s-01'], text, kind: 'note', at: new Date().toISOString() })}\n`;

describe('потерянное событие наблюдателя: дочитывание журналов', () => {
  it('проход дочитывания после старта находит письмо, событие о котором не пришло: оно в окне и у onMail', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const service = createWorksService(fakeHost(), { debounceMs: 5 });
    services.push(service);
    const got: string[] = [];
    service.onMail((mail) => got.push(...mail.appended.map((letter) => letter.id)));
    await service.start();

    // Событие потеряно: письмо дописано, наблюдатель молчит. Первый проход дочитывания — через 300 мс после заведения наблюдателей.
    gate.silenced = true;
    await appendMessage(project, id, 'r-01', { from: 's-02', to: ['s-01'], text: 'потерянное' });
    await vi.waitFor(() => expect(got).toEqual(['m-r01-2']), { timeout: 8000 });
    expect(service.windowSnapshot()?.entries[0]?.map.messages.map((message) => message.id).sort()).toEqual(['m-01', 'm-r01-2']);
    expect(mailEvents()).toHaveLength(1);
  });

  it('refresh по изменению индекса ДРУГОЙ работы находит письмо в журнале с заведённым хвостом, событие которого потеряно (запись A переиспользована)', async () => {
    const id = await seedJournal('A');
    const other = await seedJournal('B');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const service = createWorksService(fakeHost(), { debounceMs: 5 });
    services.push(service);
    await service.start();
    await sleep(3600);
    // Хвост заведён настоящим письмом.
    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'первое' });
    await vi.waitFor(() => expect(mailEvents()).toHaveLength(1), { timeout: 5000 });
    broadcasts = [];
    const got: string[] = [];
    service.onMail((mail) => got.push(...mail.appended.map((letter) => letter.id)));

    gate.silenced = true;
    await appendFile(path.join(workPaths(project, id).rooms, 'r-01', 'messages.jsonl'), line(3, 'потерянное'));
    await sleep(600);
    expect(got).toEqual([]);

    gate.silenced = false;
    await updateMap(project, other, (map) => {
      map.work.goal = 'цель';
    });
    await vi.waitFor(() => expect(got).toEqual(['m-r01-3']), { timeout: 5000 });
    expect(service.entry(project, id)?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-r01-2', 'm-r01-3']);
    expect(service.windowSnapshot()?.entries[0]?.map.messages.map((message) => message.id)).toContain('m-r01-3');
  });
});
