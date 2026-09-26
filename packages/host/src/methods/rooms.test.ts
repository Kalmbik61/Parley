import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, HUMAN, readMap, transitionSession, updateMap } from '@harnas/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];
let clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

/**
 * Хост, клиент после `hello` и работа с тремя живыми сессиями TUI: у них нет
 * PTY хоста, и будильник их не трогает — здесь проверяются только правила
 * записи в карту и коды ответа.
 */
async function setup(): Promise<{ client: TestClient; dir: string; workId: string; ids: string[] }> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-rooms-project-'));
  projects.push(dir);

  const map = await createWork(dir, { title: 'Работа' });
  const ids: string[] = [];
  await updateMap(dir, map.work.id, (current) => {
    for (const label of ['один', 'два', 'три']) {
      const session = addSession(current, { provider: 'claude', label, task: 't' });
      session.launchedBy = 'tui';
      transitionSession(current, session.id, 'active');
      ids.push(session.id);
    }
  });

  const client = connectRaw(hostPaths(home).socket);
  clients.push(client);
  await waitConnected(client.socket);
  await hello(client, token);
  return { client, dir, workId: map.work.id, ids };
}

let nextId = 1;
/** Ответ на свой запрос: события хоста (`works.changed` и др.) идут тем же сокетом. */
async function call(client: TestClient, method: string, params: unknown): Promise<RawMessage> {
  const id = nextId;
  nextId += 1;
  client.send({ id, method, params });
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

describe('rooms.create / rooms.send', () => {
  it('rooms.create: создатель human, участники — заданные, им приглашение', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];

    const response = await call(client, 'rooms.create', {
      projectPath: dir,
      workId,
      title: 'Ревью «схемы»',
      members: [a, b, a, HUMAN],
    });
    expect(response.result).toEqual({ roomId: 'r-01' });

    const map = await readMap(dir, workId);
    expect(map.rooms[0]).toMatchObject({ id: 'r-01', title: 'Ревью «схемы»', creator: HUMAN, members: [a, b] });
    const invites = map.messages.filter((message) => message.roomId === 'r-01');
    expect(invites.map((message) => message.to)).toEqual([[a], [b]]);
    expect(invites.every((message) => message.from === HUMAN)).toBe(true);
  });

  it('rooms.send: письмо от human, без лимита; без комнаты — ровно один адресат', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];

    // Лимит агента — 20 писем в час; человеку он не указ.
    for (let i = 0; i < 25; i += 1) {
      const sent = await call(client, 'rooms.send', {
        projectPath: dir,
        workId,
        roomId: null,
        to: [a],
        text: `письмо ${i}`,
        kind: 'note',
      });
      expect(sent.error).toBeUndefined();
    }
    const map = await readMap(dir, workId);
    expect(map.messages).toHaveLength(25);
    expect(map.messages.every((message) => message.from === HUMAN && message.roomId === null)).toBe(true);

    const two = await call(client, 'rooms.send', {
      projectPath: dir,
      workId,
      roomId: null,
      to: [a, b],
      text: 'двоим',
      kind: 'note',
    });
    expect(two.error?.code).toBe('bad_request');
    const none = await call(client, 'rooms.send', {
      projectPath: dir,
      workId,
      roomId: null,
      to: [],
      text: 'никому',
      kind: 'note',
    });
    expect(none.error?.code).toBe('bad_request');
  });

  it('5: rooms.send в комнату, где адресат не участник, — bad_request, письма нет', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b, outsider] = ids as [string, string, string];
    await call(client, 'rooms.create', { projectPath: dir, workId, title: 'Двое', members: [a, b] });
    const before = (await readMap(dir, workId)).messages.length;

    const response = await call(client, 'rooms.send', {
      projectPath: dir,
      workId,
      roomId: 'r-01',
      to: [outsider],
      text: 'тебе',
      kind: 'question',
    });
    expect(response.error?.code).toBe('bad_request');
    expect((await readMap(dir, workId)).messages).toHaveLength(before);

    const missingRoom = await call(client, 'rooms.send', {
      projectPath: dir,
      workId,
      roomId: 'r-09',
      to: [],
      text: 'в пустоту',
      kind: 'note',
    });
    expect(missingRoom.error?.code).toBe('bad_request');

    const missingWork = await call(client, 'rooms.send', {
      projectPath: dir,
      workId: 'w-9999',
      roomId: null,
      to: [a],
      text: 'в пустоту',
      kind: 'note',
    });
    expect(missingWork.error?.code).toBe('bad_request');
  });

  it('rooms.create с закрытой сессией — bad_request, комнаты нет', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];
    await updateMap(dir, workId, (map) => transitionSession(map, b, 'closed'));

    const response = await call(client, 'rooms.create', {
      projectPath: dir,
      workId,
      title: 'С закрытой',
      members: [a, b],
    });
    expect(response.error?.code).toBe('bad_request');
    expect((await readMap(dir, workId)).rooms).toEqual([]);
  });
});
