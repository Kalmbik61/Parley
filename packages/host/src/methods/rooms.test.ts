import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addRoom,
  addSession,
  createWork,
  HUMAN,
  readMap,
  roomLead,
  setProposal,
  SYSTEM,
  transitionSession,
  unreadFor,
  updateMap,
} from '@harnas/core';
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

/** Ещё одна живая сессия TUI в той же работе: `setup()` заводит только три. */
async function addLiveSession(dir: string, workId: string, label: string): Promise<string> {
  let id = '';
  await updateMap(dir, workId, (map) => {
    const session = addSession(map, { provider: 'claude', label, task: 't' });
    session.launchedBy = 'tui';
    transitionSession(map, session.id, 'active');
    id = session.id;
  });
  return id;
}

describe('rooms.create: ведущий и правило одной комнаты (дизайн комнат, 3.2, решение 4)', () => {
  it('ведущий по умолчанию — первый участник; повторы и человек в счёт не идут', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];

    await call(client, 'rooms.create', { projectPath: dir, workId, title: 'Двое', members: [HUMAN, b, a, b] });

    const room = (await readMap(dir, workId)).rooms[0];
    expect(room).toMatchObject({ members: [b, a], lead: b, proposal: null });
  });

  it('явный ведущий записывается', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];

    const response = await call(client, 'rooms.create', {
      projectPath: dir,
      workId,
      title: 'Двое',
      members: [a, b],
      lead: b,
    });

    expect(response.result).toEqual({ roomId: 'r-01' });
    expect((await readMap(dir, workId)).rooms[0]?.lead).toBe(b);
  });

  it('ведущий не из участников или человек — bad_request, комнаты нет', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b, outsider] = ids as [string, string, string];

    for (const lead of [outsider, HUMAN, 's-99']) {
      const response = await call(client, 'rooms.create', {
        projectPath: dir,
        workId,
        title: 'Двое',
        members: [a, b],
        lead,
      });
      expect(response.error?.code).toBe('bad_request');
    }
    expect((await readMap(dir, workId)).rooms).toEqual([]);
  });

  it('участники нового круга уходят из прочих комнат работы; ушедший ведущий оставляет lead: null', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b, c] = ids as [string, string, string];
    await call(client, 'rooms.create', { projectPath: dir, workId, title: 'Первая', members: [a, b], lead: b });

    await call(client, 'rooms.create', { projectPath: dir, workId, title: 'Вторая', members: [b, c] });

    const map = await readMap(dir, workId);
    expect(map.rooms[0]).toMatchObject({ id: 'r-01', members: [a], lead: null });
    expect(roomLead(map.rooms[0] as NonNullable<(typeof map.rooms)[0]>)).toBe(a);
    expect(map.rooms[1]).toMatchObject({ id: 'r-02', members: [b, c], lead: b });
  });

  it('приглашения участникам уходят, как прежде, и правило комнат их не отменяет', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b] = ids as [string, string];
    await call(client, 'rooms.create', { projectPath: dir, workId, title: 'Двое', members: [a, b] });

    const map = await readMap(dir, workId);
    expect(unreadFor(map, a)).toHaveLength(1);
    expect(unreadFor(map, b)).toHaveLength(1);
  });
});

