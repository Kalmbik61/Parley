import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIo } from '../../test/io-spy.js';
import { DEFAULT_CONFIG } from '../config.js';
import { addRange, appendMessage, readCursorFile, withCursors, writeCursor } from '../work/journal.js';
import { addSession } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { createParleyServer, WORKSPACE_FORMAT_NEWER_TEXT } from './tools.js';
import type { McpContext } from './context.js';

/**
 * Инструменты MCP на карте-журнале (v3): письма в журналах, прочитанное в курсорах. Карту v2 те же инструменты
 * проверяет `server.test.ts`; здесь — то, что меняется с форматом. Запись на диск записывается обёрткой `node:fs/promises`.
 */

const io = vi.hoisted(() => ({ opened: [] as string[], writes: [] as string[], bytes: {} as Record<string, number> }));

// Шпион видит и `node:fs/promises` (в том числе чтение через дескриптор), и синхронный `node:fs` (приёмник писем,
// ленивая сборка карты): подробности и подключение — в `test/io-spy.ts`.
vi.mock('node:fs/promises', async (original) => (await import('../../test/io-spy.js')).spyFsPromises(await original<typeof import('node:fs/promises')>(), io));
vi.mock('node:fs', async (original) => (await import('../../test/io-spy.js')).spyFs(await original<typeof import('node:fs')>(), io));

// Снимок прочитанных байт на выходе из мутатора плановых инструментов: после него `finish` собирает карту целиком (это не мутатор).
const mutatorEnd = vi.hoisted(() => ({ bytes: null as Record<string, number> | null }));
vi.mock('../work/plan-effects.js', async (original) => {
  const actual = await original<typeof import('../work/plan-effects.js')>();
  return {
    ...actual,
    flushPlanEffects: ((...args: Parameters<typeof actual.flushPlanEffects>) => {
      mutatorEnd.bytes = { ...io.bytes };
      return actual.flushPlanEffects(...args);
    }) as typeof actual.flushPlanEffects,
  };
});

let home = '';
let project = '';
let workId = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

async function connect(sessionId: string | null, extra: Partial<McpContext> = {}): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    messageRate: DEFAULT_CONFIG.messageRate,
    channel: false,
    worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
    ...extra,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await call(client, name, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown>;
}

