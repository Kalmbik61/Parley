import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRoom,
  addSession,
  createWork,
  deleteRoom,
  deleteWorkFiles,
  HUMAN,
  letterCount,
  readMap,
  roomLetterTops,
  unreadCount,
  unreadLetters,
  updateMap,
  WINDOW_MENTION_MAX_BYTES,
  WINDOW_TEXT_MAX,
  workVersion,
  writeLetters,
} from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE, encodeLine } from '@parley/protocol';
import type { EventData, EventName, RoomsMailEvent, WorksSnapshot } from '@parley/protocol';
import { createClient } from '../client.js';
import type { Client } from '../client.js';
import { createHostContext } from '../context.js';
import type { HostContext } from '../context.js';
import { createWindowCounters } from '../health/window-counters.js';
import { createWorksService } from './works-service.js';
import type { WorksService, WorksServiceOptions } from './works-service.js';
import { MAIL_HOLD_MAX_MS, buildMailEvent, joinBatch, startBatch } from './mail.js';
import type { MailNotice } from './mail.js';

// Шпион кодировщика кадров: в хосте им кодируется каждый кадр клиенту, и событие писем должно кодироваться один раз.
vi.mock('@parley/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/protocol')>();
  return { ...actual, encodeLine: vi.fn(actual.encodeLine) };
});

// Шлюзы полного прохода: пока `gate` закрыт, `refreshPass` стоит на `gitBranch` и до `publish` не доходит; `stripVersions`
// отдаёт проходу записи без точной версии, как при записи, вклинившейся между двумя чтениями версии работы.
const pass = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, stripVersions: false }));
vi.mock('@parley/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/core')>();
  return {
    ...actual,
    gitBranch: vi.fn(async (...args: Parameters<typeof actual.gitBranch>) => {
      await pass.gate;
      return actual.gitBranch(...args);
    }),
    watchWorks: (onWorks: Parameters<typeof actual.watchWorks>[0], options?: Parameters<typeof actual.watchWorks>[1]) =>
      actual.watchWorks(
        (works, seq) =>
          onWorks(
            pass.stripVersions
              ? works.map((work) => {
                  const bare = { ...work };
                  delete bare.version;
                  return bare;
                })
              : works,
            seq,
          ),
        options,
      ),
  };
});

/**
 * Письма в окно событием `rooms.mail` (спека rooms.mail 6.3-6.7, план, задача 4): запись только писем не доходит до полного
 * прохода `refreshPass`, не зовёт `onChange` и уходит окну с признаком одним событием на пачку; окно без признака получает
 * `works.changed` по одной работе; смешанная запись идёт прежним путём, а её письма — событием после снимка.
 */
vi.setConfig({ testTimeout: 30_000 });

let home = '';
let project = '';
let services: WorksService[] = [];
let clients: FakeClient[] = [];
let broadcasts: Array<{ event: EventName; data: unknown; to: string[]; line: string | undefined }> = [];
let warnings: string[] = [];
/** Вызывается из `broadcast` после раздачи: тест может записать письмо в середине публикации снимка. */
let onBroadcast: ((event: EventName) => void) | undefined;
const counters = createWindowCounters();

interface FakeClient extends Client {
  sent: Array<{ event?: string; data?: unknown }>;
  /** Сколько байт «в буфере» сокета: выше порога окно считается медленным. */
  buffered: number;
}

function fakeClient(features: string[]): FakeClient {
  const sent: FakeClient['sent'] = [];
  const client: FakeClient = {
    id: randomUUID(),
    name: 'test',
    features: new Set(features),
    sent,
    buffered: 0,
    send(message) {
      sent.push(message as { event?: string; data?: unknown });
      return true;
    },
    writableLength: () => client.buffered,
    close() {},
  };
  clients.push(client);
  return client;
}

/** Хост с настоящей раздачей по клиентам: `broadcast` уважает фильтр и пишет, кому ушло и какую готовую строку получил. */
function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    clients: () => clients,
    liveSessions: () => 0,
    broadcast: (event, data, only, encoded) => {
      const to = clients.filter((client) => only === undefined || only(client));
      broadcasts.push({ event, data: data as EventData<EventName>, to: to.map((client) => client.id), line: encoded });
      for (const client of to) client.send({ event, data });
      onBroadcast?.(event);
    },
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
    hold: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  clients = [];
  broadcasts = [];
  warnings = [];
  onBroadcast = undefined;
  pass.gate = undefined;
  pass.stripVersions = false;
  counters.reset();
  vi.mocked(encodeLine).mockClear();
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа на SQLite: сессии s-01 и s-02, комната r-01, одно письмо в ней. */
async function seedWork(title = 'A'): Promise<string> {
  const map = await createWork(project, { title, goal: 'цель' });
  await updateMap(project, map.work.id, (current, letters) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'x' });
    addSession(current, { provider: 'claude', label: 'код', task: 'y' });
    addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
    letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'старое' });
  });
  return map.work.id;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Служба запущена и успокоилась: хвост проходов старта (аренда, сверка) дошёл, счётчики и рассылки начинаются с нуля. */