describe('rooms.addMember', () => {
  async function withRooms(): Promise<{
    client: TestClient;
    dir: string;
    workId: string;
    ids: string[];
    fourth: string;
  }> {
    const context = await setup();
    const [a, b, c] = context.ids as [string, string, string];
    await call(context.client, 'rooms.create', {
      projectPath: context.dir,
      workId: context.workId,
      title: 'Возвраты',
      members: [a, b],
      lead: a,
    });
    await call(context.client, 'rooms.create', {
      projectPath: context.dir,
      workId: context.workId,
      title: 'Ревью',
      members: [c],
    });
    const fourth = await addLiveSession(context.dir, context.workId, 'четыре');
    return { ...context, fourth };
  }

  it('сессия входит в комнату; ответ — id системной строки «@s04 joined the room»', async () => {
    const { client, dir, workId, fourth } = await withRooms();

    const response = await call(client, 'rooms.addMember', { projectPath: dir, workId, roomId: 'r-01', sessionId: fourth });

    const map = await readMap(dir, workId);
    expect(map.rooms[0]?.members).toContain(fourth);
    const line = map.messages.find((message) => message.from === SYSTEM);
    expect(response.result).toEqual({ messageId: line?.id });
    expect(line).toMatchObject({ roomId: 'r-01', kind: 'note', text: '@s04 joined the room' });
  });

  it('уводит сессию из прочих комнат работы: она остаётся в одной', async () => {
    const { client, dir, workId, ids } = await withRooms();
    const [, b] = ids as [string, string];

    await call(client, 'rooms.addMember', { projectPath: dir, workId, roomId: 'r-02', sessionId: b });

    const map = await readMap(dir, workId);
    expect(map.rooms[0]?.members).not.toContain(b);
    expect(map.rooms[1]?.members).toContain(b);
    const homes = map.rooms.filter((room) => room.members.includes(b));
    expect(homes.map((room) => room.id)).toEqual(['r-02']);
  });

  it('системная строка никого не будит: непрочитанных у сессий не прибавилось', async () => {
    const { client, dir, workId, ids, fourth } = await withRooms();
    const before = (await readMap(dir, workId)).messages.length;

    await call(client, 'rooms.addMember', { projectPath: dir, workId, roomId: 'r-01', sessionId: fourth });

    const map = await readMap(dir, workId);
    expect(map.messages).toHaveLength(before + 1);
    for (const id of [...ids, fourth]) {
      expect(unreadFor(map, id).every((message) => message.from !== SYSTEM)).toBe(true);
    }
  });

  it('уже участник, закрытая сессия, нет комнаты, сессии или работы — bad_request, карта не тронута', async () => {
    const { client, dir, workId, ids, fourth } = await withRooms();
    const [a] = ids as [string];
    const closed = await addLiveSession(dir, workId, 'закрытая');
    await updateMap(dir, workId, (map) => transitionSession(map, closed, 'closed'));
    const before = JSON.stringify(await readMap(dir, workId));

    const cases: Array<Record<string, string>> = [
      { roomId: 'r-01', sessionId: a },
      { roomId: 'r-01', sessionId: closed },
      { roomId: 'r-01', sessionId: 's-99' },
      { roomId: 'r-09', sessionId: fourth },
      { roomId: 'r-01', sessionId: fourth, workId: 'w-9999' },
    ];
    for (const extra of cases) {
      const response = await call(client, 'rooms.addMember', { projectPath: dir, workId, ...extra });
      expect(response.error?.code).toBe('bad_request');
    }
    expect(JSON.stringify(await readMap(dir, workId))).toBe(before);
  });

  it('старая карта: сессия в двух комнатах читается, уходит из обеих; чужие комнаты не переписываются', async () => {
    const { client, dir, workId, ids } = await setup();
    const [a, b, c] = ids as [string, string, string];
    // Комнаты «до ведущего»: без lead и proposal, обе с одними и теми же участниками.
    await updateMap(dir, workId, (map) => {
      for (const title of ['Старая', 'Ещё старая']) {
        const room = addRoom(map, { title, creator: HUMAN, members: [a, b] });
        delete (room as unknown as Record<string, unknown>)['lead'];
        delete (room as unknown as Record<string, unknown>)['proposal'];
      }
      addRoom(map, { title: 'Новая', creator: HUMAN, members: [c] });
    });
    const raw = JSON.parse(await readFile(path.join(dir, '.harnas', 'works', workId, 'map.json'), 'utf8')) as {
      rooms: Array<Record<string, unknown>>;
    };
    expect(raw.rooms.slice(0, 2).every((room) => !('lead' in room) || room['lead'] === null)).toBe(true);

    const response = await call(client, 'rooms.addMember', { projectPath: dir, workId, roomId: 'r-03', sessionId: a });
    expect(response.error).toBeUndefined();

    const map = await readMap(dir, workId);
    // `a` ушёл из обеих старых комнат; `b` там, где был, — чужих участников правило не трогает.
    expect(map.rooms[0]?.members).toEqual([b]);
    expect(map.rooms[1]?.members).toEqual([b]);
    expect(map.rooms[2]?.members).toEqual([c, a]);
  });
});