const paths = () => workPaths(project, workId);
const indexText = (): Promise<string> => readFile(paths().map, 'utf8');

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'журнал' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 't' });
    for (const session of map.sessions) session.lifecycle = 'active';
    addRoom(map, { title: 'one', creator: 's-01', members: ['s-02', 's-03'], lead: 's-01' });
    addRoom(map, { title: 'two', creator: 's-01', members: ['s-02'], lead: 's-01' });
  });
  const file = paths().map;
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  raw['schemaVersion'] = 3;
  delete raw['messages'];
  delete raw['decisionExports'];
  await writeFile(file, JSON.stringify(raw, null, 2));
  resetIo(io);
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('send_message на карте-журнале', () => {
  it('письмо — строка журнала комнаты; индекс и .bak не переписываются', async () => {
    const before = await indexText();
    const bakBefore = await readFile(paths().bak, 'utf8');
    const sender = await connect('s-01');
    const { messageId } = await callOk(sender, 'send_message', { to: ['s-02'], text: 'привет', room: 'r-01' });
    expect(messageId).toBe('m-r01-1');
    expect(await indexText()).toBe(before);
    expect(await readFile(paths().bak, 'utf8')).toBe(bakBefore);
    expect((await readMap(project, workId)).messages.map((message) => [message.id, message.text])).toEqual([['m-r01-1', 'привет']]);
  });

  it('индекс не читается: после первого письма (оно разбирает индекс) следующие читают только журналы и stat', async () => {
    const sender = await connect('s-01');
    await callOk(sender, 'send_message', { to: [], text: 'прогрев', room: 'r-01' });
    resetIo(io);
    await callOk(sender, 'send_message', { to: ['s-02'], text: 'ещё', room: 'r-01', replyTo: 'm-r01-1' });
    const files = [...io.opened, ...io.writes];
    expect(files.filter((file) => file === paths().map || file === paths().bak)).toEqual([]);
    // Шпион живой: журнал комнаты он видел.
    expect(io.writes.length).toBeGreaterThan(0);
    expect(io.writes.every((file) => file.includes(path.join('rooms', 'r-01')))).toBe(true);
  });

  it('контроль шпиона: после изменения индекса следующее письмо разбирает его заново', async () => {
    const sender = await connect('s-01');
    await callOk(sender, 'send_message', { to: [], text: 'прогрев', room: 'r-01' });
    await updateMap(project, workId, (map) => {
      map.work.goal = 'новая цель';
    });
    resetIo(io);
    await callOk(sender, 'send_message', { to: [], text: 'после правки', room: 'r-01' });
    expect(io.opened).toContain(paths().map);
  });

  it('предел 4096 знаков, участие в комнате и цитата чужой комнаты по-прежнему отказывают', async () => {
    const sender = await connect('s-01');
    expect((await call(sender, 'send_message', { to: [], text: 'x'.repeat(4097), room: 'r-01' })).text).toMatch(/limit 4096/);
    const two = await connect('s-03');
    expect((await call(two, 'send_message', { to: [], text: 'не участник', room: 'r-02' })).text).toMatch(/not a participant of room r-02/);
    await callOk(sender, 'send_message', { to: [], text: 'в первой', room: 'r-01' });
    const quoted = await call(sender, 'send_message', { to: [], text: 'ответ', room: 'r-02', replyTo: 'm-r01-1' });
    expect(quoted.isError).toBe(true);
    expect(quoted.text).toMatch(/message m-r01-1 is not in room r-02/);
    expect((await call(sender, 'send_message', { to: [], text: 'ответ', room: 'r-01', replyTo: 'm-r01-77' })).text).toMatch(/is not in room r-01/);
    const warned = await callOk(sender, 'send_message', { to: [], text: 'y'.repeat(1300), room: 'r-01' });
    expect(warned['warning']).toMatch(/long letter/);
  });

  it('лимит сессии за час считается по журналам: третье письмо при лимите 2 отказывает', async () => {
    const sender = await connect('s-01', { messageRate: 2 });
    await callOk(sender, 'send_message', { to: [], text: 'раз', room: 'r-01' });
    await callOk(sender, 'send_message', { to: ['s-02'], text: 'два' });
    const third = await call(sender, 'send_message', { to: [], text: 'три', room: 'r-01' });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/too many messages: 2 from this session in the last hour \(limit 2\)/);
  });

  it('письма старше часа в лимит не входят', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: [], text: 'давно', at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: [], text: 'давно 2', at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const sender = await connect('s-01', { messageRate: 1 });
    await callOk(sender, 'send_message', { to: [], text: 'сейчас', room: 'r-01' });
  });
});

