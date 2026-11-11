// read_guide routing (plan T8b), through a real server: a replacement launch gets the routing block in front of the raw guide, a classic launch
// gets today's answer byte for byte. The session MCP process decides from its own effective exposure and its own tool list.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guideRouting, replacementRouting } from '../work/code-mode-instructions.js';
import { READ_GUIDE_MAX_BYTES, contextBytes } from '../work/context-budget.js';
import { GUIDE_TOPICS, guide, guideTopic } from '../work/guide.js';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { MIGRATION_REGISTRY } from './code-mode/migration-registry.js';
import type { McpContext } from './context.js';
import { createParleyServer, originalToolNames, presentGuide } from './tools.js';

// One flag the oversize case flips: the real guide is 45 KB, under the 64 KiB cap, so the cap path needs a larger raw text.
const huge = vi.hoisted(() => ({ on: false }));
vi.mock('../work/guide.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../work/guide.js')>();
  return { ...real, guide: (options?: Parameters<typeof real.guide>[0]) => (huge.on ? 'x'.repeat(70_000) : real.guide(options)) };
});

const AGENT = { url: 'http://127.0.0.1:1/agent/browser', token: 't' };
let root: string;
let project: string;
let workId: string;
let sessionId: string;
let workDir: string;
const was = process.env['PARLEY_HOME'];
const clients: Client[] = [];