async function started(options: WorksServiceOptions = {}): Promise<WorksService> {
  const created = createWorksService(fakeHost(), { debounceMs: 5, windowCounters: counters, ...options });
  services.push(created);
  await created.start();
  let last = -1;
  await vi.waitFor(
    () => {
      const now = counters.read().refreshCount;
      const quiet = now === last;
      last = now;
      expect(quiet).toBe(true);
    },
    { timeout: 10_000, interval: 300 },
  );
  broadcasts = [];
  counters.reset();
  return created;
}

/** Рассылки, которые кому-то дошли: вызов `broadcast` с пустым списком получателей — не событие. */
const events = (name: EventName): typeof broadcasts => broadcasts.filter((item) => item.event === name && item.to.length > 0);
const mailOf = (item: (typeof broadcasts)[number] | undefined): RoomsMailEvent => item?.data as RoomsMailEvent;

/** Письмо одной записью только писем; по умолчанию — в `r-01` от `s-02`. */
function send(workId: string, text: string, roomId: string | null = 'r-01', from = 's-02'): void {
  writeLetters(project, workId, (letters) => {
    letters.add({ kind: 'note', from, to: [], roomId, text });
  });
}

/** Пачка столько не доживёт до конца теста: рассылку ведёт снимок или удаление работы, а не таймер в 50 мс, который под нагрузкой обгоняет запись теста. */
const LONG_BATCH_MS = 30_000;

/** Закрывает полный проход: он встанет на `gitBranch` и не дойдёт до `publish`. Вернувшая функция открывает проход. */
function closePass(): () => void {
  let open = (): void => {};
  pass.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    open();
    pass.gate = undefined;
  };
}

/** Чужая запись: второе соединение с базой правит `work.goal` и поднимает версию, как `updateMap` в другом процессе (CLI, MCP агента). */
function foreignGoal(workId: string, goal: string): void {
  const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const foreign = new Database(path.join(home, 'parley.db'));
  try {
    const row = foreign.prepare('SELECT work_json FROM works WHERE project_path = ? AND id = ?').get(project, workId) as { work_json: string };
    const work = JSON.parse(row.work_json) as { goal: string };
    work.goal = goal;
    foreign.prepare('UPDATE works SET work_json = ?, version = version + 1 WHERE project_path = ? AND id = ?').run(JSON.stringify(work), project, workId);
  } finally {
    foreign.close();
  }
}

