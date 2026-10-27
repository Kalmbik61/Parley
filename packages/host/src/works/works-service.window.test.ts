import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, letterCount, readStoredMap, setWorkStatus, updateMap, writeLetters } from '@parley/core';
import { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, MAX_LINE_BYTES, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { EventData, EventName, RoomsMailEvent, WorksSnapshot } from '@parley/protocol';
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
  await updateMap(project, map.work.id, (current, letters) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'x' });
    addSession(current, { provider: 'claude', label: 'код', task: 'y', parent: null }).parent = 's-01';
    addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
    for (let i = 0; i < count; i += 1) letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(size, 'я') });
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
    // Сервисам хоста отдаётся хранимая карта без писем: они в своих таблицах (спека хранилища 6.2).
    expect(s.snapshot().entries[0]?.map).not.toHaveProperty('messages');
    expect(s.entry(project, workId)?.map).not.toHaveProperty('messages');
    expect(letterCount(project, workId, {})).toBe(400);

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
    await updateMap(project, 'w-0001', (current, letters) => {
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'ещё' });
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
    expect(bytes(readStoredMap(project, 'w-0001'))).toBeGreaterThan(MAX_LINE_BYTES);
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
    await updateMap(project, map.work.id, (current, letters) => {
      addSession(current, { provider: 'claude', label: 'план', task: 'x' });
      addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01'], lead: 's-01' });
      for (let i = 0; i < 2100; i += 1) letters.add({ from: 's-01', to: [], roomId: 'r-01', kind: 'decision', text: `${i}:`.padEnd(4000, 'я') });
    });
    const s = service();
    await s.start();
    expect(bytes(readStoredMap(project, map.work.id))).toBeGreaterThan(MAX_LINE_BYTES);
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
    const whole = ['w-0001', 'w-0002', 'w-0003', 'w-0004', 'w-0005'].reduce((sum, id) => sum + bytes(readStoredMap(project, id)), 0);
    expect(whole).toBeGreaterThan(MAX_LINE_BYTES);
  });

  it('полный снимок чуть ниже предела старому окну отдаётся как есть', async () => {
    await seedWork('А', 50, 200);
    const s = service();
    await s.start();
    expect(bytes(readStoredMap(project, 'w-0001'))).toBeLessThan(LEGACY_SNAPSHOT_MAX_BYTES);
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

describe('снимок без писем для окон с rooms-mail (спека rooms.mail 6.8, 6.10)', () => {
  const lastChanged = (client: FakeClient): WorksSnapshot =>
    client.sent.filter((message) => message.event === 'works.changed').at(-1)?.data as WorksSnapshot;

  it('окно с rooms-mail получает снимок без писем, окно с compact-works — с хвостами, прежнее — полный', async () => {
    await seedWork('А', 400, 200);
    const mailClient = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const compactClient = fakeClient([COMPACT_WORKS_FEATURE]);
    const legacyClient = fakeClient([]);
    const s = service();
    await s.start();

    const forMail = lastChanged(mailClient);
    const forCompact = lastChanged(compactClient);
    const forLegacy = lastChanged(legacyClient);

    expect(forMail.entries[0]?.map.messages).toEqual([]);
    expect(forMail.entries[0]?.map.compact).toMatchObject({
      version: 2,
      rooms: { '': { total: 0, top: 0, lastAt: null }, 'r-01': { total: 400, top: 400, unread: 400 } },
      unread: { letters: 400, rooms: { 'r-01': 400 } },
    });
    expect(forMail.entries[0]?.map.compact).not.toHaveProperty('messages');
    expect(forMail.entries[0]?.version).toBeDefined();
    expect(forCompact.entries[0]?.map.messages.length).toBeGreaterThan(0);
    expect(forCompact.entries[0]?.map.compact).toMatchObject({ version: 1, messages: { total: 400, latestId: 'm-400' } });
    expect(forLegacy.entries[0]?.map.messages).toHaveLength(400);
    expect(forLegacy.entries[0]?.map.compact).toBeUndefined();
    // Версия снимка без писем — та же, что у снимка с хвостами, и по номеру рассылки они в одном ряду.
    expect(forMail.entries[0]?.version).toBe(forCompact.entries[0]?.version);
    expect(forMail.revision).toBe(forCompact.revision);
    // Каждому окну ушёл один вариант: окно с признаком не получило снимка с хвостами и наоборот.
    expect(mailClient.sent.filter((message) => message.event === 'works.changed')).toHaveLength(1);
    expect(compactClient.sent.filter((message) => message.event === 'works.changed')).toHaveLength(1);
    // Снимок без писем сервис отдаёт и сам (его берёт works.list).
    expect(s.mailSnapshot()).toEqual(forMail);
  });

  it('размер не зависит от числа писем: 10 000 писем — несколько килобайт против сотен у снимка с хвостами', async () => {
    await seedWork('А', 2500, 1500);
    await seedWork('Б', 2500, 1500);
    const s = service();
    await s.start();

    const mail = s.mailSnapshot() as WorksSnapshot;
    const compact = s.windowSnapshot() as WorksSnapshot;

    expect(mail.entries).toHaveLength(2);
    for (const entry of mail.entries) {
      expect(entry.map.messages).toEqual([]);
      expect(entry.map.compact).toMatchObject({ version: 2, rooms: { 'r-01': { total: 2500, top: 2500 } } });
    }
    expect(bytes(mail)).toBeLessThan(16 * 1024);
    expect(bytes(compact)).toBeGreaterThan(bytes(mail) * 20);
  });

  it('части снимка кэшируются по версии, и варианты не вытесняют друг друга: запись в одну работу пересобирает только её', async () => {
    const first = await seedWork('А', 5, 20);
    const second = await seedWork('Б', 5, 20);
    const s = service();
    await s.start();
    const entryOf = (snapshot: WorksSnapshot | null, id: string) => snapshot?.entries.find((entry) => entry.map.work.id === id);
    const compactBefore = s.windowSnapshot();
    const mailBefore = s.mailSnapshot();
    // Наблюдатель файлов (FSEvents) оживает не мгновенно: запись сразу после старта он мог бы не заметить.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await updateMap(project, second, (current) => {
      current.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(entryOf(s.mailSnapshot(), second)?.map.work.goal).toBe('новая цель'), { timeout: 10_000, interval: 10 });
    const compactAfter = s.windowSnapshot();
    const mailAfter = s.mailSnapshot();

    expect(entryOf(compactAfter, second)?.map.work.goal).toBe('новая цель');
    // Работа без записи отдаёт ту же часть, что и до неё, в обоих вариантах: ни один не сбросил кэш другого.
    expect(entryOf(compactAfter, first)).toBe(entryOf(compactBefore, first));
    expect(entryOf(mailAfter, first)).toBe(entryOf(mailBefore, first));
    expect(entryOf(mailAfter, second)).not.toBe(entryOf(mailBefore, second));
  }, 20_000);

  it('кандидаты в упоминания и итог решения: непрочитанные @human письма, ответ человека на решение, прямые письма', async () => {
    const workId = await seedWork('А', 0, 0);
    await updateMap(project, workId, (_current, letters) => {
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human посмотри' }); // m-01
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'без упоминания' }); // m-02
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'mail@humanity.org не человек' }); // m-03
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human уже прочитано', readBy: { human: '2026-10-27T10:00:00.000Z' } }); // m-04
      letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: 'прямое человеку' }); // m-05
      letters.add({ kind: 'note', from: 'human', to: ['s-01'], roomId: 'r-01', text: 'Returned for rework: add tests' }); // m-06
      letters.add({ kind: 'note', from: 'human', to: ['s-01'], roomId: 'r-01', text: 'и ещё одно слово' }); // m-07
    });
    const s = service();
    await s.start();

    const compact = (s.mailSnapshot() as WorksSnapshot).entries[0]?.map.compact;

    expect(compact).toMatchObject({
      version: 2,
      rooms: {
        '': { total: 1, top: 5, unread: 1, decision: null },
        'r-01': { total: 6, top: 7, unread: 3, decision: 'returned' },
      },
      unread: { letters: 4, rooms: { '': 1, 'r-01': 3 } },
    });
    expect((compact as { mentionCandidates: Array<{ id: string }> }).mentionCandidates.map((message) => message.id)).toEqual(['m-01']);
  });

  it('снимок и событие rooms.mail называют одно письмо: новый кандидат события лежит и в наборе снимка, который его заменяет', async () => {
    const workId = await seedWork('А', 3, 20);
    const mailClient = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = service();
    await s.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    writeLetters(project, workId, (letters) => {
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human нужен ответ' });
    });
    await vi.waitFor(() => expect(mailClient.sent.some((message) => message.event === 'rooms.mail')).toBe(true), { timeout: 10_000, interval: 10 });
    const event = mailClient.sent.find((message) => message.event === 'rooms.mail')?.data as RoomsMailEvent;
    const snapshot = s.mailSnapshot()?.entries[0]?.map.compact;

    expect(event.mentionCandidates.map((message) => message.id)).toEqual(['m-04']);
    expect((snapshot as { mentionCandidates: Array<{ id: string }> }).mentionCandidates.map((message) => message.id)).toEqual(['m-04']);
    expect(snapshot).toMatchObject({ rooms: { 'r-01': { total: 4, top: 4 } }, unread: { letters: 4 } });
    expect(event.rooms[0]).toMatchObject({ total: 4, top: 4 });
    // Письмо не вызвало `works.changed` окну с признаком: снимок без писем уходит только на структурную запись.
    expect(mailClient.sent.filter((message) => message.event === 'works.changed')).toHaveLength(1);
  }, 20_000);

  it('снимок без писем выше потолка — запасной вариант с короткими текстами, письма он не несёт и так', async () => {
    const map = await createWork(project, { title: 'Большая', goal: '' });
    await updateMap(project, map.work.id, (current) => {
      for (let i = 0; i < 300; i += 1) addSession(current, { provider: 'claude', label: `с${i}`, task: 'ж'.repeat(10_000) });
    });
    const s = service();
    await s.start();

    const fallback = s.mailSnapshot() as WorksSnapshot;

    expect(bytes(fallback)).toBeLessThan(5 * 1024 * 1024);
    expect(fallback.entries[0]?.map.sessions[0]?.task).toContain('cut: ');
    expect(fallback.entries[0]?.map.compact?.cut.length).toBeGreaterThan(0);
    expect(fallback.entries[0]?.map.compact?.version).toBe(2);
  });
});
