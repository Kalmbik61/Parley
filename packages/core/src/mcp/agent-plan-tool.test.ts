import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { createParleyServer } from './tools.js';

let root: string;
let project: string;
let workId: string;
let previous: string | undefined;
const clients: Client[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-personal-plan-'));
  project = path.join(root, 'project');
  await mkdir(project);
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  workId = (await createWork(project, { title: 'Personal plans' })).work.id;
  await updateMap(project, workId, map => {
    for (const provider of ['codex', 'claude']) {
      const session = addSession(map, { provider, label: provider, task: 'Implement and verify' });
      transitionSession(map, session.id, 'active');
    }
  });
});
afterEach(async () => {
  await Promise.all(clients.map(client => client.close()));
  clients.length = 0;
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
async function connect(sessionId: string | null = 's-01'): Promise<Client> {
  const server = createParleyServer({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId, channel: false });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}
const steps = [{ step: 'Implement', status: 'in_progress', description: 'Change the bounded flow' }, { step: 'Verify', status: 'pending' }];

it.each(['s-01', 's-02'])('publishes and replaces only the caller’s plan without messages (%s)', async sessionId => {
  const client = await connect(sessionId);
  expect((await client.listTools()).tools.some(tool => tool.name === 'publish_agent_plan')).toBe(true);
  const before = await readMap(project, workId);
  expect((await client.callTool({ name: 'publish_agent_plan', arguments: { steps } })).isError).not.toBe(true);
  let map = await readMap(project, workId);
  expect(map.sessions.find(s => s.id === sessionId)?.agentPlan?.items[0]).toMatchObject({ subject: 'Implement', status: 'in_progress', description: 'Change the bounded flow' });
  expect(map.sessions.find(s => s.id !== sessionId)?.agentPlan).toBeUndefined();
  expect(map.messages).toEqual(before.messages);
  expect(map.plans).toEqual(before.plans);
  const completed = steps.map(step => ({ ...step, status: 'completed' }));
  await client.callTool({ name: 'publish_agent_plan', arguments: { steps: completed, explanation: 'Checks passed' } });
  map = await readMap(project, workId);
  expect(map.sessions.find(s => s.id === sessionId)?.agentPlan?.items.every(item => item.status === 'completed')).toBe(true);
  await client.callTool({ name: 'publish_agent_plan', arguments: { steps: [] } });
  expect((await readMap(project, workId)).sessions.find(s => s.id === sessionId)?.agentPlan?.items).toEqual([]);
});
it.each([
  { steps, sessionId: 's-02' },
  { steps, projectPath: '/tmp/elsewhere' },
  { steps: [{ step: ' ', status: 'pending' }] },
  { steps: [{ step: 'Bad', status: 'done' }] },
  { steps: [{ step: 'A', status: 'in_progress' }, { step: 'B', status: 'in_progress' }] },
  { steps: Array.from({ length: 51 }, () => steps[0]) },
  { steps: [{ ...steps[0], description: 'x'.repeat(4097) }] },
])('rejects invalid or redirected input atomically', async args => {
  const client = await connect();
  const file = workPaths(project, workId).map;
  const before = await readFile(file, 'utf8');
  expect((await client.callTool({ name: 'publish_agent_plan', arguments: args })).isError).toBe(true);
  expect(await readFile(file, 'utf8')).toBe(before);
});
it.each([null, 'missing', 'closed', 'archived'])('refuses a caller without an open work/session: %s', async condition => {
  await updateMap(project, workId, map => {
    if (condition === 'closed') transitionSession(map, 's-01', 'closed');
    if (condition === 'archived') map.work.status = 'archived';
  });
  const client = await connect(condition === null || condition === 'missing' ? condition : 's-01');
  expect((await client.callTool({ name: 'publish_agent_plan', arguments: { steps } })).isError).toBe(true);
});