describe('письма хоста: запись только писем', () => {
  it('письмо без смены карты: одно rooms.mail, ни одного works.changed, полного прохода и onChange нет, onMail один раз', async () => {
    const id = await seedWork();
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    const notices: MailNotice[] = [];
    s.onChange(changed);
    s.onMail((notice) => notices.push(notice));

    send(id, 'новое письмо');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    expect(events('rooms.mail')).toHaveLength(1);
    expect(events('rooms.mail')[0]?.to).toEqual([modern.id]);
    expect(events('works.changed')).toEqual([]);
    expect(counters.read()).toMatchObject({ refreshCount: 0, mapBytesParsed: 0, lettersOnlyRefreshes: 0, mailEvents: 1, worksChangedEvents: 0 });
    expect(changed).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ projectPath: project, workId: id, foreign: false });
    expect(notices[0]?.journal.added.map((letter) => letter.text)).toEqual(['новое письмо']);
  });

  it('форма события: версии подряд, прежний и новый верх комнаты, итог, письмо целиком, непрочитанное человеком', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();
    const prevTop = roomLetterTops(project, id, ['r-01'])['r-01'] as number;
    const text = 'длинное письмо '.repeat(200);

    send(id, text);
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const event = mailOf(events('rooms.mail')[0]);

    expect(event).toMatchObject({ projectPath: project, workId: id, droppedRooms: [], mentionCandidates: [] });
    expect(event.version).toBe(workVersion(project, id));
    expect(event.prevVersion).toBe(event.version - 1);
    expect(event.updatedAt).toBe((await readMap(project, id)).work.updatedAt);
    expect(event.rooms).toHaveLength(1);
    const room = event.rooms[0]!;
    const top = roomLetterTops(project, id, ['r-01'])['r-01'] as number;
    expect(room).toMatchObject({ roomId: 'r-01', prevTop, top, total: letterCount(project, id, { roomId: 'r-01' }), reads: [], deleted: [] });
    expect(top).toBe(prevTop + 1);
    expect(room.reread).toBeUndefined();
    expect(room.letters).toHaveLength(1);
    expect(room.letters[0]?.text).toBe(text);
    expect(room.letters[0]?.readBy).toEqual({});
    expect(room.lastAt).toBe(room.letters[0]?.at);
    const unread = unreadCount(project, id, HUMAN);
    expect(event.unread).toEqual({ letters: unread.total, rooms: unread.byRoom });
    expect(unread.total).toBe(2);
  });

  it('длинное письмо режется как на странице: текст до потолка окна, textBytes — полный размер', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();
    const text = 'я'.repeat(40 * 1024);

    send(id, text, 'r-01', HUMAN);
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });

    const letter = mailOf(events('rooms.mail')[0]).rooms[0]?.letters[0];
    expect(letter?.textBytes).toBe(Buffer.byteLength(text));
    expect(Buffer.byteLength(letter?.text ?? '')).toBeLessThanOrEqual(WINDOW_TEXT_MAX);
    expect(letter?.text.length).toBeLessThan(text.length);
  });

  it('прямое письмо идёт как комната с roomId null; упоминание человека — кандидат в mentionCandidates', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    writeLetters(project, id, (letters) => {
      letters.add({ kind: 'note', from: 's-01', to: [HUMAN], roomId: null, text: 'вам лично' });
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'ping @human, ответьте' });
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const event = mailOf(events('rooms.mail')[0]);

    const direct = event.rooms.find((room) => room.roomId === null);
    expect(direct).toMatchObject({ prevTop: 0, top: 2, total: 1 });
    expect(direct?.letters.map((letter) => letter.text)).toEqual(['вам лично']);
    expect(event.rooms.find((room) => room.roomId === 'r-01')?.letters.map((letter) => letter.text)).toEqual(['ping @human, ответьте']);
    expect(event.mentionCandidates.map((letter) => letter.text)).toEqual(['ping @human, ответьте']);
    expect(event.unread.rooms['']).toBe(1);
  });

  it('отметка прочтения идёт в reads комнаты письма, без писем: верх не меняется; снимок для окна свежий', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const before = s.windowSnapshot();
    const at = new Date().toISOString();

    writeLetters(project, id, (letters) => {
      letters.markRead('s-01', ['m-01'], at);
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const room = mailOf(events('rooms.mail')[0]).rooms[0]!;

    expect(room).toMatchObject({ roomId: 'r-01', letters: [], reads: [{ id: 'm-01', reader: 's-01', at }], deleted: [] });
    expect(room.prevTop).toBe(room.top);
    const after = s.windowSnapshot();
    expect(after?.entries[0]?.map.messages[0]?.readBy['s-01']).toBe(at);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
  });

  it('пачка: три письма подряд — одно событие с тремя письмами, onMail на каждую запись', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const notices: MailNotice[] = [];
    s.onMail((notice) => notices.push(notice));
    const prevTop = roomLetterTops(project, id, ['r-01'])['r-01'] as number;
    const first = workVersion(project, id) as number;

    send(id, 'раз');
    send(id, 'два');
    send(id, 'три');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    expect(events('rooms.mail')).toHaveLength(1);
    const event = mailOf(events('rooms.mail')[0]);
    expect(event.rooms).toHaveLength(1);
    expect(event.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['раз', 'два', 'три']);
    expect(event.rooms[0]).toMatchObject({ prevTop, top: prevTop + 3 });
    expect(event).toMatchObject({ prevVersion: first, version: first + 3 });
    expect(notices.map((notice) => [notice.prevVersion, notice.version])).toEqual([
      [first, first + 1],
      [first + 1, first + 2],
      [first + 2, first + 3],
    ]);
    expect(counters.read().mailEvents).toBe(1);
  });

  it('потолок: 300 писем по 1 КиБ одной записью — событие не больше 256 КиБ, комната с reread', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    writeLetters(project, id, (letters) => {
      for (let i = 0; i < 300; i += 1) letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(512, 'я') });
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const item = events('rooms.mail')[0]!;
    const event = mailOf(item);

    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(item.line ?? '')).toBeLessThanOrEqual(256 * 1024);
    expect(event.rooms[0]).toMatchObject({ roomId: 'r-01', reread: true, letters: [], total: 301, top: 301, prevTop: 1 });
    expect(counters.read().mailBytes).toBe(Buffer.byteLength(item.line ?? ''));
  });

  it('медленный клиент получает склеенное событие с reread, быстрый — полное', async () => {
    const id = await seedWork();
    const fast = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const slow = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();
    slow.buffered = 2 * 1024 * 1024;

    send(id, 'письмо');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(2), { timeout: 5000 });

    const forFast = mailOf(events('rooms.mail').find((item) => item.to.includes(fast.id)));
    const forSlow = mailOf(events('rooms.mail').find((item) => item.to.includes(slow.id)));
    expect(events('rooms.mail').map((item) => item.to)).toEqual(expect.arrayContaining([[fast.id], [slow.id]]));
    expect(forFast.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['письмо']);
    expect(forFast.rooms[0]?.reread).toBeUndefined();
    expect(forSlow.rooms[0]).toMatchObject({ roomId: 'r-01', letters: [], reads: [], deleted: [], reread: true });
    // Числа абсолютные и у склеенного события те же.
    expect(forSlow).toMatchObject({ version: forFast.version, prevVersion: forFast.prevVersion, unread: forFast.unread });
    expect(forSlow.rooms[0]).toMatchObject({ prevTop: forFast.rooms[0]?.prevTop, top: forFast.rooms[0]?.top, total: forFast.rooms[0]?.total });
    expect(counters.read().mailEvents).toBe(2);
  });

  it('комната, удалённая записью без смены карты, уходит в droppedRooms, её письма в rooms[] нет', async () => {
    const map = await createWork(project, { title: 'D', goal: '' });
    // Письма r-02 старше письма r-01: после удаления r-01 `messageSeq` уже не меньше верха r-02, и удаление r-02 карту не двигает.
    await updateMap(project, map.work.id, (current, letters) => {
      addSession(current, { provider: 'claude', label: 'план', task: 'x' });
      addRoom(current, { title: 'Первая', creator: 'human', members: ['s-01'], lead: 's-01' });
      addRoom(current, { title: 'Вторая', creator: 'human', members: ['s-01'], lead: 's-01' });
      letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-02', text: 'a' });
      letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-02', text: 'b' });
      letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: 'c' });
    });
    await updateMap(project, map.work.id, (_current, letters) => letters.deleteRoom('r-01'));
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    s.onChange(changed);

    await updateMap(project, map.work.id, (_current, letters) => letters.deleteRoom('r-02'));
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    const event = mailOf(events('rooms.mail')[0]);
    expect(event.droppedRooms).toEqual(['r-02']);
    expect(event.rooms).toEqual([]);
    // Запись не структурная: полного прохода нет, хотя комната названа.
    expect(events('works.changed')).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(counters.read().refreshCount).toBe(0);
  });

  it('массовая отметка комнаты (reopened) без смены карты: комната названа с reread, писем и отметок поштучно нет', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    s.onChange(changed);

    writeLetters(project, id, (letters) => {
      letters.reopened('r-01', new Date().toISOString());
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    const event = mailOf(events('rooms.mail')[0]);
    expect(event.rooms).toHaveLength(1);
    expect(event.rooms[0]).toMatchObject({ roomId: 'r-01', letters: [], reads: [], deleted: [], reread: true });
    expect(event.rooms[0]?.prevTop).toBe(event.rooms[0]?.top);
    expect(events('works.changed')).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('работу сняли, пока пачка ждала: события нет, ошибок письма в журнале хоста нет', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    // Пачка ждёт долго: удаление работы не должно гоняться с её таймером.
    const s = await started({ mailBatchMs: LONG_BATCH_MS });
    const notices: MailNotice[] = [];
    s.onMail((notice) => notices.push(notice));

    send(id, 'письмо, которое не доживёт');
    await deleteWorkFiles(project, id);
    await sleep(400);

    expect(notices).toHaveLength(1);
    expect(events('rooms.mail')).toEqual([]);
    expect(warnings.filter((message) => message.startsWith('письма:'))).toEqual([]);
  });

  it('onMail зовётся и когда окон с признаком нет; события нет, старое окно получает works.changed', async () => {
    const id = await seedWork();
    const old = fakeClient([]);
    const s = await started();
    const notices: MailNotice[] = [];
    s.onMail((notice) => notices.push(notice));

    send(id, 'письмо');
    await vi.waitFor(() => expect(events('works.changed')).toHaveLength(1), { timeout: 5000 });

    expect(notices).toHaveLength(1);
    expect(events('rooms.mail')).toEqual([]);
    expect(events('works.changed')[0]?.to).toEqual([old.id]);
    const legacy = events('works.changed')[0]?.data as WorksSnapshot;
    expect(legacy.entries[0]?.map.messages.map((letter) => letter.text)).toContain('письмо');
    expect(legacy.entries[0]?.map.compact).toBeUndefined();
  });

  it('событие несёт только новых кандидатов: непрочитанное @human письмо из прошлого не повторяется, новое едет', async () => {
    const id = await seedWork();
    // Семьдесят непрочитанных человеком писем с @human по 4 КиБ записаны раньше: событие их не повторяет и кадр не раздувается.
    writeLetters(project, id, (letters) => {
      for (let i = 0; i < 70; i += 1) letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: `@human ${i}: ${'x'.repeat(4000)}` });
    });
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    send(id, 'новое письмо для @human');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const item = events('rooms.mail')[0]!;
    const event = mailOf(item);

    expect(event.mentionCandidates.map((letter) => letter.text)).toEqual(['новое письмо для @human']);
    expect(Buffer.byteLength(item.line ?? '')).toBeLessThan(16 * 1024);
    expect(event.rooms[0]?.reread).toBeUndefined();
    expect(event.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['новое письмо для @human']);
    // Старые письма остались непрочитанными: числа их знают, набор события — нет (его пополняет окно, а заменяет снимок).
    expect(unreadLetters(project, id, HUMAN).length).toBeGreaterThan(70);
    expect(event.unread.letters).toBe(unreadCount(project, id, HUMAN).total);

    send(id, 'письмо без упоминания');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(2), { timeout: 5000 });
    expect(mailOf(events('rooms.mail')[1]).mentionCandidates).toEqual([]);
  });

  it('письмо, прочитанное человеком в той же пачке, — не кандидат', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();
    const at = new Date().toISOString();
    let readId = '';

    writeLetters(project, id, (letters) => {
      const read = letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human, прочитано сразу' });
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human, ждёт ответа' });
      letters.markRead(HUMAN, [read.id], at);
      readId = read.id;
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const event = mailOf(events('rooms.mail')[0]);

    expect(event.rooms[0]?.reads).toEqual([{ id: readId, reader: HUMAN, at }]);
    expect(event.mentionCandidates.map((letter) => letter.text)).toEqual(['@human, ждёт ответа']);
  });

  it('письмо, помеченное удалённым в той же пачке, — не кандидат', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    writeLetters(project, id, (letters) => {
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: '@human, от уходящей сессии' });
      letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: '@human, от остающейся' });
      letters.flagDeleted('s-02');
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const event = mailOf(events('rooms.mail')[0]);

    expect(event.mentionCandidates.map((letter) => letter.text)).toEqual(['@human, от остающейся']);
    expect(event.rooms[0]?.deleted).toContain('m-02');
  });

  it('кандидаты пачки собраны под потолок уже в buildMailEvent: новейшие подряд, по возрастанию номера', async () => {
    const id = await seedWork();
    const before = workVersion(project, id) as number;
    const added = writeLetters(project, id, (letters) =>
      Array.from({ length: 70 }, (_, i) => letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: `@human ${i}: ${'x'.repeat(4000)}` })),
    );
    const batch = startBatch(project, id, before);
    joinBatch(batch, { version: workVersion(project, id) as number, journal: { added, reads: [], deleted: [], droppedRooms: [], rereadRooms: [] }, structural: false });

    // Без fitMailEvent: потолок не ждёт сборки кадра, иначе снимок (задача 7) и событие несли бы разные наборы.
    const { mentionCandidates } = buildMailEvent(batch);
    const seqs = mentionCandidates.map((letter) => Number(letter.id.slice('m-'.length)));

    expect(mentionCandidates.length).toBeGreaterThan(0);
    expect(mentionCandidates.length).toBeLessThan(70);
    expect(Buffer.byteLength(JSON.stringify(mentionCandidates)) - 2).toBeLessThanOrEqual(WINDOW_MENTION_MAX_BYTES);
    expect(mentionCandidates.at(-1)?.id).toBe(added.at(-1)?.id);
    expect(seqs.every((seq, at) => at === 0 || seq === (seqs[at - 1] as number) + 1)).toBe(true);
  });

  it('удаление письма доходит до deleted его комнаты', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    writeLetters(project, id, (letters) => {
      letters.flagDeleted('s-02');
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    const event = mailOf(events('rooms.mail')[0]);

    expect(event.rooms).toHaveLength(1);
    expect(event.rooms[0]).toMatchObject({ roomId: 'r-01', letters: [], reads: [], deleted: ['m-01'] });
    expect(event.droppedRooms).toEqual([]);
  });
});

