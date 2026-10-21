import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHORT_PROFILE_HIDDEN_TOOLS } from '../work/mcp-config.js';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { createParleyServer } from './tools.js';
import type { McpContext } from './context.js';

let root: string;
let project: string;
let workId: string;
let previous: string | undefined;
const clients: Client[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-tool-profile-'));
  project = path.join(root, 'project');
  await mkdir(project);
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  workId = (await createWork(project, { title: 'Tool profile' })).work.id;
  await updateMap(project, workId, (map) => {
    transitionSession(map, addSession(map, { provider: 'codex', label: 'codex', task: 'Check the profile' }).id, 'active');
  });
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(root, { recursive: true, force: true });
});

async function connect(extra: Partial<McpContext> = {}): Promise<Client> {
  const server = createParleyServer({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, ...extra });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}

async function toolNames(extra: Partial<McpContext> = {}): Promise<string[]> {
  return (await (await connect(extra)).listTools()).tools.map((tool) => tool.name);
}

async function guideText(extra: Partial<McpContext>, topic?: string): Promise<string> {
  const result = await (await connect(extra)).callTool({ name: 'read_guide', arguments: topic === undefined ? {} : { topic } });
  return (result.content as { text: string }[]).map((part) => part.text).join('');
}

describe('профиль short сервера parley', () => {
  it('прячет remember, memory_read и search_history; backlog_*, карта, отчёт и письма остаются', async () => {
    expect([...SHORT_PROFILE_HIDDEN_TOOLS]).toEqual(['remember', 'memory_read', 'search_history']);
    const names = await toolNames({ toolProfile: 'short' });
    for (const hidden of SHORT_PROFILE_HIDDEN_TOOLS) expect(names, hidden).not.toContain(hidden);
    for (const kept of ['backlog_list', 'backlog_suggest', 'get_map', 'report', 'send_message', 'check_inbox', 'wait_for', 'read_guide', 'publish_agent_plan']) {
      expect(names, kept).toContain(kept);
    }
  });

  it('без профиля объявлены все инструменты, и short отличается ровно этими тремя', async () => {
    const full = await toolNames();
    for (const name of SHORT_PROFILE_HIDDEN_TOOLS) expect(full, name).toContain(name);
    const short = await toolNames({ toolProfile: 'short' });
    expect(full.filter((name) => !short.includes(name)).sort()).toEqual([...SHORT_PROFILE_HIDDEN_TOOLS].sort());
    expect(short.filter((name) => !full.includes(name))).toEqual([]);
  });

  it('read_guide при short отдаёт гид без памяти — и целиком, и темой tools; без профиля — с памятью', async () => {
    for (const topic of [undefined, 'tools']) {
      const full = await guideText({}, topic);
      const short = await guideText({ toolProfile: 'short' }, topic);
      for (const name of SHORT_PROFILE_HIDDEN_TOOLS) {
        expect(full, `${topic} ${name}`).toContain(name);
        expect(short, `${topic} ${name}`).not.toContain(name);
      }
      expect(short).toContain('backlog_suggest');
    }
  });
});
