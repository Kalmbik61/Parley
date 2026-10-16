import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addRoom, addSession, appendMessage, createWork, migrateMapToJournal, readMap, updateMap, workPaths, writeCursor } from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { EventData, EventName } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { createWindowCounters } from '../health/window-counters.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

/**
 * Письма карты-журнала (задача 8 плана): хост читает журналы хвостом. Письмо — `rooms.mail` без `works.changed` и без
 * `refresh`; индекс — прежний `works.changed`; чужие карты не разбираются заново.
 */
vi.setConfig({ testTimeout: 30_000 });

let home = '';
let project = '';
let services: WorksService[] = [];
let clients: Client[] = [];
let broadcasts: Array<{ event: EventName; data: unknown; to: string[] }> = [];
const counters = createWindowCounters();

function fakeClient(features: string[]): Client {
  const client: Client = {
    id: randomUUID(),
    name: 'test',
    features: new Set(features),
    send: () => true,
    writableLength: () => 0,
    close() {},
  };
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
    broadcast: (event, data, only) => {
      const to = clients.filter((client) => only === undefined || only(client));
      broadcasts.push({ event, data: data as EventData<EventName>, to: to.map((client) => client.id) });
    },
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

async function started(): Promise<WorksService> {
  const created = createWorksService(fakeHost(), { debounceMs: 5, windowCounters: counters });
  services.push(created);
  await created.start();
  // Рекурсивный fs.watch включается не мгновенно, и сервис дочитывает список после старта (`WATCH_SETTLE_MS`, последняя пауза 3 с):
  // счётчики и рассылки считаются после этого.
  await new Promise((resolve) => setTimeout(resolve, 3600));
  broadcasts = [];
  counters.reset();
  return created;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  clients = [];
  broadcasts = [];
  counters.reset();
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа на карте-журнале: сессии s-01 и s-02, комната r-01, одно письмо в ней. */
async function seedJournal(title: string): Promise<string> {
  const { work } = await createWork(project, { title });
  await updateMap(project, work.id, (map) => {
    addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addSession(map, { provider: 'claude', label: 'b', task: 't' });
    addRoom(map, { title: 'Комната', creator: 's-01', members: ['s-01', 's-02'] });
    addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'старое' });
  });
  const result = await migrateMapToJournal(project, work.id, { run: new Date().toISOString() });
  expect(result.status).toBe('migrated');
  return work.id;
}