describe('письма хоста: пачка не ждёт снимка вечно', () => {
  it('пачка, ждущая снимка, уходит не позже MAIL_HOLD_MAX_MS, даже когда полный проход не доходит до publish', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();
    // Проход встанет на gitBranch: снимка со структурной записью не будет, пачку держит только страховка.
    closePass();
    let mailAt = 0;
    onBroadcast = (event) => {
      if (event === 'rooms.mail' && mailAt === 0) mailAt = Date.now();
    };

    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    const sentAt = Date.now();
    send(id, 'письмо за структурной записью');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: MAIL_HOLD_MAX_MS + 8000 });

    // Таймер не срабатывает раньше срока: событие не вышло по снимку и не ушло по обычной пачке в 50 мс.
    expect(mailAt - sentAt).toBeGreaterThanOrEqual(MAIL_HOLD_MAX_MS - 50);
    expect(events('works.changed')).toEqual([]);
    expect(mailOf(events('rooms.mail')[0]).rooms[0]?.letters.map((letter) => letter.text)).toEqual(['письмо за структурной записью']);
  });

  it('проход, прочитавший работу без точной версии, больше не ждёт её запись: следующее письмо уходит пачкой в 50 мс, а не по потолку', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    pass.stripVersions = true;
    let mailAt = 0;
    onBroadcast = (event) => {
      if (event === 'rooms.mail' && mailAt === 0) mailAt = Date.now();
    };

    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(events('works.changed').length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(s.entry(project, id)?.version).toBeUndefined();
    const sentAt = Date.now();
    send(id, 'письмо после прохода без версии');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: MAIL_HOLD_MAX_MS + 8000 });

    expect(mailAt - sentAt).toBeLessThan(MAIL_HOLD_MAX_MS);
  });
});