describe('check_inbox на карте-журнале', () => {
  it('отдаёт непрочитанное адресату, пишет только файл курсоров и больше не отдаёт', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'тебе' });
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-03'], text: 'другому' });
    await appendMessage(project, workId, null, { from: 's-01', to: ['s-02'], text: 'прямое' });
    const reader = await connect('s-02');
    const before = await indexText();
    io.writes.length = 0;
    const first = await callOk(reader, 'check_inbox');
    expect(first['messages'].map((message: { text: string }) => message.text).sort()).toEqual(['прямое', 'тебе']);
    expect(first['more']).toBeUndefined();
    // Пишется один файл — курсоры сессии (плюс замок и временный файл рядом с ним).
    const written = io.writes.filter((file) => !file.endsWith('.lock'));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((file) => file.startsWith(path.join(paths().cursors, 's-02.json')))).toBe(true);
    expect(await indexText()).toBe(before);
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ direct: [[1, 1]], 'r-01': [[1, 2]] });
    expect((await callOk(reader, 'check_inbox'))['messages']).toEqual([]);
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'новое' });
    expect((await callOk(reader, 'check_inbox'))['messages'].map((message: { text: string }) => message.text)).toEqual(['новое']);
  });

  it('больше страницы: порциями по 50, ни потерь, ни повторов, ответ говорит more', async () => {
    for (let i = 1; i <= 120; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `письмо ${i}` });
    const reader = await connect('s-02');
    const first = await callOk(reader, 'check_inbox');
    expect(first['messages']).toHaveLength(50);
    expect(first['more']).toBe(true);
    expect(first['warning']).toMatch(/call check_inbox again/);
    // Курсор стоит ровно на последнем отданном письме, не дальше.
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-01': [[1, 50]] });
    const second = await callOk(reader, 'check_inbox');
    expect(second['messages']).toHaveLength(50);
    expect(second['more']).toBe(true);
    const third = await callOk(reader, 'check_inbox');
    expect(third['messages']).toHaveLength(20);
    expect(third['more']).toBeUndefined();
    const texts = [first, second, third].flatMap((page) => page['messages'].map((message: { text: string }) => message.text));
    expect(texts).toEqual(Array.from({ length: 120 }, (_, i) => `письмо ${i + 1}`));
    expect((await callOk(reader, 'check_inbox'))['messages']).toEqual([]);
  });

  it('предел страницы общий на все журналы: прямые и комнаты вместе не больше 50 за вызов', async () => {
    for (let i = 1; i <= 30; i += 1) await appendMessage(project, workId, null, { from: 's-01', to: ['s-02'], text: `прямое ${i}` });
    for (let i = 1; i <= 30; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `комната ${i}` });
    const reader = await connect('s-02');
    const first = await callOk(reader, 'check_inbox');
    const second = await callOk(reader, 'check_inbox');
    expect(first['messages']).toHaveLength(50);
    expect(second['messages']).toHaveLength(10);
    const ids = [...first['messages'], ...second['messages']].map((message: { id: string }) => message.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('два одновременных вызова одной сессии не раздают письмо дважды', async () => {
    for (let i = 1; i <= 80; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `письмо ${i}` });
    const a = await connect('s-02');
    const b = await connect('s-02');
    const results = await Promise.all([callOk(a, 'check_inbox'), callOk(b, 'check_inbox')]);
    const ids = results.flatMap((result) => result['messages'].map((message: { id: string }) => message.id));
    expect(ids).toHaveLength(80);
    expect(new Set(ids).size).toBe(80);
  });

  it('письма, адресованные другим, курсор пропускает: следующий вызов не перечитывает их', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-03'], text: 'не тебе' });
    const reader = await connect('s-02');
    expect((await callOk(reader, 'check_inbox'))['messages']).toEqual([]);
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-01': [[1, 1]] });
  });
});

describe('check_inbox: прочитанное по диапазонам', () => {
  it('разреженная история сессии: каждое письмо приходит ровно один раз, диапазоны склеиваются', async () => {
    for (let i = 1; i <= 10; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `письмо ${i}` });
    // Письма 3, 4 и 8 сессия уже прочла по отдельности (системные строки, отметки): прочитано не по порядку.
    await withCursors(project, workId, 's-02', async (file) => {
      addRange(file, 'r-01', 3, 4);
      addRange(file, 'r-01', 8, 8);
      return { changed: true, value: undefined };
    });
    const reader = await connect('s-02');
    const first = await callOk(reader, 'check_inbox');
    expect(first['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 1', 'письмо 2', 'письмо 5', 'письмо 6', 'письмо 7', 'письмо 9', 'письмо 10']);
    // Продвижение курсора — расширение диапазона: разрывы закрыты, остался один диапазон.
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-01': [[1, 10]] });
    expect((await callOk(reader, 'check_inbox'))['messages']).toEqual([]);
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'письмо 11' });
    expect((await callOk(reader, 'check_inbox'))['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 11']);
    expect((await callOk(reader, 'check_inbox'))['messages']).toEqual([]);
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-01': [[1, 11]] });
  });
});