/** Рассылки, которые кому-то дошли: вызов `broadcast` с пустым списком получателей — не событие. */
const events = (name: EventName): typeof broadcasts => broadcasts.filter((item) => item.event === name && item.to.length > 0);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('письма карты-журнала в хосте', () => {
  it('строка в журнале даёт rooms.mail и ни одного works.changed; refresh и разбор карт не растут, байты хвоста считаются отдельно', async () => {
    const id = await seedJournal('A');
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();

    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'новое письмо' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(400);

    expect(events('rooms.mail')[0]).toMatchObject({
      data: { projectPath: project, workId: id, roomId: 'r-01', appended: [{ id: 'm-r01-2', from: 's-02', to: [], kind: 'note' }] },
      to: [modern.id],
    });
    expect(JSON.stringify(events('rooms.mail')[0]!.data)).not.toContain('новое письмо');
    expect(events('works.changed')).toEqual([]);
    const tally = counters.read();
    expect(tally.refreshCount).toBe(0);
    expect(tally.mapBytesParsed).toBe(0);
    expect(tally.journalBytesRead).toBeGreaterThan(0);
    // Снимок хоста — прежней формы и ровно то, что собрала бы полная сборка.
    expect(s.entry(project, id)?.map.messages).toEqual((await readMap(project, id)).messages);
    expect(s.snapshot().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-r01-2']);
  });

  it('окно без rooms-mail получает письмо прежним works.changed, окно с признаком — только rooms.mail', async () => {
    const id = await seedJournal('A');
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const old = fakeClient([COMPACT_WORKS_FEATURE]);
    await started();

    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'письмо' });
    await vi.waitFor(() => expect(events('works.changed')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    expect(events('works.changed')).toHaveLength(1);
    expect(events('works.changed')[0]!.to).toEqual([old.id]);
    expect(events('rooms.mail')).toHaveLength(1);
    expect(events('rooms.mail')[0]!.to).toEqual([modern.id]);
    expect(counters.read().refreshCount).toBe(0);
  });

  it('onMail отдаёт подписчику сервиса то же событие', async () => {
    const id = await seedJournal('A');
    const s = await started();
    const got: unknown[] = [];
    const off = s.onMail((mail) => got.push(mail));
    await appendMessage(project, id, null, { from: 's-01', to: ['s-02'], text: 'прямое' });
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000 });
    expect(got[0]).toMatchObject({ workId: id, roomId: null, appended: [{ id: 'm-d-1', to: ['s-02'] }] });
    off();
  });

  it('изменение индекса — ровно один works.changed; разбирается только эта работа, чужие карты не перечитываются', async () => {
    const a = await seedJournal('A');
    const b = await seedJournal('B'.repeat(150));
    const { work: c } = await createWork(project, { title: 'C на v2' });
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();

    await updateMap(project, a, (map) => {
      map.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(events('works.changed')).toHaveLength(1), { timeout: 5000 });
    await sleep(500);

    expect(events('works.changed')).toHaveLength(1);
    expect(events('rooms.mail')).toEqual([]);
    const size = async (workId: string): Promise<number> => Buffer.byteLength(await readFile(workPaths(project, workId).map, 'utf8'));
    // Карту A читают оба наблюдателя (дом и проект), по разу каждый; карты B и C — ни разу.
    const parsed = counters.read().mapBytesParsed;
    expect([await size(a), 2 * (await size(a))]).toContain(parsed);
    expect(s.entry(project, a)?.map.work.goal).toBe('новая цель');
    expect(s.entry(project, b)?.map.messages).toHaveLength(1);
    expect(s.entry(project, c.id)?.map.work.title).toBe('C на v2');
  });

  it('оборванная строка журнала не даёт события; дописанная до конца приходит ровно один раз', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const file = path.join(workPaths(project, id).rooms, 'r-01', 'messages.jsonl');
    const whole = `${JSON.stringify({ seq: 2, id: 'm-r01-2', roomId: 'r-01', from: 's-02', to: [], text: 'целиком', kind: 'note', at: new Date().toISOString() })}\n`;

    await appendFile(file, whole.slice(0, 40));
    await sleep(600);
    expect(events('rooms.mail')).toEqual([]);
    expect(s.entry(project, id)?.map.messages).toHaveLength(1);

    await appendFile(file, whole.slice(40));
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);
    expect(events('rooms.mail')).toHaveLength(1);
    expect(s.entry(project, id)?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-r01-2']);
  });

  it('журнал, заменённый под хвостом, собирает карту заново и объявляет об этом works.changed; дальше хвост идёт по новому файлу', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'второе' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    broadcasts = [];

    const file = path.join(workPaths(project, id).rooms, 'r-01', 'messages.jsonl');
    const fresh = `${JSON.stringify({ seq: 1, id: 'm-1', roomId: 'r-01', from: 's-01', to: [], text: 'заменённое', kind: 'note', at: new Date().toISOString() })}\n`;
    await writeFile(`${file}.new`, fresh);
    await rename(`${file}.new`, file);
    await vi.waitFor(() => expect(events('works.changed').length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(s.entry(project, id)?.map.messages.map((message) => message.text)).toEqual(['заменённое']);

    broadcasts = [];
    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'после замены' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    expect(s.entry(project, id)?.map.messages.map((message) => message.text)).toEqual(['заменённое', 'после замены']);
  });

  it('курсор сессии молча обновляет readBy в снимке: событий нет, снимок равен полной сборке', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    expect(s.entry(project, id)?.map.messages[0]?.readBy['s-02']).toBeUndefined();

    await writeCursor(project, id, 's-02', 'r-01', 'm-01');
    await vi.waitFor(() => expect(s.entry(project, id)?.map.messages[0]?.readBy['s-02']).toBeDefined(), { timeout: 5000 });
    await sleep(300);
    expect(broadcasts).toEqual([]);
    expect(counters.read().refreshCount).toBe(0);
    expect(s.entry(project, id)?.map.messages).toEqual((await readMap(project, id)).messages);
  });

  it('работа на v2: письмо в карту — прежний works.changed с письмом, rooms.mail нет', async () => {
    const { work } = await createWork(project, { title: 'v2' });
    await updateMap(project, work.id, (map) => {
      addSession(map, { provider: 'claude', label: 'a', task: 't' });
    });
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();

    await updateMap(project, work.id, (map) => {
      addMessage(map, { roomId: null, from: 'human', to: ['s-01'], text: 'письмо в карту' });
    });
    await vi.waitFor(() => expect(events('works.changed')).toHaveLength(1), { timeout: 5000 });
    expect(events('rooms.mail')).toEqual([]);
    expect(s.entry(project, work.id)?.map.messages.map((message) => message.text)).toEqual(['письмо в карту']);
    expect(counters.read().refreshCount).toBe(1);
  });

  it('после письма снимок для окна (works.list) уже содержит его, и номер снимка вырос: окно, открытое позже события, не отстаёт', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const before = s.windowSnapshot();
    expect(before?.entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-01']);

    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'новое' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });

    const after = s.windowSnapshot();
    expect(after?.entries[0]?.map.messages.map((message) => message.id).sort()).toEqual(['m-01', 'm-r01-2']);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(s.legacySnapshot()?.entries[0]?.map.messages.map((message) => message.id).sort()).toEqual(['m-01', 'm-r01-2']);
  });

  it('прочитанное (курсор) тоже сбрасывает снимок для окна: readBy в нём свежий', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const before = s.windowSnapshot();
    await writeCursor(project, id, 's-02', 'r-01', 'm-01');
    await vi.waitFor(() => expect(s.entry(project, id)?.map.messages[0]?.readBy['s-02']).toBeDefined(), { timeout: 5000 });
    const after = s.windowSnapshot();
    expect(after?.entries[0]?.map.messages[0]?.readBy['s-02']).toBeDefined();
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
  });

  it('пересборка из-за заменённого журнала отдаёт письма, которых сервис ещё не видел: onMail и rooms.mail', async () => {
    const id = await seedJournal('A');
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    // Хвост журнала заведён первым письмом: замена файла тогда — настоящий сброс хвоста, а не первое чтение.
    await appendMessage(project, id, 'r-01', { from: 's-02', to: [], text: 'второе' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    broadcasts = [];
    const got: Array<{ roomId: string | null; ids: string[] }> = [];
    s.onMail((mail) => got.push({ roomId: mail.roomId, ids: mail.appended.map((letter) => letter.id) }));

    const file = path.join(workPaths(project, id).rooms, 'r-01', 'messages.jsonl');
    const extra = `${JSON.stringify({ seq: 3, id: 'm-r01-3', roomId: 'r-01', from: 's-02', to: ['s-01'], text: 'принесла замена', kind: 'note', at: new Date().toISOString() })}\n`;
    await writeFile(`${file}.new`, (await readFile(file, 'utf8')) + extra);
    await rename(`${file}.new`, file);

    await vi.waitFor(() => expect(got).toEqual([{ roomId: 'r-01', ids: ['m-r01-3'] }]), { timeout: 5000 });
    expect(events('rooms.mail').map((item) => item.to)).toEqual([[modern.id]]);
    // Письмо уже в карте хоста, и повторно (дельтой) оно не приходит.
    expect(s.entry(project, id)?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-r01-2', 'm-r01-3']);
    await sleep(500);
    expect(got).toHaveLength(1);
  });

  it('письмо в журнале комнаты, которой индекс ещё не знает, не теряется: приходит как rooms.mail, когда комната появилась в индексе', async () => {
    const id = await seedJournal('A');
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const got: string[] = [];
    s.onMail((mail) => got.push(...mail.appended.map((letter) => letter.id)));

    // Письмо раньше индекса: журнал комнаты r-02 уже лежит, а в индексе её нет.
    const dir = path.join(workPaths(project, id).rooms, 'r-02');
    await mkdir(dir, { recursive: true });
    const letter = `${JSON.stringify({ seq: 1, id: 'm-r02-1', roomId: 'r-02', from: 's-02', to: [], text: 'раньше индекса', kind: 'note', at: new Date().toISOString() })}\n`;
    await writeFile(path.join(dir, 'messages.jsonl'), letter);
    await sleep(700);
    expect(events('rooms.mail')).toEqual([]);

    await updateMap(project, id, (map) => {
      addRoom(map, { title: 'Вторая', creator: 's-01', members: ['s-01', 's-02'] });
    });
    await vi.waitFor(() => expect(got).toContain('m-r02-1'), { timeout: 5000 });
    expect(events('rooms.mail').map((item) => item.to)).toEqual([[modern.id]]);
    expect(events('rooms.mail')[0]?.data).toMatchObject({ roomId: 'r-02', appended: [{ id: 'm-r02-1' }] });
    expect(s.entry(project, id)?.map.messages.map((message) => message.id)).toContain('m-r02-1');
    expect(got.filter((letterId) => letterId === 'm-r02-1')).toHaveLength(1);
  });

  it('комната уже в индексе, письмо пришло после — обычный rooms.mail (обратный порядок событий)', async () => {
    const id = await seedJournal('A');
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    await updateMap(project, id, (map) => {
      addRoom(map, { title: 'Вторая', creator: 's-01', members: ['s-01', 's-02'] });
    });
    await vi.waitFor(() => expect(s.entry(project, id)?.map.rooms.map((room) => room.id)).toContain('r-02'), { timeout: 5000 });
    broadcasts = [];

    await appendMessage(project, id, 'r-02', { from: 's-02', to: [], text: 'после индекса' });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    expect(events('rooms.mail')[0]?.data).toMatchObject({ roomId: 'r-02', appended: [{ id: 'm-r02-1' }] });
    expect(s.windowSnapshot()?.entries[0]?.map.messages.map((message) => message.id)).toContain('m-r02-1');
  });
});