describe('письма хоста: окна без признака', () => {
  it('окно с одним compact-works получает works.changed по одной работе: письмо в хвосте, полного прохода нет', async () => {
    const id = await seedWork();
    const old = fakeClient([COMPACT_WORKS_FEATURE]);
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    s.onChange(changed);
    const before = s.windowSnapshot()?.revision as number;

    send(id, 'письмо для старого окна');
    await vi.waitFor(() => expect(events('works.changed')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    expect(events('works.changed')).toHaveLength(1);
    expect(events('works.changed')[0]?.to).toEqual([old.id]);
    const snapshot = events('works.changed')[0]?.data as WorksSnapshot;
    expect(snapshot.entries[0]?.map.messages.at(-1)?.text).toBe('письмо для старого окна');
    expect(snapshot.entries[0]?.map.compact?.messages.latestId).toBe('m-02');
    expect(snapshot.revision).toBeGreaterThan(before);
    expect(snapshot.entries[0]?.version).toBe(workVersion(project, id));
    expect(events('rooms.mail').map((item) => item.to)).toEqual([[modern.id]]);
    expect(counters.read()).toMatchObject({ refreshCount: 0, worksChangedEvents: 1, mailEvents: 1 });
    expect(changed).not.toHaveBeenCalled();
  });

  it('после письма works.list уже содержит его, номер снимка вырос, запись работы несёт version', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const before = s.windowSnapshot();
    expect(before?.entries[0]?.version).toBe(workVersion(project, id));

    send(id, 'новое');
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });

    const after = s.windowSnapshot();
    expect(after?.entries[0]?.map.messages.map((letter) => letter.text)).toContain('новое');
    expect(after?.entries[0]?.version).toBe(workVersion(project, id));
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    const legacy = s.legacySnapshot();
    expect(legacy?.entries[0]?.map.messages.map((letter) => letter.text)).toContain('новое');
    expect(legacy?.entries[0]?.version).toBe(workVersion(project, id));
    expect(s.entry(project, id)?.version).toBe(workVersion(project, id));
  });
});