describe('wait_for("inbox") на карте-журнале', () => {
  it('проба идёт по курсору, как check_inbox: читает файл курсоров и хвост после него, курсор не двигает', async () => {
    // Длинный журнал: 200 писем по ~400 байт, курсор на предпоследнем. Прочитать целиком его нельзя, не заметив шпиона.
    for (let i = 1; i <= 200; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `${i} ${'я'.repeat(190)}` });
    await writeCursor(project, workId, 's-02', 'r-01', 199);
    const journal = path.join(paths().dir, 'rooms', 'r-01', 'messages.jsonl');
    const journalSize = (await readFile(journal)).length;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const waiter = await connect('s-02');
    await call(waiter, 'wait_for', { target: 'inbox', timeoutSec: 0 });
    resetIo(io);
    const probed = await callOk(waiter, 'wait_for', { target: 'inbox', timeoutSec: 0 });
    expect(probed['messages'].map((message: { text: string }) => message.text)).toEqual([`200 ${'я'.repeat(190)}`]);
    expect(warn).not.toHaveBeenCalled();
    // Индекс не читается; курсоры прочитаны; журнал прочитан хвостом (дескриптор), а не целиком.
    expect(io.bytes[paths().map] ?? 0).toBe(0);
    expect(io.bytes[path.join(paths().cursors, 's-02.json')] ?? 0).toBeGreaterThan(0);
    expect(io.bytes[journal] ?? 0).toBeGreaterThan(0);
    expect(io.bytes[journal]!).toBeLessThan(journalSize / 4);
    // Проба курсор не двигает; check_inbox видит то же самое.
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-01': [[1, 199]] });
    const inbox = await callOk(waiter, 'check_inbox');
    expect(inbox['messages'].map((message: { id: string }) => message.id)).toEqual(probed['messages'].map((message: { id: string }) => message.id));
  });

  it('check_inbox читает хвост после курсора, а не журнал целиком (чтение через дескриптор видно шпиону)', async () => {
    for (let i = 1; i <= 200; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `${i} ${'я'.repeat(190)}` });
    await writeCursor(project, workId, 's-02', 'r-01', 199);
    const journal = path.join(paths().dir, 'rooms', 'r-01', 'messages.jsonl');
    const journalSize = (await readFile(journal)).length;
    const reader = await connect('s-02');
    await call(reader, 'wait_for', { target: 'inbox', timeoutSec: 0 }); // прогрев кэша индекса (он не журнал)
    resetIo(io);
    const inbox = await callOk(reader, 'check_inbox');
    expect(inbox['messages']).toHaveLength(1);
    expect(io.bytes[paths().map] ?? 0).toBe(0);
    expect(io.bytes[journal] ?? 0).toBeGreaterThan(0);
    expect(io.bytes[journal]!).toBeLessThan(journalSize / 4);
  });

  it('контроль шпиона: чтение целиком (`readMap` собирает все журналы) он видит в байтах', async () => {
    for (let i = 1; i <= 50; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: `${i} ${'я'.repeat(190)}` });
    const journal = path.join(paths().dir, 'rooms', 'r-01', 'messages.jsonl');
    const journalSize = (await readFile(journal)).length;
    resetIo(io);
    await readMap(project, workId);
    expect(io.bytes[journal] ?? 0).toBeGreaterThanOrEqual(journalSize);
  });
});

