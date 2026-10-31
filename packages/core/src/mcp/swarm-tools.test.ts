import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession } from '../work/map.js';
import { createWork, readMap, updateMap } from '../work/store.js';
import { createParleyServer } from './tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from './swarm-tools.js';

const TOKEN = 'ab'.repeat(32);
const opened: Array<{ client: Client; server: ReturnType<typeof createParleyServer> }> = [];
let endpoint: Server | undefined;
let answer: { status: number; body: unknown };
const requests: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = [];

async function startEndpoint(): Promise<string> {
  answer = { status: 200, body: { ok: true, result: { swarmId: 'sw-01', queenSessionId: 's-02' } } };
  endpoint = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => endpoint!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/agent/browser`;
}

async function connect(url?: string, sessionId: string | null = 's-01'): Promise<Client> {
  const server = createParleyServer({
    projectPath: '/fixture', workId: 'w-01', workDir: '/fixture/.parley/works/w-01', sessionId, channel: false,
    ...(url === undefined ? {} : { agent: { url, token: TOKEN } }),
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: result.isError, text: content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
}

const CREATE = { tag: 'Audit', objective: 'Audit the repository', provider: 'claude' };
const ADD = { role: 'drone', task: 'Read packages/core', provider: 'claude' };

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) { await client.close(); await server.close(); }
  if (endpoint) await new Promise<void>((resolve, reject) => endpoint!.close(error => error ? reject(error) : resolve()));
  endpoint = undefined;
  requests.length = 0;
});

describe('create_swarm и swarm_add MCP', () => {
  it('объявлены только сессии с каналом хоста, как create_session', async () => {
    const url = await startEndpoint();
    for (const client of [await connect(), await connect(url, null)]) {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('create_swarm');
      expect(names).not.toContain('swarm_add');
    }
    const tools = (await (await connect(url)).listTools()).tools;
    expect(tools.find(tool => tool.name === 'create_swarm')).toMatchObject({
      inputSchema: { required: ['tag', 'objective', 'provider'], additionalProperties: false },
    });
    expect(tools.find(tool => tool.name === 'swarm_add')).toMatchObject({
      inputSchema: { required: ['role', 'task', 'provider'], additionalProperties: false },
    });
    // Рой по токену: ни рой, ни работу модель выбрать не может.
    for (const tool of [CREATE_SWARM_TOOL, SWARM_ADD_TOOL]) {
      expect(tool.inputSchema.properties).not.toHaveProperty('swarmId');
      expect(tool.inputSchema.properties).not.toHaveProperty('workId');
      expect(tool.inputSchema.properties).not.toHaveProperty('op');
    }
  });

  it('описания говорят, когда рой не нужен, что он только читает и куда идёт итог', () => {
    expect(CREATE_SWARM_TOOL.description).toMatch(/does not fit one context/);
    expect(CREATE_SWARM_TOOL.description).toMatch(/one agent/);
    expect(CREATE_SWARM_TOOL.description).toMatch(/read-only/);
    expect(CREATE_SWARM_TOOL.description).toMatch(/result goes to you/);
    expect(CREATE_SWARM_TOOL.description).toMatch(/research-swarm skill/);
    expect(SWARM_ADD_TOOL.description).toMatch(/report done/);
    expect(SWARM_ADD_TOOL.description).toMatch(/closed automatically/);
  });

  it('create_swarm шлёт op create с токеном сессии и возвращает swarmId и королеву', async () => {
    const client = await connect(await startEndpoint());
    const result = await call(client, 'create_swarm', { ...CREATE, model: 'opus', effort: 'high', role: 'builtin:researcher' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.text)).toEqual({ swarmId: 'sw-01', queenSessionId: 's-02' });
    expect(requests).toEqual([{ url: '/agent/swarms', authorization: `Bearer ${TOKEN}`, body: { ...CREATE, model: 'opus', effort: 'high', role: 'builtin:researcher', op: 'create' } }]);
  });

  it('swarm_add шлёт op add; op от модели хост не получает', async () => {
    const client = await connect(await startEndpoint());
    answer.body = { ok: true, result: { sessionId: 's-03', member: 'Drone 1' } };
    const result = await call(client, 'swarm_add', ADD);
    expect(JSON.parse(result.text)).toEqual({ sessionId: 's-03', member: 'Drone 1' });
    expect(requests[0]).toMatchObject({ url: '/agent/swarms', body: { ...ADD, op: 'add' } });
    // Схема закрыта, но и поддельный `op` внутри вызова хост получил бы только настоящим.
    await call(client, 'swarm_add', { ...ADD, op: 'create' });
    expect(requests.every(request => (request.body as { op: string }).op === 'add')).toBe(true);
  });

  it('queued в ответе create_swarm и swarm_add — вторым блоком фраза про очередь машины, как у create_session', async () => {
    const queuedNote =
      'The session is queued: this machine is at its agent limit or low on memory. It starts by itself when a slot frees; wait_for on its id waits for it as for a running session.';
    const client = await connect(await startEndpoint());
    answer.body = { ok: true, result: { swarmId: 'sw-01', queenSessionId: 's-02', queued: 'machine-limit' } };
    const created = await call(client, 'create_swarm', CREATE);
    expect(created.isError).not.toBe(true);
    const [createdJson, createdNote, ...createdRest] = created.text.split('\n');
    expect(JSON.parse(createdJson!)).toEqual({ swarmId: 'sw-01', queenSessionId: 's-02', queued: 'machine-limit' });
    expect(createdNote).toBe(queuedNote);
    expect(createdRest).toEqual([]);

    answer.body = { ok: true, result: { sessionId: 's-03', member: 'Drone 1', queued: 'memory-critical' } };
    const added = await call(client, 'swarm_add', ADD);
    expect(added.isError).not.toBe(true);
    const [addedJson, addedNote, ...addedRest] = added.text.split('\n');
    expect(JSON.parse(addedJson!)).toEqual({ sessionId: 's-03', member: 'Drone 1', queued: 'memory-critical' });
    expect(addedNote).toBe(queuedNote);
    expect(addedRest).toEqual([]);
  });

  it('без queued, и с незнакомой причиной, рой отвечает одним блоком', async () => {
    const client = await connect(await startEndpoint());
    expect((await call(client, 'create_swarm', CREATE)).text).not.toContain('queued');
    answer.body = { ok: true, result: { sessionId: 's-03', member: 'Drone 1', queued: 'something-new' } };
    expect((await call(client, 'swarm_add', ADD)).text.split('\n')).toHaveLength(1);
  });

  it('отказы хоста уходят текстом code: message', async () => {
    const client = await connect(await startEndpoint());
    answer.body = { ok: false, error: { code: 'not-queen', message: 'Only the queen of a swarm can add members to it.' } };
    expect(await call(client, 'swarm_add', ADD)).toEqual({ isError: true, text: 'not-queen: Only the queen of a swarm can add members to it.' });
    answer.body = { ok: false, error: { code: 'swarm-member', message: 'blocked' } };
    expect(await call(client, 'create_swarm', CREATE)).toEqual({ isError: true, text: 'swarm-member: blocked' });
  });

  it('без канала хоста объясняет, не трогая сеть; неверный ответ не выдаётся за созданный рой', async () => {
    const offline = await call(await connect(), 'create_swarm', CREATE);
    expect(offline.isError).toBe(true);
    const client = await connect(await startEndpoint());
    answer.body = { ok: true, result: { sessionId: 's-09' } };
    const wrong = await call(client, 'create_swarm', CREATE);
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('get_map');
    answer.status = 401;
    expect((await call(client, 'swarm_add', ADD)).text).toContain('token');
    answer.status = 404;
    expect((await call(client, 'swarm_add', ADD)).text).toContain('does not support');
  });
});

describe('вход в комнату участника роя', () => {
  let project = '';
  afterEach(async () => { await rm(project, { recursive: true, force: true }); });

  it('add_to_room и create_room отказывают сессии роя и ничего не пишут', async () => {
    project = await mkdtemp(path.join(tmpdir(), 'parley-swarm-room-'));
    const work = await createWork(project, { title: 'Swarm', goal: '' });
    await updateMap(project, work.work.id, (map) => {
      for (const label of ['lead', 'drone', 'plain']) addSession(map, { provider: 'claude', label, task: 'т' });
      map.swarms = [{
        id: 'sw-01', tag: 'T', creator: { kind: 'human' }, objective: 'o', queen: 's-02',
        members: [{ sessionId: 's-02', role: 'queen', n: 1, addedAt: new Date().toISOString(), handedAt: null }],
        status: 'running', createdAt: new Date().toISOString(), endedAt: null, expiredAt: null, result: null, failure: null, seenAt: null,
      }];
    });
    const server = createParleyServer({ projectPath: project, workId: work.work.id, workDir: path.join(project, '.parley'), sessionId: 's-01', channel: false });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    opened.push({ client, server });

    const created = await call(client, 'create_room', { title: 'Team', members: ['s-01'], lead: 's-01' });
    expect(created.isError).not.toBe(true);
    const roomId = (JSON.parse(created.text) as { roomId: string }).roomId;
    const refused = await call(client, 'add_to_room', { room: roomId, session: 's-02' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('swarm-member');
    const refusedRoom = await call(client, 'create_room', { title: 'Other', members: ['s-01', 's-02'], lead: 's-01' });
    expect(refusedRoom.isError).toBe(true);
    expect(refusedRoom.text).toContain('swarm-member');
    const map = await readMap(project, work.work.id);
    expect(map.rooms).toHaveLength(1);
    expect(map.rooms[0]?.members).toEqual(['s-01']);
    expect((await call(client, 'add_to_room', { room: roomId, session: 's-03' })).isError).not.toBe(true);
  });
});