describe('письма хоста: смешанная запись', () => {
  it('снимок раньше события: works.changed, потом rooms.mail с version не выше версии снимка; onMail после снимка', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    s.onChange(changed);
    let snapshotsAtNotice = -1;
    s.onMail(() => {
      snapshotsAtNotice = events('works.changed').length;
    });

    await updateMap(project, id, (current, letters) => {
      addRoom(current, { title: 'Вторая', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-02', text: 'в новой комнате' });
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    const order = broadcasts.map((item) => item.event);
    const snapshotAt = order.indexOf('works.changed');
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('rooms.mail')).toBeGreaterThan(snapshotAt);
    const event = mailOf(events('rooms.mail')[0]);
    const snapshot = events('works.changed').find((item) => (item.data as WorksSnapshot).entries[0]?.map.rooms.some((room) => room.id === 'r-02'))
      ?.data as WorksSnapshot;
    expect(snapshot.entries[0]?.version).toBeGreaterThanOrEqual(event.version);
    expect(event.rooms.map((room) => room.roomId)).toEqual(['r-02']);
    expect(event.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['в новой комнате']);
    expect(snapshotsAtNotice).toBeGreaterThanOrEqual(1);
    expect(changed).toHaveBeenCalled();
    expect(counters.read().refreshCount).toBeGreaterThanOrEqual(1);
  });

  it('удаление комнаты, пока пачка ждёт: комната в droppedRooms, её писем в rooms[] нет', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    // Пачка с письмом ждёт долго: запись `deleteRoom` ложится в неё, сколько бы ни шла, а выпускает пачку снимок.
    await started({ mailBatchMs: LONG_BATCH_MS });

    send(id, 'письмо, которое переживёт не всех');
    await updateMap(project, id, (current, letters) => {
      deleteRoom(current, letters, 'r-01');
    });
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    expect(events('rooms.mail')).toHaveLength(1);
    const event = mailOf(events('rooms.mail')[0]);
    expect(event.droppedRooms).toEqual(['r-01']);
    expect(event.rooms.find((room) => room.roomId === 'r-01')).toBeUndefined();
    expect(event.rooms.flatMap((room) => room.letters).map((letter) => letter.text)).not.toContain('письмо, которое переживёт не всех');
    // Смешанная запись идёт прежним путём: снимок без комнаты ушёл раньше события.
    const order = broadcasts.map((item) => item.event);
    expect(order.indexOf('works.changed')).toBeLessThan(order.indexOf('rooms.mail'));
  });

  it('письмо после структурной записи, которую проход ещё не прочёл, её не прячет: onChange видит разницу карт', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE]);
    const s = await started();
    const goals: Array<[string | undefined, string | undefined]> = [];
    s.onChange((snapshot, previous) => goals.push([previous.entries[0]?.map.work.goal, snapshot.entries[0]?.map.work.goal]));

    // Проход закрыт, пока письмо не легло: оно точно идёт «за» структурной записью, которую проход ещё не прочёл.
    const open = closePass();
    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    // Пачка писем уходит раньше полного прохода: запись сервиса она не перечитывает, иначе `previous` уже нёс бы новую цель.
    send(id, 'письмо сразу за записью карты');
    open();
    await vi.waitFor(() => expect(goals.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });

    expect(goals[0]).toEqual(['цель', 'новая цель']);
    // Письмо всё равно дошло до окна без признака: полным проходом, вместе со структурой.
    await vi.waitFor(
      () => expect(s.windowSnapshot()?.entries[0]?.map.messages.map((letter) => letter.text)).toContain('письмо сразу за записью карты'),
      { timeout: 5000 },
    );
  });

  it('письмо за структурной записью без писем ждёт снимка с ней: works.changed раньше rooms.mail, версия снимка не ниже prevVersion', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    await started();

    // Смена цели не несёт писем, письмо идёт за ней сразу: полный проход (75 мс наблюдателя и склейка) прочтёт обе записи позже
    // таймера пачки в 50 мс. Окно с версией до смены не должно получить событие с prevVersion после неё. Проход закрыт, пока
    // письмо не легло, чтобы порядок не зависел от нагрузки.
    const open = closePass();
    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    send(id, 'письмо за сменой цели');
    open();
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    const order = broadcasts.map((item) => item.event);
    expect(order.indexOf('works.changed')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('works.changed')).toBeLessThan(order.indexOf('rooms.mail'));
    const snapshot = events('works.changed')[0]?.data as WorksSnapshot;
    const event = mailOf(events('rooms.mail')[0]);
    expect(snapshot.entries[0]?.map.work.goal).toBe('новая цель');
    expect(snapshot.entries[0]?.version).toBeGreaterThanOrEqual(event.prevVersion);
    expect(snapshot.entries[0]?.version).toBeLessThanOrEqual(event.version);
    expect(event.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['письмо за сменой цели']);
    expect(events('rooms.mail')).toHaveLength(1);
  });

  it('письмо, записанное после чтения прохода, но до выхода снимка: пачка выходит за снимком и обновляет и окно без признака', async () => {
    const id = await seedWork();
    const old = fakeClient([COMPACT_WORKS_FEATURE]);
    const modern = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    let injected = false;
    onBroadcast = (event) => {
      if (event !== 'works.changed' || injected) return;
      injected = true;
      send(id, 'после чтения прохода');
    };

    const open = closePass();
    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    send(id, 'письмо за сменой цели');
    open();
    await vi.waitFor(() => expect(events('rooms.mail')).toHaveLength(1), { timeout: 5000 });
    await sleep(300);

    const order = broadcasts.map((item) => item.event);
    expect(order.indexOf('works.changed')).toBeLessThan(order.indexOf('rooms.mail'));
    const event = mailOf(events('rooms.mail')[0]);
    expect(events('rooms.mail')[0]?.to).toEqual([modern.id]);
    expect(event.rooms[0]?.letters.map((letter) => letter.text)).toEqual(['письмо за сменой цели', 'после чтения прохода']);
    // Окно без признака: снимок прохода ушёл без позднего письма, следом ушла перечитанная работа с ним.
    const forOld = events('works.changed').filter((item) => item.to.includes(old.id));
    expect(forOld.length).toBeGreaterThanOrEqual(2);
    const lastTail = (forOld.at(-1)?.data as WorksSnapshot).entries[0]?.map.messages.map((letter) => letter.text);
    expect(lastTail).toContain('после чтения прохода');
    expect((forOld[0]?.data as WorksSnapshot).entries[0]?.map.messages.map((letter) => letter.text)).not.toContain('после чтения прохода');
    expect(s.entry(project, id)?.version).toBe(workVersion(project, id));
    expect(event.version).toBe(workVersion(project, id));
  });

  it('чужая структурная запись перед письмом не попадает в запись сервиса раньше прохода: onChange видит переход', async () => {
    const id = await seedWork();
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const goals: Array<[string | undefined, string | undefined]> = [];
    s.onChange((snapshot, previous) => goals.push([previous.entries[0]?.map.work.goal, snapshot.entries[0]?.map.work.goal]));

    // Чужую запись этот процесс не видит событием хранилища; письмо после неё идёт с prevVersion чужой записи.
    foreignGoal(id, 'чужая цель');
    send(id, 'письмо за чужой записью');
    await vi.waitFor(() => expect(goals.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await sleep(300);

    expect(goals[0]).toEqual(['цель', 'чужая цель']);
    expect(s.entry(project, id)?.map.work.goal).toBe('чужая цель');
    expect(s.entry(project, id)?.version).toBe(workVersion(project, id));
  });

  it('запись, менявшая карту, — ровно один works.changed и onChange; письма событием не идут, чужие карты не разбираются заново', async () => {
    const id = await seedWork();
    // Карты других работ тяжёлые: будь они разобраны заново, счётчик байт разбора ушёл бы за их размер.
    await createWork(project, { title: 'B', goal: 'в'.repeat(20_000) });
    await createWork(project, { title: 'C', goal: 'с'.repeat(20_000) });
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await started();
    const changed = vi.fn();
    s.onChange(changed);

    await updateMap(project, id, (current) => {
      current.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(events('works.changed').length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await sleep(300);

    expect(events('works.changed')).toHaveLength(1);
    expect(events('rooms.mail')).toEqual([]);
    expect(changed).toHaveBeenCalled();
    expect(s.entry(project, id)?.map.work.goal).toBe('новая цель');
    // Разобрана карта этой работы (несколько КиБ), а не обе карты по 20 КиБ.
    const parsed = counters.read().mapBytesParsed;
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThan(20_000);
  });
});

describe('письма хоста: одна сериализация', () => {
  function fakeSocket(): { socket: Socket; written: string[] } {
    const written: string[] = [];
    const socket = { destroyed: false, writableLength: 0, write: (chunk: string) => written.push(chunk) } as unknown as Socket;
    return { socket, written };
  }

  it('событие писем кодируется один раз, а не по разу на клиента; оба окна получают одну и ту же строку', async () => {
    const id = await seedWork();
    const handle = createHostContext({
      version: '0.0.0',
      paths: { dir: '', socket: '', token: '', pid: '', log: '' },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      onIdleChange: () => {},
      registerShutdownHook: () => {},
      requestShutdown: async () => {},
    });
    const first = fakeSocket();
    const second = fakeSocket();
    handle.addClient(createClient(first.socket, 'a', [COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]));
    handle.addClient(createClient(second.socket, 'b', [COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]));
    const s = createWorksService(handle.context, { debounceMs: 5 });
    services.push(s);
    await s.start();
    await sleep(400);
    first.written.length = 0;
    second.written.length = 0;
    vi.mocked(encodeLine).mockClear();

    send(id, 'письмо двум окнам');
    await vi.waitFor(() => expect(first.written.filter((line) => line.includes('"rooms.mail"'))).toHaveLength(1), { timeout: 5000 });
    await sleep(200);

    const mailLines = (written: string[]): string[] => written.filter((line) => line.includes('"rooms.mail"'));
    expect(mailLines(second.written)).toHaveLength(1);
    expect(mailLines(first.written)).toEqual(mailLines(second.written));
    const encodedMail = vi.mocked(encodeLine).mock.calls.filter(([message]) => 'event' in message && message.event === 'rooms.mail');
    expect(encodedMail).toHaveLength(1);
  });
});
