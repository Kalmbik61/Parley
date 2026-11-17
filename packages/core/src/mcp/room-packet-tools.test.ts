import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createParleyServer } from './tools.js';
import type { McpContext } from './context.js';
import { addSession } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';

let root: string;
let project: string;
let previous: string | undefined;
let context: McpContext;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp('/private/tmp/parley-room-packet-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await mkdir(path.join(root, 'home'));
  previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = path.join(root, 'home');
  const map = await createWork(project, { title: 'Packet tools' });
  await updateMap(project, map.work.id, (current, letters) => {
    for (const label of ['lead', 'worker', 'owner', 'two rooms', 'stranger']) addSession(current, { provider: 'claude', label, task: 'fixture' });
    // r-01: s-01 ведёт, s-02 участник, s-03 владелец вне состава (участник r-03, владелец r-01 и r-02).
    addRoom(current, { title: 'First', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01', ownerId: 's-03' });
    addRoom(current, { title: 'Second', creator: HUMAN, members: ['s-02'], lead: 's-02', ownerId: 's-03' });
    addRoom(current, { title: 'Third', creator: HUMAN, members: ['s-03', 's-04'], lead: 's-03' });
    letters.add({ roomId: 'r-01', from: HUMAN, to: ['s-02'], text: 'Which branch?', kind: 'question' });
  });
  context = { projectPath: project, workId: map.work.id, workDir: workPaths(project, map.work.id).dir, sessionId: 's-01', channel: false };
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (previous === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});

async function connect(sessionId: string | null, extra: Partial<McpContext> = {}): Promise<Client> {
  const server = createParleyServer({ ...context, ...extra, sessionId });
  const client = new Client({ name: 'fixture', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}

async function getMap(sessionId: string | null, args: Record<string, unknown>, extra: Partial<McpContext> = {}) {
  const client = await connect(sessionId, extra);
  const result = await client.callTool({ name: 'get_map', arguments: args });
  return { failed: result.isError === true, text: (result.content as { text: string }[])[0]!.text };
}

/** Имена из раздела «Tools» пакета: строка после двух строк головы. */
const packetTools = (text: string): string[] => {
  const lines = text.split('\n');
  return lines[lines.indexOf('## Tools') + 2]!.split(', ');
};

const AGENT = { url: 'http://127.0.0.1:1/agent/browser', token: 'a'.repeat(64) };

describe('get_map {field: "packet"}', () => {
  it('участнику отдаёт пакет его комнаты целиком, параметр room не нужен', async () => {
    const result = await getMap('s-01', { field: 'packet' });
    expect(result.failed).toBe(false);
    expect(result.text).toMatch(/^Room state packet [0-9a-f]{12}, r-01, \d{4}-/);
    expect(result.text).toContain('viewer: member s-01.');
    expect(result.text).toContain('## Place');
    expect(result.text).toContain('## Tools');
    expect(result.text).toContain('get_map');
  });

  it('вопрос комнаты, адресованный участнику, виден в его пакете', async () => {
    const result = await getMap('s-02', { field: 'packet', room: 'r-01' });
    expect(result.text).toContain('## Open questions');
    expect(result.text).toContain('m-01');
  });

  it('владелец вне состава без членства называет комнату и получает только её разделы', async () => {
    const result = await getMap('s-03', { field: 'packet', room: 'r-01' });
    expect(result.failed).toBe(false);
    expect(result.text).toContain('viewer: owner s-03.');
    expect(result.text).toContain('room r-01 "First"');
    for (const absent of ['## Place', '## Open questions', '## Tools']) expect(result.text).not.toContain(absent);
  });

  it('владелец с членством в другой комнате: названная комната даёт проекцию владельца, без названия — свою', async () => {
    const named = await getMap('s-03', { field: 'packet', room: 'r-02' });
    expect(named.text).toContain('viewer: owner s-03.');
    expect(named.text).toContain('room r-02 "Second"');
    expect(named.text).not.toContain('## Place');
    // Без параметра он участник единственной своей комнаты r-03, как любой участник.
    const own = await getMap('s-03', { field: 'packet' });
    expect(own.text).toContain('viewer: member s-03.');
    expect(own.text).toContain('room r-03 "Third"');
  });

  it('владелец двух комнат без членства: каждая названная комната даёт свои разделы, без названия — отказ с перечнем', async () => {
    await updateMap(project, context.workId, (map) => { map.rooms.find((room) => room.id === 'r-03')!.members = ['s-04']; });
    const first = await getMap('s-03', { field: 'packet', room: 'r-01' });
    const second = await getMap('s-03', { field: 'packet', room: 'r-02' });
    expect(first.text).toContain('room r-01 "First"');
    expect(first.text).not.toContain('"Second"');
    expect(second.text).toContain('room r-02 "Second"');
    expect(second.text).not.toContain('"First"');
    const bare = await getMap('s-03', { field: 'packet' });
    expect(bare.failed).toBe(true);
    expect(bare.text).toContain('r-01, r-02');
    expect(bare.text).not.toContain('Room state packet');
  });

  it('посторонняя сессия и несуществующая комната отказывают одинаково, без текста пакета', async () => {
    const stranger = await getMap('s-05', { field: 'packet', room: 'r-01' });
    const missing = await getMap('s-05', { field: 'packet', room: 'r-77' });
    expect(stranger.failed).toBe(true);
    expect(stranger.text).toBe('unknown-target: room r-01 is not available to this session');
    expect(missing.text).toBe('unknown-target: room r-77 is not available to this session');
    const memberElsewhere = await getMap('s-02', { field: 'packet', room: 'r-03' });
    expect(memberElsewhere.failed).toBe(true);
    expect(memberElsewhere.text).not.toContain('Room state packet');
  });

  it('сессия без комнаты получает понятный отказ без пакета', async () => {
    const result = await getMap('s-05', { field: 'packet' });
    expect(result.failed).toBe(true);
    expect(result.text).toContain('no room');
    expect(result.text).not.toContain('Room state packet');
  });

  it('без сессии и с чужими параметрами — отказ', async () => {
    expect((await getMap(null, { field: 'packet' })).failed).toBe(true);
    const extra = await getMap('s-01', { field: 'packet', session: 's-02' });
    expect(extra.failed).toBe(true);
    expect(extra.text).toContain('accepts only room');
  });

  it('имена инструментов в пакете — тот же список, что отдаёт сервер: с каналом агента, без него и в профиле short', async () => {
    const cases: Array<Partial<McpContext>> = [{}, { agent: AGENT }, { toolProfile: 'short' }, { agent: AGENT, toolProfile: 'short', skillNavigator: true }];
    for (const extra of cases) {
      const listed = (await (await connect('s-01', extra)).listTools()).tools.map((tool) => tool.name);
      const result = await getMap('s-01', { field: 'packet' }, extra);
      expect(packetTools(result.text)).toEqual(listed);
    }
    const withChannel = packetTools((await getMap('s-01', { field: 'packet' }, { agent: AGENT })).text);
    const without = packetTools((await getMap('s-01', { field: 'packet' })).text);
    for (const name of ['create_session', 'request_agent_switch', 'create_swarm', 'swarm_add', 'browser_open']) {
      expect(withChannel).toContain(name);
      expect(without).not.toContain(name);
    }
  });

  it('maxBytes не усекает пакет: не хватает — отказ с нужным размером, хватает — весь текст', async () => {
    // Пункты плана у s-01 растят пакет выше 2 КиБ.
    await updateMap(project, context.workId, (map) => {
      map.plans = [{
        id: 'pl-01', roomId: 'r-01', mode: 'checklist', status: 'active', rev: 1, goal: 'Grow the packet', backlog: [],
        items: Array.from({ length: 12 }, (_, index) => ({
          id: index + 1, title: `Item number ${index + 1} ${'t'.repeat(120)}`, owner: 's-01', scope: 'scope', after: [], criteria: [], verifier: null,
          status: 'ready' as const, evidence: null, note: null, log: [],
        })),
        acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null,
      }];
    });
    const full = await getMap('s-01', { field: 'packet' });
    const bytes = Buffer.byteLength(JSON.stringify(full.text)) - 2;
    expect(bytes).toBeGreaterThan(2048);
    const small = await getMap('s-01', { field: 'packet', maxBytes: 2048 });
    expect(small.failed).toBe(true);
    expect(small.text).toContain(`is ${bytes} bytes`);
    expect(small.text).toContain(`maxBytes of at least ${bytes}`);
    expect(small.text).not.toContain('Room state packet');
    const enough = await getMap('s-01', { field: 'packet', maxBytes: bytes });
    expect(enough.failed).toBe(false);
    // Первая строка несёт время сборки; остальное совпадает.
    expect(enough.text.split('\n').slice(1)).toEqual(full.text.split('\n').slice(1));
  });

  it('прежние поля get_map отвечают как раньше', async () => {
    const title = await getMap('s-01', { field: 'title' });
    expect(JSON.parse(title.text)).toMatchObject({ field: 'title', text: 'Packet tools' });
    const room = await getMap('s-01', { room: 'r-01' });
    expect(JSON.parse(room.text).room.id).toBe('r-01');
    expect(JSON.parse((await getMap('s-01', {})).text).map.work.id).toBe(context.workId);
  });
});

describe('плечо опыта не видно агенту (Э-1, критерий 5)', () => {
  const NAME = 'zz-hidden-exp';

  beforeEach(async () => {
    await updateMap(project, context.workId, (map) => {
      for (const [id, arm] of [['s-01', 'packet'], ['s-02', 'control']] as const) {
        map.sessions.find((session) => session.id === id)!.trial = { name: NAME, arm, at: '2026-11-17T10:00:00.000Z' };
      }
    });
  });

  it('ответы get_map по сессии, обзору, строкам, истории и комнатам не содержат ни имени опыта, ни плеча', async () => {
    const asks: Array<[string, Record<string, unknown>]> = [
      ['s-01', {}],
      ['s-01', { session: 's-02' }],
      ['s-02', { session: 's-02' }],
      ['s-01', { field: 'sessions' }],
      ['s-01', { field: 'rooms' }],
      ['s-01', { field: 'history', session: 's-02' }],
      ['s-01', { field: 'task', session: 's-02' }],
      ['s-01', { field: 'summaries' }],
      ['s-01', { field: 'packet' }],
      ['s-02', { field: 'packet', room: 'r-01' }],
    ];
    for (const [caller, args] of asks) {
      const result = await getMap(caller, args);
      const label = `${caller} ${JSON.stringify(args)}`;
      expect(result.failed, `${label} ${result.text.slice(0, 120)}`).toBe(false);
      expect(result.text, label).not.toContain(NAME);
      expect(result.text, label).not.toMatch(/\barm\b|"trial"|\btrial:/);
    }
  });
});
