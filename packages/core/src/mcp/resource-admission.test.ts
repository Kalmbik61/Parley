/** Допуск бюджета на путях MCP (P37): send_message, приглашения create_room (add_to_room письма не пишет); управление квотой не блокируется. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession, transitionSession } from '../work/map.js';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from '../work/resource-policy.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readMap, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';
import { createParleyServer } from './tools.js';

let home = '';
let project = '';
let binDir = '';
let workId = '';
let savedPath: string | undefined;
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

const limits = (patch: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...patch });

interface Call {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Call> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function connect(
  sessionId: string,
  resourceLimits: ResourceLimits | undefined,
  messageRate = DEFAULT_CONFIG.messageRate,
): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    messageRate,
    channel: false,
    worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-admission-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-admission-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-admission-bin-'));
  process.env.PARLEY_HOME = home;
  savedPath = process.env.PATH;
  process.env.PATH = '';
  const stub = path.join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = stub;

  workId = (await createWork(project, { title: 'Бюджет', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'ведущий', task: 'вести' });
    transitionSession(map, 's-01', 'active');
  });
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_CLAUDE_BIN;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await Promise.all([home, project, binDir].map((dir) => rm(dir, { recursive: true, force: true })));
});

const spawnArgs = { provider: 'claude', label: 'исп', task: 'делать' };

describe('removed session creation', () => {
  it('cannot bypass human session creation or mutate the map through the removed tool', async () => {
    const lead = await connect('s-01', limits({ workNewSessions: 0 }));
    const before = await readMap(project, workId);
    expect((await lead.listTools()).tools.some(tool => tool.name === 'spawn_session')).toBe(false);
    expect((await call(lead, 'spawn_session', spawnArgs)).isError).toBe(true);
    expect(await readMap(project, workId)).toEqual(before);
  });
});

describe('send_message и приглашения: допуск', () => {
  beforeEach(async () => {
    await updateMap(project, workId, (map) => {
      for (const label of ['a', 'b', 'c']) {
        const session = addSession(map, { provider: 'claude', label, task: 'x', parent: null });
        session.parent = 's-01';
        transitionSession(map, session.id, 'active');
      }
    });
  });

  it('messageRate=1: после письма комната с приглашениями не обходит лимит (аудит O3)', async () => {
    const lead = await connect('s-01', limits(), 1);
    expect((await call(lead, 'send_message', { to: 's-02', text: 'раз' })).isError).toBe(false);
    expect((await call(lead, 'send_message', { to: 's-02', text: 'два' })).text).toContain('too many messages');

    const room = await call(lead, 'create_room', { title: 'команда', members: ['s-02', 's-03'], lead: 's-02' });
    expect(room.isError).toBe(true);
    expect(room.text).toContain('too many messages');
    expect((await readMap(project, workId)).rooms).toEqual([]);
  });

  it('приглашения расходуют общий бюджет писем работы: N приглашённых — N писем', async () => {
    const lead = await connect('s-01', limits({ workMessages: 2 }));
    const refused = await call(lead, 'create_room', { title: 'команда', members: ['s-02', 's-03', 's-04'], lead: 's-02' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('message limit reached');
    expect(refused.text).toContain('Only the human can raise this limit');
    expect(readStoredMap(project, workId).messages).toHaveLength(0);

    const ok = await call(lead, 'create_room', { title: 'команда', members: ['s-02', 's-03'], lead: 's-02' });
    expect(ok.isError).toBe(false);
    expect(readStoredMap(project, workId).messages).toHaveLength(2);
  });

  it('комната: потолок писем комнаты уже рабочего, рассылка считает адресатов', async () => {
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'r', creator: 's-01', members: ['s-01', 's-02', 's-03', 's-04'], lead: 's-02' });
    });
    const lead = await connect('s-01', limits({ roomMessages: 2, fanout: 10 }));
    expect((await call(lead, 'send_message', { room: 'r-01', text: 'раз' })).isError).toBe(false);
    expect((await call(lead, 'send_message', { room: 'r-01', text: 'два' })).isError).toBe(false);
    const roomRefused = await call(lead, 'send_message', { room: 'r-01', text: 'три' });
    expect(roomRefused.text).toContain('in this room');
    // Прямое письмо вне комнаты комнатный потолок не задевает.
    expect((await call(lead, 'send_message', { to: 's-02', text: 'прямое' })).isError).toBe(false);

    const wide = await connect('s-01', limits({ fanout: 7 }));
    const fan = await call(wide, 'send_message', { room: 'r-01', text: 'всем' }); // 3 адресата: 6 + 3 > 7
    expect(fan.isError).toBe(true);
    expect(fan.text).toContain('delivery limit reached');
  });

  it('add_to_room: пишет только системную строку, бюджет писем не расходует и исчерпанной квотой не блокируется', async () => {
    await updateMap(project, workId, (map, letters) => {
      addRoom(map, { title: 'r', creator: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
      for (let i = 0; i < 3; i += 1) letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: `шум ${i}` });
    });
    const lead = await connect('s-01', limits({ workMessages: 3, roomMessages: 3, fanout: 3 }), 1);
    expect((await call(lead, 'send_message', { to: 's-02', text: 'ещё' })).isError).toBe(true);

    const before = readStoredMap(project, workId).messages.length;
    const added = await call(lead, 'add_to_room', { room: 'r-01', session: 's-03' });
    expect(added.isError).toBe(false);

    const map = readStoredMap(project, workId);
    expect(map.messages).toHaveLength(before + 1);
    const line = map.messages[map.messages.length - 1];
    expect(line?.from).toBe('system');
    expect(line?.to).toEqual([HUMAN]);
    // Агентских писем не прибавилось: бюджет писем остался прежним, письмо приглашённому не создано.
    expect(map.messages.filter((message) => message.from.startsWith('s-'))).toHaveLength(3);
  });

  it('исчерпанная разговорная квота не блокирует управление: report, close_session, check_inbox, get_map, read_room, wait_for', async () => {
    await updateMap(project, workId, (map, letters) => {
      addRoom(map, { title: 'r', creator: 's-01', members: ['s-01', 's-02'] });
      for (let i = 0; i < 3; i += 1) letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: `шум ${i}` });
      // Письмо от человека — вне квоты: оно не считается и не мешает.
      letters.add({ roomId: null, kind: 'note', from: HUMAN, to: ['s-02'], text: 'человек' });
    });
    const lead = await connect('s-01', limits({ workMessages: 3, roomMessages: 3, fanout: 3 }));
    expect((await call(lead, 'send_message', { to: 's-02', text: 'ещё' })).isError).toBe(true);

    expect((await call(lead, 'check_inbox')).isError).toBe(false);
    expect((await call(lead, 'get_map')).isError).toBe(false);
    expect((await call(lead, 'read_room', { room: 'r-01' })).isError).toBe(false);
    expect((await call(lead, 'wait_for', { target: 's-02', timeoutSec: 1 })).isError).toBe(false);
    expect((await call(lead, 'report', { status: 'done', summary: 'готово' })).isError).toBe(false);
    expect((await call(lead, 'close_session', { target: 's-01' })).isError).toBe(false);
    expect((await readMap(project, workId)).sessions.find((session) => session.id === 's-01')?.lifecycle).toBe('closed');
  });
});
