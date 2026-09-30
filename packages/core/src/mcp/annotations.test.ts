import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addMessage, addSession } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { HUMAN, type WorkMap } from '../work/types.js';
import { createParleyServer } from './tools.js';

/**
 * Аннотации MCP инструментов `harnas` (спека комнат, решение 13). По ним Codex решает, спрашивать ли
 * человека перед вызовом: без аннотаций он спросил бы перед каждым (незаданные `destructiveHint` и
 * `openWorldHint` считаются истиной), а с `readOnlyHint: true` не спрашивает вовсе. Поэтому
 * аннотация — обещание клиенту, и тесты проверяют не только таблицу, но и что она правда: чтения
 * ничего не пишут на диск, записи пишут, но не удаляют из карты ни сессий, ни комнат, ни писем и не
 * закрывают сессий — это делает только `close_session`.
 */

interface Hints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** Чтения: карта, лента, гид, ожидание — ничего не меняют. */
const READ: Hints = { readOnlyHint: true };
/** Записи в карту, комнаты и письма: сессий, комнат и писем не удаляют, наружу карты не выходят. */
const WRITE: Hints = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
/** Закрытие сессии насовсем — единственное разрушающее действие. */
const DESTROY: Hints = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const TABLE: Record<string, Hints> = {
  get_map: READ,
  read_room: READ,
  read_guide: READ,
  wait_for: READ,
  check_inbox: WRITE,
  report: WRITE,
  send_message: WRITE,
  create_room: WRITE,
  add_to_room: WRITE,
  propose_decision: WRITE,
  spawn_session: WRITE,
  close_session: DESTROY,
};

let home = '';
let project = '';
let binDir = '';
let workId = '';
const opened: { client: Client; server: Server }[] = [];

async function connect(sessionId: string | null = 's-01'): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    messageRate: DEFAULT_CONFIG.messageRate,
    channel: false,
    worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function callOk(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError, `${name}: ${result.text}`).toBe(false);
  return result;
}