beforeEach(async () => {
  huge.on = false;
  root = mkdtempSync(path.join(tmpdir(), 'parley-t8b-'));
  project = path.join(root, 'project');
  mkdirSync(project);
  process.env['PARLEY_HOME'] = path.join(root, 'home');
  workId = (await createWork(project, { title: 'T8b' })).work.id;
  await updateMap(project, workId, (map) => {
    const s = addSession(map, { provider: 'claude', label: 'lead', task: 'Check' });
    transitionSession(map, s.id, 'active');
    sessionId = s.id;
  });
  workDir = workPaths(project, workId).dir;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  if (was === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = was;
  rmSync(root, { recursive: true, force: true });
});

const contextOf = (extra: Partial<McpContext> = {}): McpContext => ({ projectPath: project, workId, workDir, sessionId, channel: false, agent: AGENT, ...extra });
async function connect(context: McpContext): Promise<Client> {
  const server = createParleyServer(context);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}
const ask = async (context: McpContext, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const r = (await (await connect(context)).callTool({ name: 'read_guide', arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
};
const REPLACEMENT = { codeModeExposure: 'replacement' as const, codeModeLaunch: 'n'.repeat(32) };
const optionsOf = (c: McpContext) => ({ ...(c.skillNavigator === true ? { skillNavigator: true } : {}), ...(c.toolProfile === 'short' ? { toolProfile: 'short' as const } : {}) });
const rawOf = (c: McpContext, topic: string | null): string => (topic === null ? guide(optionsOf(c)) : guideTopic(topic, optionsOf(c))!);
const TOPICS: (string | null)[] = [null, ...GUIDE_TOPICS.map((t) => t.topic)];
const LAUNCHES: [string, Partial<McpContext>][] = [
  ['full agent', {}],
  ['short agent', { toolProfile: 'short' }],
  ['full agent, navigator', { skillNavigator: true }],
  ['short agent, navigator', { toolProfile: 'short', skillNavigator: true }],
  ['no agent channel', { agent: undefined as never }],
];
const ctx = (extra: Partial<McpContext>): McpContext => {
  const { agent, ...rest } = contextOf(extra);
  return { ...rest, ...(agent === undefined ? {} : { agent }) };
};

describe('a classic launch is answered exactly as before', () => {
  it.each(LAUNCHES)('%s: whole guide and every topic equal the raw text byte for byte, with no block', async (_n, extra) => {
    const context = ctx(extra);
    for (const topic of TOPICS) {
      const answer = await ask(context, topic === null ? {} : { topic });
      expect(answer.isError).toBe(false);
      expect(answer.text, String(topic)).toBe(rawOf(context, topic));
      expect(answer.text).not.toContain('Routing for the operations');
    }
  });

  it('an empty topic is the whole guide and the topic is trimmed and lower-cased, as before', async () => {
    const context = ctx({});
    expect((await ask(context, { topic: '' })).text).toBe(guide(optionsOf(context)));
    expect((await ask(context, { topic: '  Rooms ' })).text).toBe(guideTopic('rooms', optionsOf(context)));
  });
});

describe('a replacement launch gets the routing block first, then the raw guide', () => {
  it.each(LAUNCHES)('%s: block + blank line + raw text, for the whole guide and every topic', async (_n, extra) => {
    const context = ctx({ ...extra, ...REPLACEMENT });
    const routing = replacementRouting(MIGRATION_REGISTRY);
    for (const topic of TOPICS) {
      const answer = await ask(context, topic === null ? {} : { topic });
      const block = guideRouting(routing, originalToolNames(context), topic, optionsOf(context));
      expect(block.length).toBeGreaterThan(0);
      expect(answer.text, String(topic)).toBe(`${block}\n\n${rawOf(context, topic)}`);
      expect(contextBytes(answer.text)).toBeLessThanOrEqual(READ_GUIDE_MAX_BYTES);
    }
  });

  it('the shipped registry migrates nothing, so the block says so and routes no name through code_execute', async () => {
    const { text } = await ask(ctx(REPLACEMENT), { topic: 'member' });
    expect(text.startsWith('Routing for the operations this guide names, in THIS launch:\n- nothing is migrated: call every operation as a tool of the parley server.\n- tools of the parley server: ')).toBe(true);
    expect(text).not.toContain('parley.<name>');
  });

  it('the block follows the tool list the server really has: an agent launch lists create_session, one without a channel does not', async () => {
    const withAgent = (await ask(ctx(REPLACEMENT), { topic: 'stuck' })).text;
    expect(withAgent).toMatch(/- tools of the parley server: [^\n]*create_session[^\n]*request_agent_switch/);
    expect(withAgent).not.toContain('unavailable in this launch');
    const noAgent = (await ask(ctx({ ...REPLACEMENT, agent: undefined as never }), { topic: 'stuck' })).text;
    expect(noAgent).toContain('- unavailable in this launch: create_session, request_agent_switch (say so; never guess a call).');
    expect(noAgent).not.toMatch(/- tools of the parley server: [^\n]*create_session/);
  });

  it('the short profile does not mention the memory tools, so the block does not label them', async () => {
    const short = (await ask(ctx({ ...REPLACEMENT, toolProfile: 'short' }), { topic: 'tools' })).text;
    expect(short.slice(0, short.indexOf('\n\n'))).not.toMatch(/remember|memory_read|search_history/);
    const full = (await ask(ctx(REPLACEMENT), { topic: 'tools' })).text;
    expect(full.slice(0, full.indexOf('\n\n'))).toMatch(/remember/);
  });

  it('a session-less server stays classic: replacement cannot start there, so no routing block is added', async () => {
    const context = ctx({ ...REPLACEMENT, sessionId: null });
    for (const topic of [null, 'rooms']) expect((await ask(context, topic === null ? {} : { topic })).text).toBe(rawOf(context, topic));
  });

  it('the terminal operations are stated once as top-level calls', async () => {
    const { text } = await ask(ctx(REPLACEMENT));
    const block = text.slice(0, text.indexOf('\n\n'));
    expect(block.match(/always top-level tool calls, never inside code_execute/g)).toHaveLength(1);
  });
});

describe('errors and the size cap', () => {
  it.each([['classic', {}], ['replacement', REPLACEMENT]] as const)('%s: an unknown or non-string topic is the same error as before and carries no block', async (_n, extra) => {
    const context = ctx(extra);
    const unknown = await ask(context, { topic: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('unknown guide topic "nope"; topics: ');
    expect(unknown.text).not.toContain('Routing for the operations');
    const bad = await ask(context, { topic: 5 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('argument topic: expected a string');
    expect(bad.text).not.toContain('Routing for the operations');
  });

  it('read_guide has no cursor or other argument: the schema offers only the topic', async () => {
    const tools = (await (await connect(ctx(REPLACEMENT))).listTools()).tools;
    const schema = tools.find((t) => t.name === 'read_guide')!.inputSchema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties)).toEqual(['topic']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('a raw guide over the cap: classic gets the old fallback, replacement gets the block and the fallback, and the total stays within the cap', async () => {
    huge.on = true;
    const classic = await ask(ctx({}));
    expect(classic.text).toBe(`The whole guide is 70000 bytes, over the ${READ_GUIDE_MAX_BYTES}-byte limit for one answer. Ask for one section with the topic argument; topics: ${GUIDE_TOPICS.map((t) => t.topic).join(', ')}.\n`);
    const context = ctx(REPLACEMENT);
    const replaced = await ask(context);
    const block = guideRouting(replacementRouting(MIGRATION_REGISTRY), originalToolNames(context), null, optionsOf(context));
    expect(replaced.text.startsWith(`${block}\n\n`)).toBe(true);
    expect(replaced.text).toContain('The whole guide is 70000 bytes, over the ');
    expect(contextBytes(replaced.text)).toBeLessThanOrEqual(READ_GUIDE_MAX_BYTES);
  });

  it('a raw text just under the cap alone but over it with the block gets the fallback, not a cut answer', () => {
    const block = guideRouting(replacementRouting(MIGRATION_REGISTRY), ['get_map'], 'overview');
    const raw = 'y'.repeat(READ_GUIDE_MAX_BYTES - 10);
    const out = presentGuide(raw, 'The guide topic overview', block);
    expect(out.startsWith(`${block}\n\n`)).toBe(true);
    expect(out).toContain('over the ');
    expect(contextBytes(out)).toBeLessThanOrEqual(READ_GUIDE_MAX_BYTES);
    // without a block (classic) the same raw text still fits as it always did
    expect(presentGuide(raw, 'The guide topic overview', '')).toBe(raw);
  });

  it('a raw text that exactly fills what the block leaves fits and the total is exactly the cap; one byte more gets the fallback', () => {
    const block = guideRouting(replacementRouting(MIGRATION_REGISTRY), ['get_map', 'report'], 'overview');
    const room = READ_GUIDE_MAX_BYTES - contextBytes(block) - 4;
    const fits = presentGuide('y'.repeat(room), 'The guide topic overview', block);
    expect(fits).toBe(`${block}\n\n${'y'.repeat(room)}`);
    expect(contextBytes(fits)).toBe(READ_GUIDE_MAX_BYTES);
    const over = presentGuide('y'.repeat(room + 1), 'The guide topic overview', block);
    expect(over.startsWith(`${block}\n\n`)).toBe(true);
    expect(over).toContain('over the ');
    expect(contextBytes(over)).toBeLessThan(READ_GUIDE_MAX_BYTES);
  });
});