describe('карта v2 и отсутствующая работа в send_message', () => {
  it('v2: карта читается один раз за письмо (формат узнаётся по первым байтам)', async () => {
    const v2 = (await createWork(project, { title: 'v2' })).work.id;
    await updateMap(project, v2, (map) => {
      for (const label of ['a', 'b']) addSession(map, { provider: 'claude', label, task: 't' });
      for (const session of map.sessions) session.lifecycle = 'active';
    });
    const sender = await connect('s-01', { workId: v2, workDir: workPaths(project, v2).dir });
    const size = (await readFile(workPaths(project, v2).map)).length;
    resetIo(io);
    await callOk(sender, 'send_message', { to: ['s-02'], text: 'привет' });
    // Карта прочитана один раз (плюс блок первых байт для узнавания формата), а не дважды: меньше двух размеров файла.
    expect(io.bytes[workPaths(project, v2).map]!).toBeGreaterThanOrEqual(size);
    expect(io.bytes[workPaths(project, v2).map]!).toBeLessThan(size * 2);
  });

  it('работы нет: WorkNotFoundError вместо сырого ENOENT', async () => {
    const sender = await connect('s-01', { workId: 'w-nope', workDir: workPaths(project, 'w-nope').dir });
    const result = await call(sender, 'send_message', { to: ['s-02'], text: 'привет' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not exist/);
    expect(result.text).not.toMatch(/ENOENT/);
  });
});

describe('read_room и get_map на карте-журнале', () => {
  const fill = async (count: number): Promise<void> => {
    for (let i = 1; i <= count; i += 1) await appendMessage(project, workId, 'r-01', { from: i % 2 === 0 ? 's-02' : 's-01', to: [], text: `письмо ${i}` });
  };

  it('read_room отдаёт хвост комнаты страницей той же формы и листает назад без повторов', async () => {
    await fill(7);
    const reader = await connect('s-02');
    const first = await callOk(reader, 'read_room', { room: 'r-01', limit: 3 });
    expect(first['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 5', 'письмо 6', 'письмо 7']);
    expect(first['messages'][0]).toMatchObject({ id: 'm-r01-5', fromLabel: expect.any(String), room: { id: 'r-01', title: 'one' } });
    expect(first['page']).toMatchObject({ returned: 3, complete: false, next: 'before:5' });
    const second = await callOk(reader, 'read_room', { room: 'r-01', limit: 3, cursor: first['page'].next });
    expect(second['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 2', 'письмо 3', 'письмо 4']);
    const third = await callOk(reader, 'read_room', { room: 'r-01', limit: 3, cursor: second['page'].next });
    expect(third['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 1']);
    expect(third['page']).toMatchObject({ complete: true, next: null });
  });

  it('read_room не пускает не участника и не читает письма комнаты с пересчётом карты', async () => {
    await fill(2);
    const outsider = await connect('s-03');
    expect((await call(outsider, 'read_room', { room: 'r-02' })).text).toMatch(/not a participant of room r-02/);
  });

  it('get_map field messages: по комнате постранично вперёд (after:N), по виду, и прямые письма треда', async () => {
    await fill(5);
    await appendMessage(project, workId, null, { from: 's-01', to: ['s-02'], text: 'прямое' });
    const reader = await connect('s-02');
    const forward = await callOk(reader, 'get_map', { field: 'messages', room: 'r-01', cursor: 'after:2', maxBytes: 4096 });
    expect(forward['messages'].map((message: { text: string }) => message.text)).toEqual(['письмо 3', 'письмо 4', 'письмо 5']);
    expect(forward['page']).toMatchObject({ complete: true, next: null });
    const direct = await callOk(reader, 'get_map', { field: 'messages' });
    expect(direct['messages'].map((message: { text: string }) => message.text)).toEqual(['прямое']);
  });

  it('get_map field message: письмо по id из комнаты и прямое, чужая комната отказывает', async () => {
    await fill(3);
    await appendMessage(project, workId, null, { from: 's-01', to: ['s-02'], text: 'прямое' });
    const reader = await connect('s-02');
    expect(await callOk(reader, 'get_map', { field: 'message', id: 'm-r01-2' })).toMatchObject({ id: 'm-r01-2', text: 'письмо 2', roomId: 'r-01' });
    expect(await callOk(reader, 'get_map', { field: 'message', id: 'm-d-1' })).toMatchObject({ id: 'm-d-1', text: 'прямое', roomId: null });
    await appendMessage(project, workId, 'r-02', { from: 's-01', to: [], text: 'вторая' });
    const outsider = await connect('s-03');
    expect((await call(outsider, 'get_map', { field: 'message', id: 'm-r02-1' })).isError).toBe(true);
  });

  it('длинное письмо страницы сокращается с полным размером, как на v2', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: [], text: 'з'.repeat(30_000) });
    const reader = await connect('s-02');
    const page = await callOk(reader, 'read_room', { room: 'r-01', maxBytes: 4096 });
    expect(page['messages']).toHaveLength(1);
    expect(page['messages'][0].textBytes).toBeGreaterThan(30_000);
    expect(page['page'].cut).toBe(1);
  });
});