/** Все файлы каталога: путь → размер, время записи и содержимое. Переписанный файл виден и без смены текста. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      const info = await stat(file);
      files[path.relative(root, file)] = `${info.size}:${info.mtimeMs}:${await readFile(file, 'utf8')}`;
    }
  };
  await walk(root);
  return files;
}

const snapshotAll = async () => ({ project: await snapshot(project), home: await snapshot(home) });

const ids = (map: WorkMap) => ({
  sessions: map.sessions.map((session) => session.id),
  rooms: map.rooms.map((room) => room.id),
  messages: map.messages.map((message) => message.id),
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-bin-'));
  process.env.PARLEY_HOME = home;
  // `spawn_session` проверяет команду провайдера в PATH: подсунут файл-заглушка, настоящий `claude` не запускается.
  const stub = path.join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = stub;

  const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
  workId = map.work.id;
  // s-01 — вызывающий и ведущий комнаты r-01; s-02 и s-03 — его подчинённые; s-02 в комнате, s-03 нет.
  // От s-02 лежит непрочитанное письмо: им проверяется, что чтения отметок прочтения не ставят.
  await updateMap(project, workId, (current) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'составить план' });
    addSession(current, { provider: 'claude', label: 'бэк', task: 'бэкенд', parent: 's-01' });
    addSession(current, { provider: 'claude', label: 'тесты', task: 'тесты', parent: 's-01' });
    addRoom(current, { title: 'Разбор', creator: 's-01', members: ['s-02'], lead: 's-01' });
    addMessage(current, { from: 's-02', to: ['s-01'], text: 'Что делаем?', kind: 'question' });
    addMessage(current, { from: 's-02', to: [], text: 'Готов', kind: 'note', roomId: 'r-01' });
  });
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_CLAUDE_BIN;
  await Promise.all([home, project, binDir].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('аннотации инструментов harnas: таблица', () => {
  it('у каждого инструмента сервера есть аннотации, и они ровно по таблице решения 13', async () => {
    const { tools } = await (await connect()).listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TABLE).sort());
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual(TABLE[tool.name]);
    }
  });

  it('только close_session помечен разрушающим; только чтения — read-only', async () => {
    const { tools } = await (await connect()).listTools();

    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint === true);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);

    expect(destructive.map((tool) => tool.name)).toEqual(['close_session']);
    expect(readOnly.map((tool) => tool.name).sort()).toEqual([
      'get_map',
      'read_guide',
      'read_room',
      'wait_for',
    ]);
  });

  it('сессия без PARLEY_SESSION_ID видит те же аннотации: они не зависят от контекста', async () => {
    const { tools } = await (await connect(null)).listTools();

    for (const tool of tools) expect(tool.annotations, tool.name).toEqual(TABLE[tool.name]);
  });
});

describe('аннотации инструментов harnas: правда по коду', () => {
  it('чтения ничего не пишут: ни карту, ни файлы проекта, ни дом харнесса', async () => {
    const client = await connect();
    const before = await snapshotAll();

    await callOk(client, 'get_map');
    await callOk(client, 'read_guide');
    await callOk(client, 'read_guide', { topic: 'letters' });
    await callOk(client, 'read_room', { room: 'r-01' });
    // Письмо уже лежит непрочитанным — `wait_for` возвращает его сразу.
    const inbox = await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    expect(inbox.text).toContain('Что делаем?');
    // Сессия ещё работает — ожидание по таймауту, без записей.
    expect(JSON.parse((await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0 })).text)).toEqual({
      state: 'running',
    });

    expect(await snapshotAll()).toEqual(before);
  });

  it('read_room и wait_for("inbox") прочитанным не отмечают: письма ждут check_inbox', async () => {
    const client = await connect();

    await callOk(client, 'read_room', { room: 'r-01' });
    await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    const inbox = JSON.parse((await callOk(client, 'check_inbox')).text) as {
      messages: { text: string }[];
    };

    expect(inbox.messages.map((message) => message.text)).toEqual(['Что делаем?', 'Готов']);
  });

  it('check_inbox пишет: помечает письма прочитанными — это не чтение', async () => {
    const client = await connect();
    const before = await readMap(project, workId);
    expect(before.messages.every((message) => message.readBy['s-01'] === undefined)).toBe(true);

    await callOk(client, 'check_inbox');

    const after = await readMap(project, workId);
    expect(after.messages.every((message) => message.readBy['s-01'] !== undefined)).toBe(true);
  });

  /** Вызов каждой записи с годными аргументами; `close_session` идёт отдельно — он разрушающий. */
  const WRITES: { name: string; args: Record<string, unknown> }[] = [
    { name: 'report', args: { status: 'progress', summary: 'идём' } },
    { name: 'send_message', args: { to: 's-02', text: 'привет' } },
    { name: 'create_room', args: { title: 'Ещё', members: ['s-03'] } },
    { name: 'add_to_room', args: { room: 'r-01', session: 's-03' } },
    { name: 'propose_decision', args: { room: 'r-01', text: 'делаем так' } },
    { name: 'spawn_session', args: { provider: 'claude', label: 'ревью', task: 'проверить' } },
    { name: 'check_inbox', args: {} },
  ];

  it.each(WRITES)('$name пишет в карту, но не уничтожает ни сессий, ни комнат, ни писем', async ({ name, args }) => {
    const client = await connect();
    const before = await readMap(project, workId);

    await callOk(client, name, args);

    const after = await readMap(project, workId);
    expect(after).not.toEqual(before);
    // «Не разрушает»: всё, что было в карте, в ней осталось.
    for (const [kind, list] of Object.entries(ids(before))) {
      expect(ids(after)[kind as keyof ReturnType<typeof ids>], `${name}: ${kind}`).toEqual(
        expect.arrayContaining(list),
      );
    }
    // Ни одна запись не «закрыта» вызовом, который об этом не просили.
    expect(
      after.sessions.filter((session) => session.lifecycle === 'closed').map((session) => session.id),
    ).toEqual([]);
  });

  it('add_to_room уводит сессию из прежней комнаты: та остаётся с письмами и участниками, а lead и creator уходят с сессией', async () => {
    // r-02 создала и ведёт s-03, в ней ещё s-04; ведущий r-01 s-01 зовёт s-03 к себе.
    await updateMap(project, workId, (current) => {
      addSession(current, { provider: 'claude', label: 'ревью', task: 'ревью', parent: 's-01' });
      addRoom(current, { title: 'Прежняя', creator: 's-03', members: ['s-04'], lead: 's-03' });
      addMessage(current, { from: 's-04', to: [], text: 'Начали', kind: 'note', roomId: 'r-02' });
    });
    const client = await connect();
    const before = await readMap(project, workId);

    await callOk(client, 'add_to_room', { room: 'r-01', session: 's-03' });

    const after = await readMap(project, workId);
    // Уход виден в записи прежней комнаты: s-03 больше не создатель и не ведущий, участник остался один.
    expect(after.rooms.find((room) => room.id === 'r-02')).toMatchObject({
      creator: HUMAN,
      lead: null,
      members: ['s-04'],
    });
    expect(after.rooms.find((room) => room.id === 'r-01')?.members).toEqual(['s-02', 's-03']);
    // Но ни комната, ни её письма, ни другие участники не пропали: «не разрушает» держится и на этой границе.
    for (const [kind, list] of Object.entries(ids(before))) {
      expect(ids(after)[kind as keyof ReturnType<typeof ids>], kind).toEqual(expect.arrayContaining(list));
    }
    expect(
      after.messages.filter((message) => message.roomId === 'r-02').map((message) => message.text),
    ).toEqual(['Начали']);
  });

  it('close_session — единственный, что меняет судьбу сессии насовсем: она закрыта и писем не получает', async () => {
    const client = await connect();

    await callOk(client, 'close_session', { target: 's-02' });

    const after = await readMap(project, workId);
    expect(after.sessions.find((session) => session.id === 's-02')?.lifecycle).toBe('closed');
    const refused = await call(client, 'send_message', { to: 's-02', text: 'ты тут?' });
    expect(refused.isError).toBe(true);
  });
});
