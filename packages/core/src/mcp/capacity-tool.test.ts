import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import type { CapacityFacts, CapacityReport } from '../work/capacity-report.js';
import { addSession, transitionSession } from '../work/map.js';
import { DEFAULT_RESOURCE_LIMITS, RESOURCE_WINDOW_MS } from '../work/resource-policy.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import type { McpContext } from './context.js';
import { createParleyServer } from './tools.js';

/** Инструмент `get_capacity` (спека сна и ёмкости 2026-10-30, 4.3): ответ собирает `capacityReport`, числа машины даёт хост. */

let home = '';
let project = '';
let workId = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

async function connect(sessionId: string | null, capacity?: McpContext['capacity']): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    messageRate: DEFAULT_CONFIG.messageRate,
    channel: false,
    worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
    ...(capacity ? { capacity } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name: 'get_capacity', arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function report(client: Client): Promise<CapacityReport> {
  const result = await call(client);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as CapacityReport;
}

const facts = (patch: Partial<CapacityFacts['machine']> = {}, activity: CapacityFacts['activity'] = { subagents: 1, background: ['shell', 'subagent'] }): CapacityFacts => ({
  machine: { live: 17, limit: 18, queued: 0, pressure: 'normal', swapGb: 1.25, sleepMinutes: 60, ...patch },
  activity,
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  const map = await createWork(project, { title: 'Ёмкость', goal: 'числа' });
  workId = map.work.id;
  // s-01 — вызывающий и живой, s-02 — его подсессия, она спит.
  await updateMap(project, workId, (current) => {
    addSession(current, { provider: 'claude', label: 'ведущий', task: 'считать' });
    transitionSession(current, 's-01', 'active');
    addSession(current, { provider: 'claude', label: 'помощник', task: 'помогать', createdBy: 's-01' });
    transitionSession(current, 's-02', 'active');
    transitionSession(current, 's-02', 'sleeping');
  });
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('get_capacity', () => {
  it('без хоста: machine null, работа по карте', async () => {
    const result = await report(await connect('s-01'));
    expect(result.machine).toBeNull();
    expect(result.workspace).toMatchObject({ live: `1/${DEFAULT_RESOURCE_LIMITS.workConcurrent}`, asleep: 1, queued: 0 });
    expect(result.you).toMatchObject({ children: { running: 0, asleep: 1, queued: 0 }, subagents: null, background: null });
    expect(result.limitedBy).toBe('workConcurrent');
    expect(result.canStart).toBe(DEFAULT_RESOURCE_LIMITS.workConcurrent - 1);
  });

  it('с хостом: числа машины и активность из context.capacity', async () => {
    let asked = 0;
    const client = await connect('s-01', async () => {
      asked += 1;
      return facts();
    });
    const result = await report(client);
    expect(asked).toBe(1);
    expect(result.machine).toEqual({ live: '17/18', queued: 0, memory: 'normal', swapGb: 1.25, sleepAfterMin: 60 });
    expect(result.you).toMatchObject({ subagents: 1, background: { shell: 1 } });
    expect(result.canStart).toBe(1);
    expect(result.limitedBy).toBe('machine');
    expect(result.hint).toBe('1 more can start now; further sessions will queue.');
  });

  it('хост вернул null — как без хоста', async () => {
    const result = await report(await connect('s-01', async () => null));
    expect(result.machine).toBeNull();
    expect(result.you).toMatchObject({ subagents: null, background: null });
  });

  it('без сессии: you null, machine по хосту', async () => {
    const result = await report(await connect(null, async () => facts()));
    expect(result.you).toBeNull();
    expect(result.room).toBeNull();
    expect(result.machine?.live).toBe('17/18');
  });

  it('отвергает аргументы', async () => {
    const result = await call(await connect('s-01'), { x: 1 });
    expect(result.isError).toBe(true);
  });

  it('письма за час: только письма агентов за последний час, без полной истории', async () => {
    const now = Date.now();
    await updateMap(project, workId, (_current, letters) => {
      letters.add({ roomId: null, from: 's-01', to: ['s-02'], text: 'раз', kind: 'note' });
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'два', kind: 'note' });
      letters.add({ roomId: null, from: 'human', to: ['s-01'], text: 'от человека', kind: 'note' });
      letters.add({ roomId: null, from: 's-01', to: ['s-02'], text: 'давно', kind: 'note', at: new Date(now - RESOURCE_WINDOW_MS - 60_000).toISOString() });
    });
    const result = await report(await connect('s-01'));
    expect(result.workspace.messagesHour).toBe(`2/${DEFAULT_RESOURCE_LIMITS.workMessages}`);
  });
});