describe('create_room и add_to_room на карте-журнале', () => {
  it('приглашение — письмо в журнал новой комнаты, индекс получает комнату, писем в нём нет', async () => {
    const creator = await connect('s-01');
    const { roomId } = await callOk(creator, 'create_room', { title: 'новая', members: ['s-02'] });
    expect(roomId).toBe('r-03');
    const index = JSON.parse(await indexText()) as { rooms: { id: string }[]; messages?: unknown };
    expect(index.rooms.map((room) => room.id)).toContain('r-03');
    expect(index.messages).toBeUndefined();
    const inbox = await callOk(await connect('s-02'), 'check_inbox');
    expect(inbox['messages'].map((message: { text: string }) => message.text)).toEqual([expect.stringContaining('You were added to r-03')]);
  });
});

describe('propose_decision и режим комнаты на карте-журнале', () => {
  it('propose_decision ложится в слот комнаты индекса; принятие человеком пишет письмо в журнал и decisions.json', async () => {
    const lead = await connect('s-01');
    const proposed = await callOk(lead, 'propose_decision', { room: 'r-01', text: 'делаем так' });
    expect(proposed).toMatchObject({ proposalId: 'p-01' });
    const index = JSON.parse(await indexText()) as { rooms: { id: string; proposal: { text: string } | null }[] };
    expect(index.rooms.find((room) => room.id === 'r-01')?.proposal?.text).toBe('делаем так');

    const { resolveProposal } = await import('../work/proposals.js');
    let messageId = '';
    await updateMap(project, workId, (map) => {
      messageId = resolveProposal(map, 'r-01', 'p-01', 'accept').messageId;
    });
    const page = await callOk(await connect('s-02'), 'read_room', { room: 'r-01' });
    expect(page['messages'].find((message: { id: string }) => message.id === messageId)).toMatchObject({ kind: 'decision', text: 'делаем так' });
    const stored = JSON.parse(await readFile(paths().decisions, 'utf8')) as { messageId: string }[];
    expect(stored.map((row) => row.messageId)).toEqual([messageId]);
  });

  it('set_room_mode: мутатор берёт письмо из ответа setRoomMode и не читает журналы целиком', async () => {
    const base = Date.now() - 5 * 3600_000;
    for (const roomId of ['r-01', 'r-02', null]) {
      for (let i = 1; i <= 600; i += 1) await appendMessage(project, workId, roomId, { from: 's-02', to: [], text: `${i} ${'я'.repeat(100)}`, at: new Date(base + i * 1000).toISOString() });
    }
    const lead = await connect('s-01');
    resetIo(io);
    mutatorEnd.bytes = null;
    await callOk(lead, 'set_room_mode', { room: 'r-01', mode: 'checklist', reason: 'нужен порядок' });
    expect(mutatorEnd.bytes).not.toBeNull();
    for (const roomId of ['r-01', 'r-02', null]) {
      const journal = path.join(paths().dir, roomId === null ? 'direct' : path.join('rooms', roomId), 'messages.jsonl');
      const size = (await readFile(journal)).length;
      expect(mutatorEnd.bytes![journal] ?? 0, `журнал ${roomId ?? 'direct'}`).toBeLessThan(size / 2);
    }
    const index = JSON.parse(await indexText()) as { planEffects?: { messageId: string | null }[] };
    expect(index.planEffects?.map((effect) => effect.messageId)).toEqual([expect.stringMatching(/^m-r01-\d+$/)]);
  });

  it('set_room_mode: системная строка плана ложится в журнал, id письма доходит до записи доставки', async () => {
    const lead = await connect('s-01');
    await callOk(lead, 'set_room_mode', { room: 'r-01', mode: 'checklist', reason: 'нужен порядок' });
    const page = await callOk(await connect('s-02'), 'read_room', { room: 'r-01' });
    expect(page['messages'].length).toBeGreaterThan(0);
    const index = JSON.parse(await indexText()) as { messages?: unknown; rooms: { id: string; mode?: string }[]; planEffects?: { status: string; messageId: string | null }[] };
    expect(index.messages).toBeUndefined();
    // Доставка плана записала в индекс настоящий id письма журнала.
    expect(index.planEffects?.map((effect) => effect.messageId)).toEqual([expect.stringMatching(/^m-r01-\d+$/)]);
    expect(index.rooms.find((room) => room.id === 'r-01')?.mode).toBe('checklist');
  });
});

