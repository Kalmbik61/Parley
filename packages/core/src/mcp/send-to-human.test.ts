/** Прямое письмо человеку через `send_message` без комнаты (b-014): адресат `human` — не сессия. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { humanUnreadLetters } from '../work/attention.js';
import { addSession, transitionSession } from '../work/map.js';
import { DEFAULT_RESOURCE_LIMITS } from '../work/resource-policy.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';
import { createParleyServer } from './tools.js';

let home = '';
let project = '';
let binDir = '';
let workId = '';
let savedPath: string | undefined;
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

interface Call {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Call> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function connect(sessionId: string, workMessages = DEFAULT_RESOURCE_LIMITS.workMessages): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    messageRate: DEFAULT_CONFIG.messageRate,
    channel: false,
    worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
    resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, workMessages },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-tohuman-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-tohuman-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-tohuman-bin-'));
  process.env.PARLEY_HOME = home;
  savedPath = process.env.PATH;
  process.env.PATH = '';
  const stub = path.join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = stub;

  workId = (await createWork(project, { title: 'Человеку', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['один', 'два']) {
      addSession(map, { provider: 'claude', label, task: 'x' });
    }
    transitionSession(map, 's-01', 'active');
    transitionSession(map, 's-02', 'active');
    addRoom(map, { title: 'r', creator: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
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

describe('send_message человеку', () => {
  it('без комнаты с to: human — прямое письмо человеку: в карте, окно считает его непрочитанным', async () => {
    const agent = await connect('s-01');
    const sent = await call(agent, 'send_message', { to: ['human'], text: 'готово, глянь', kind: 'question' });
    expect(sent.isError).toBe(false);

    const map = readStoredMap(project, workId);
    expect(map.messages).toHaveLength(1);
    expect(map.messages[0]).toMatchObject({ roomId: null, from: 's-01', to: [HUMAN], kind: 'question' });
    expect(humanUnreadLetters(map).map((message) => message.id)).toEqual([map.messages[0]?.id]);
  });

  it('строкой to: "human" — то же письмо; в ящик ни одной сессии оно не попадает', async () => {
    const agent = await connect('s-01');
    expect((await call(agent, 'send_message', { to: 'human', text: 'вопрос' })).isError).toBe(false);

    const other = await connect('s-02');
    expect(JSON.parse((await call(other, 'check_inbox')).text)).toEqual({ messages: [] });
    const own = await connect('s-01');
    expect(JSON.parse((await call(own, 'check_inbox')).text)).toEqual({ messages: [] });
  });

  it('в комнате to: human — прежняя ошибка, письмо не записано', async () => {
    const agent = await connect('s-01');
    const refused = await call(agent, 'send_message', { room: 'r-01', to: ['human'], text: 'эй' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('session human is not in the map');
    expect(readStoredMap(project, workId).messages).toHaveLength(0);
  });

  it('replyTo без комнаты — прежняя ошибка, в том числе в письме человеку', async () => {
    const agent = await connect('s-01');
    const refused = await call(agent, 'send_message', { to: ['human'], text: 'ответ', replyTo: 'm-01' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('replyTo works only together with room');
    expect(readStoredMap(project, workId).messages).toHaveLength(0);
  });

  it('больше одного адресата без комнаты — ошибка, даже если среди них человек', async () => {
    const agent = await connect('s-01');
    const refused = await call(agent, 'send_message', { to: ['human', 's-02'], text: 'обоим' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('without room, exactly one addressee in to is required');
    expect(readStoredMap(project, workId).messages).toHaveLength(0);
  });

  it('письмо человеку считается в бюджете писем работы, как письмо одному адресату', async () => {
    const agent = await connect('s-01', 1);
    expect((await call(agent, 'send_message', { to: ['human'], text: 'раз' })).isError).toBe(false);
    const refused = await call(agent, 'send_message', { to: ['s-02'], text: 'два' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('message limit reached');
    expect(readStoredMap(project, workId).messages).toHaveLength(1);
  });
});