describe('rooms.resolveProposal', () => {
  /** Комната r-01 {a, b, c} с ведущим a и решением p-01 в слоте. */
  async function withProposal(): Promise<{
    client: TestClient;
    dir: string;
    workId: string;
    ids: string[];
    base: { projectPath: string; workId: string; roomId: string; proposalId: string };
  }> {
    const context = await setup();
    const [a, b, c] = context.ids as [string, string, string];
    await call(context.client, 'rooms.create', {
      projectPath: context.dir,
      workId: context.workId,
      title: 'Возвраты',
      members: [a, b, c],
      lead: a,
    });
    await updateMap(context.dir, context.workId, (map) => {
      setProposal(map, 'r-01', a, 'Итог: контракт, потом код. @s02 — код.');
    });
    return {
      ...context,
      base: { projectPath: context.dir, workId: context.workId, roomId: 'r-01', proposalId: 'p-01' },
    };
  }

  it('accept: decision от ведущего, системная строка и письмо ведущему; слот пуст', async () => {
    const { client, dir, workId, ids, base } = await withProposal();
    const [a] = ids as [string];
    const before = (await readMap(dir, workId)).messages.length;

    const response = await call(client, 'rooms.resolveProposal', { ...base, action: 'accept' });

    const map = await readMap(dir, workId);
    const fresh = map.messages.slice(before);
    expect(fresh.map((message) => [message.from, message.kind, message.text])).toEqual([
      [a, 'decision', 'Итог: контракт, потом код. @s02 — код.'],
      [SYSTEM, 'note', 'You accepted the decision'],
      [HUMAN, 'note', 'Decision accepted.'],
    ]);
    expect(response.result).toEqual({ messageId: fresh[0]?.id });
    expect(fresh[2]?.to).toEqual([a]);
    expect(map.rooms[0]?.proposal).toBeNull();
  });

  it('return с заметкой: письмо человека ведущему, без заметки — «Returned for rework.»', async () => {
    const { client, dir, workId, ids, base } = await withProposal();
    const [a] = ids as [string];

    const first = await call(client, 'rooms.resolveProposal', { ...base, action: 'return', note: 'Контракт первым.' });
    let map = await readMap(dir, workId);
    expect(map.messages.at(-1)).toMatchObject({
      id: (first.result as { messageId: string }).messageId,
      from: HUMAN,
      to: [a],
      text: 'Returned for rework: Контракт первым.',
    });
    expect(map.rooms[0]?.proposal).toBeNull();

    await updateMap(dir, workId, (current) => {
      setProposal(current, 'r-01', a, 'переделал');
    });
    await call(client, 'rooms.resolveProposal', { ...base, proposalId: 'p-02', action: 'return' });
    map = await readMap(dir, workId);
    expect(map.messages.at(-1)?.text).toBe('Returned for rework.');
  });

  it('устаревший proposalId — conflict, карта не тронута', async () => {
    const { client, dir, workId, base } = await withProposal();
    const before = JSON.stringify(await readMap(dir, workId));

    const response = await call(client, 'rooms.resolveProposal', { ...base, proposalId: 'p-99', action: 'accept' });

    expect(response.error?.code).toBe('conflict');
    expect(JSON.stringify(await readMap(dir, workId))).toBe(before);
  });

  it('повтор Accept — conflict и ни одного дубля сообщений', async () => {
    const { client, dir, workId, base } = await withProposal();
    await call(client, 'rooms.resolveProposal', { ...base, action: 'accept' });
    const after = (await readMap(dir, workId)).messages.length;

    const again = await call(client, 'rooms.resolveProposal', { ...base, action: 'accept' });
    const afterReturn = await call(client, 'rooms.resolveProposal', { ...base, action: 'return', note: 'поздно' });

    expect(again.error?.code).toBe('conflict');
    expect(afterReturn.error?.code).toBe('conflict');
    expect((await readMap(dir, workId)).messages).toHaveLength(after);
  });

  it('два Accept подряд без ожидания ответа: проходит ровно один', async () => {
    const { client, dir, workId, base } = await withProposal();
    const before = (await readMap(dir, workId)).messages.length;

    const [one, two] = await Promise.all([
      call(client, 'rooms.resolveProposal', { ...base, action: 'accept' }),
      call(client, 'rooms.resolveProposal', { ...base, action: 'accept' }),
    ]);

    // `sort()` уносит undefined в конец при любом порядке ответов — считаем исходы, а не порядок.
    const codes = [one.error?.code, two.error?.code];
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(codes.filter((code) => code === 'conflict')).toHaveLength(1);
    const map = await readMap(dir, workId);
    // decision, системная строка и письмо ведущему — по одному разу.
    expect(map.messages).toHaveLength(before + 3);
    expect(map.messages.filter((message) => message.kind === 'decision')).toHaveLength(1);
  });

  it('нет решения в слоте — conflict, а нет комнаты, работы или заметка длиннее 4000 — bad_request', async () => {
    const { client, dir, workId, base } = await withProposal();
    await call(client, 'rooms.resolveProposal', { ...base, action: 'accept' });

    const empty = await call(client, 'rooms.resolveProposal', { ...base, action: 'accept' });
    expect(empty.error?.code).toBe('conflict');

    const noRoom = await call(client, 'rooms.resolveProposal', { ...base, roomId: 'r-09', action: 'accept' });
    const noWork = await call(client, 'rooms.resolveProposal', { ...base, workId: 'w-9999', action: 'accept' });
    const tooLong = await call(client, 'rooms.resolveProposal', {
      ...base,
      action: 'return',
      note: 'я'.repeat(4001),
    });
    expect([noRoom, noWork, tooLong].map((response) => response.error?.code)).toEqual([
      'bad_request',
      'bad_request',
      'bad_request',
    ]);
    expect((await readMap(dir, workId)).rooms[0]?.proposal).toBeNull();
  });
});