describe('старая сессия против карты-журнала', () => {
  it('сервер с supportedSchema 2: запись отказывает фразой для агента, чтение работает', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'письмо' });
    const old = await connect('s-02', { supportedSchema: 2 });
    for (const [name, args] of [
      ['send_message', { to: ['s-01'], text: 'x', room: 'r-01' }],
      ['check_inbox', {}],
      ['report', { status: 'progress', summary: 'x' }],
      ['create_room', { title: 'x', members: ['s-01'] }],
    ] as const) {
      const refused = await call(old, name, { ...args });
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toBe(WORKSPACE_FORMAT_NEWER_TEXT);
    }
    expect(WORKSPACE_FORMAT_NEWER_TEXT).toBe('workspace format is newer than this session: ask the human to restart the session');
    // Ничего не записано: ни письма, ни курсора.
    expect(await readCursorFile(project, workId, 's-02')).toEqual({});
    const map = await callOk(old, 'get_map');
    expect(map['sessionId']).toBe('s-02');
    expect((await callOk(old, 'read_room', { room: 'r-01' }))['messages']).toHaveLength(1);
  });

  it('backlog_suggest и remember тоже пишут в карту (строка в ленту комнаты) и отказывают той же фразой', async () => {
    const old = await connect('s-02', { supportedSchema: 2 });
    const before = await indexText();
    for (const [name, args] of [
      ['backlog_suggest', { kind: 'idea', title: 'что-то', why: 'потому' }],
      ['remember', { kind: 'fact', fact: 'факт', why: 'потому' }],
    ] as const) {
      const refused = await call(old, name, { ...args });
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toBe(WORKSPACE_FORMAT_NEWER_TEXT);
    }
    // Ни письма в ленте, ни записи в индексе.
    expect(await indexText()).toBe(before);
    expect((await callOk(old, 'read_room', { room: 'r-01' }))['messages']).toEqual([]);
  });

  it('карта v2 для сервера с supportedSchema 2 не новее: запись работает как раньше', async () => {
    workId = (await createWork(project, { title: 'старая' })).work.id;
    await updateMap(project, workId, (map) => {
      for (const label of ['a', 'b']) addSession(map, { provider: 'claude', label, task: 't' });
      for (const session of map.sessions) session.lifecycle = 'active';
    });
    const old = await connect('s-01', { supportedSchema: 2 });
    expect(await callOk(old, 'send_message', { to: ['s-02'], text: 'по-старому' })).toEqual({ messageId: 'm-01' });
    expect((await callOk(await connect('s-02', { supportedSchema: 2 }), 'check_inbox'))['messages']).toHaveLength(1);
  });

  it('сервер этой сборки пишет в тот же формат', async () => {
    const current = await connect('s-01', { supportedSchema: 3 });
    await callOk(current, 'send_message', { to: [], text: 'можно', room: 'r-01' });
  });
});
