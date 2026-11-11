import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addSession, transitionSession } from '../../work/map.js';
import { createWork, updateMap, workPaths } from '../../work/store.js';
import { createBrowserTools } from '../browser-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL } from '../session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from '../swarm-tools.js';
import { createParleyServer, createToolRunner } from '../tools.js';
import {
  CatalogError,
  type CatalogEntry,
  INITIAL_COHORT,
  buildCatalog,
  buildImplementationInventory,
  canonicalSha256,
  declarationsFor,
  effectOf,
  type InventoryInput,
  type NativePolicy,
} from './catalog.js';
import { MIGRATABLE_READS } from './migration-registry.js';
import { SHORT_PROFILE_HIDDEN_TOOLS } from '../../work/mcp-config.js';
import { READ_OUTPUT_SCHEMAS, adapterRevisionOf } from './read-output-schemas.js';

/** The commit the checked-in inventory was enumerated at. Changing any listed tool changes the inventory and fails the diff test below. */
const BASE_COMMIT = '3b53d78164f1f4c935b22a1bdfb2a2b487ad20e1';
const BENCHMARK_DIR = new URL('../../../../../docs/research/2026-11-07-code-mode-benchmark/', import.meta.url);
const INVENTORY_PATH = new URL('implementation-inventory.json', BENCHMARK_DIR).pathname;
const MANIFEST_PATH = new URL('baseline-manifest.json', BENCHMARK_DIR).pathname;

let root: string;
let previousHome: string | undefined;
let live: InventoryInput;
let fullAgent: Tool[];
let shortAgent: Tool[];
/** What a real server answers to `tools/list` for each launch variant, through the SDK client (not assembled by hand). */
let served: Record<'fullAgent' | 'shortAgent' | 'fullAgentNavigator' | 'shortAgentNavigator' | 'fullNoAgent' | 'shortNoAgent', Tool[]>;
const clients: Client[] = [];

/** The tools `createParleyServer` adds when the session has an agent channel and an id (tools.ts ListToolsRequestSchema handler). */
const SESSION_TOOLS: Tool[] = [CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, CREATE_SWARM_TOOL, SWARM_ADD_TOOL];

async function serve(context: Record<string, unknown>): Promise<Tool[]> {
  const server = createParleyServer(context as unknown as Parameters<typeof createParleyServer>[0]);
  const client = new Client({ name: 'inventory', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return (await client.listTools()).tools as Tool[];
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-code-mode-catalog-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  previousHome = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  const workId = (await createWork(project, { title: 'Catalog inventory' })).work.id;
  await updateMap(project, workId, (map) => {
    transitionSession(map, addSession(map, { provider: 'codex', label: 'codex', task: 'Enumerate the tool lists' }).id, 'active');
  });
  const base = { projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false };
  const core = await createToolRunner(base).list();
  const coreShort = await createToolRunner({ ...base, toolProfile: 'short' }).list();
  const withNavigator = await createToolRunner({ ...base, skillNavigator: true }).list();
  const navigator = withNavigator.filter((t) => !core.some((c) => c.name === t.name));
  const browser = createBrowserTools({ url: 'http://127.0.0.1:1', token: 'inventory' }, {}).tools;
  live = { baseCommit: BASE_COMMIT, core, coreShort, navigator, browser, session: SESSION_TOOLS };
  fullAgent = [...core, ...browser, ...SESSION_TOOLS];
  shortAgent = [...coreShort, ...browser, ...SESSION_TOOLS];
  const agent = { url: 'http://127.0.0.1:1', token: 'inventory' };
  served = {
    fullAgent: await serve({ ...base, agent }),
    shortAgent: await serve({ ...base, agent, toolProfile: 'short' }),
    fullAgentNavigator: await serve({ ...base, agent, skillNavigator: true }),
    shortAgentNavigator: await serve({ ...base, agent, toolProfile: 'short', skillNavigator: true }),
    fullNoAgent: await serve(base),
    shortNoAgent: await serve({ ...base, toolProfile: 'short' }),
  };
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  if (previousHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const without = (tools: readonly Tool[], ...names: string[]): Tool[] => tools.filter((t) => !names.includes(t.name));
const fake = (name: string, inputSchema: Record<string, unknown> = { type: 'object', properties: {} }, annotations: Tool['annotations'] = { readOnlyHint: true }): Tool => ({
  name,
  description: `${name} fixture`,
  inputSchema: inputSchema as Tool['inputSchema'],
  annotations,
});

type HistoricalPin = {
  baseCommit: string;
  lists: Record<string, { count: number; serializedSha256: string }>;
  tools: { name: string; source: string; schemaSha256: string; descriptorSha256: string; effect: string; signature: { status: string; reasons?: string[] } }[];
};

const readStored = (): Record<string, any> => JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What changed since the frozen r1 pin, computed from the live lists and the pin. */
function sincePin(pin: HistoricalPin, inv: ReturnType<typeof buildImplementationInventory>) {
  const before = new Map(pin.tools.map((t) => [t.name, t]));
  const now = new Map(inv.tools.map((t) => [t.name, t]));
  return {
    listCounts: Object.fromEntries(Object.keys(pin.lists).map((k) => [k, { from: pin.lists[k]!.count, to: inv.lists[k as keyof typeof inv.lists].count }])),
    added: inv.tools.filter((t) => !before.has(t.name)).map((t) => ({ name: t.name, source: t.source, effect: t.effect, disposition: 'direct', signature: t.signature.status, t11Task: `T11-${t.name}` })),
    removed: pin.tools.filter((t) => !now.has(t.name)).map((t) => t.name),
    schemaChanged: inv.tools.filter((t) => before.has(t.name) && before.get(t.name)!.schemaSha256 !== t.schemaSha256).map((t) => t.name),
    descriptorChanged: inv.tools.filter((t) => before.has(t.name) && before.get(t.name)!.descriptorSha256 !== t.descriptorSha256).map((t) => t.name),
    signatureChanged: inv.tools.filter((t) => before.has(t.name) && before.get(t.name)!.signature.status !== t.signature.status).map((t) => ({ name: t.name, from: before.get(t.name)!.signature.status, to: t.signature })),
  };
}

describe('implementation inventory', () => {
  it('equals the checked-in file: a new, removed or changed tool must be inventoried (UPDATE_CODE_MODE_INVENTORY=1 rewrites it, keeping the frozen historicalPin)', async () => {
    const pin = readStored()['historicalPin'] as HistoricalPin;
    const built = buildImplementationInventory(live);
    const actual = { ...built, historicalPin: pin, sincePin: sincePin(pin, built) };
    if (process.env.UPDATE_CODE_MODE_INVENTORY === '1') await writeFile(INVENTORY_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    expect(readStored()).toEqual(JSON.parse(JSON.stringify(actual)));
  });

  it('the frozen historical pin is still anchored to the immutable baseline manifest rows', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { schema: { rows: { name: string; toolCount: number; sha256: string }[] } };
    const row = (name: string): { toolCount: number; sha256: string } => manifest.schema.rows.find((r) => r.name === name)!;
    const pin = readStored()['historicalPin'] as HistoricalPin;
    expect(pin.baseCommit).toBe('c15017dba04162aa2bf174a9b7931013a45446ab');
    const pairs: [string, string][] = [
      ['fullNoAgent', 'full-runner'],
      ['shortNoAgent', 'short-runner'],
      ['fullAgent', 'full-server-agent'],
      ['shortAgent', 'short-server-agent'],
      ['fullAgentNavigator', 'full-server-agent-navigator-base'],
      ['shortAgentNavigator', 'short-server-agent-navigator-base'],
    ];
    for (const [ours, theirs] of pairs) {
      expect({ list: ours, count: pin.lists[ours]!.count, sha: pin.lists[ours]!.serializedSha256 }).toEqual({ list: ours, count: row(theirs).toolCount, sha: row(theirs).sha256 });
    }
    expect(pin.tools).toHaveLength(42);
    expect(new Set(pin.tools.map((t) => t.name)).size).toBe(42);
  });

  it('the hand-assembled launch lists equal what a real server answers to tools/list, for all six variants', () => {
    const inv = buildImplementationInventory(live);
    const digest = (tools: readonly Tool[]): string[] => tools.map((t) => `${t.name}:${canonicalSha256({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema, annotations: t.annotations ?? null })}`);
    const assembled = (names: readonly string[]): string[] => digest(names.map((n) => [...live.core, ...live.coreShort, ...live.navigator, ...live.browser, ...live.session].find((t) => t.name === n)!));
    for (const variant of ['fullAgent', 'shortAgent', 'fullAgentNavigator', 'shortAgentNavigator', 'fullNoAgent', 'shortNoAgent'] as const) {
      expect(digest(served[variant]), variant).toEqual(assembled(inv.lists[variant].names));
    }
  });

  it('what changed since the c15017db pin is exactly this set: five added methods, three schema changes, one signature change', () => {
    const pin = readStored()['historicalPin'] as HistoricalPin;
    const delta = sincePin(pin, buildImplementationInventory(live));
    expect(delta.removed).toEqual([]);
    expect(delta.added.map((a) => a.name).sort()).toEqual(['backlog_take', 'browser_close', 'create_swarm', 'get_capacity', 'plan_progress', 'plan_tasks', 'request_agent_switch', 'swarm_add']);
    expect(delta.added.every((a) => a.disposition === 'direct' && a.t11Task === `T11-${a.name}`)).toBe(true);
    expect(delta.schemaChanged.sort()).toEqual(['close_session', 'get_map', 'report']);
    expect(delta.descriptorChanged.sort()).toEqual(['close_session', 'get_map', 'report', 'wait_for']);
    expect(delta.signatureChanged).toEqual([{ name: 'report', from: 'available', to: { status: 'unavailable', reasons: ['report.inputSchema.properties.backlog: unsupported keyword "uniqueItems"'] } }]);
  });

  it('REPORTS (does not absorb) that the schema of an initial method changed: get_map is not the pinned one', () => {
    const pin = readStored()['historicalPin'] as HistoricalPin;
    const delta = sincePin(pin, buildImplementationInventory(live));
    const changedInitial = INITIAL_COHORT.filter((name) => delta.schemaChanged.includes(name));
    expect(changedInitial).toEqual(['get_map']);
  });

  it('FINDING, not absorbed: the get_map input schema of this base differs from the pinned one only by field values plus rev', () => {
    const schema = live.core.find((t) => t.name === 'get_map')!.inputSchema as { properties: Record<string, { enum?: string[] }>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties)).toEqual(['session', 'room', 'field', 'id', 'rev', 'kind', 'cursor', 'maxBytes']);
    expect(schema.properties['field']!.enum).toEqual([
      'goal', 'title', 'task', 'summary', 'history', 'artifacts', 'contextFrom', 'messages', 'message', 'summaries', 'archive', 'providers',
      'sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms', 'plan',
    ]);
    expect(schema.additionalProperties).toBe(false);
  });

  it('counts the launch variants from the actual source lists', () => {
    const { lists } = buildImplementationInventory(live);
    expect(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.count]))).toEqual({
      fullNoAgent: 30, shortNoAgent: 27, fullNoAgentNavigator: 31, shortNoAgentNavigator: 28,
      fullAgent: 49, shortAgent: 46, fullAgentNavigator: 50, shortAgentNavigator: 47,
    });
    const hidden = lists.fullAgent.names.filter((n) => !lists.shortAgent.names.includes(n)).sort();
    expect(hidden).toEqual(['memory_read', 'remember', 'search_history']);
  });

  it('keeps every method direct and unmigrated, with the five initial methods read-only and everything else outside the cohort', () => {
    const { tools } = buildImplementationInventory(live);
    expect(tools).toHaveLength(50);
    for (const t of tools) {
      expect(t.disposition, t.name).toBe('direct');
      expect(t.migration, t.name).toBe('disabled');
      expect(t.nativePolicy, t.name).toBe('unknown');
    }
    const initial = tools.filter((t) => t.cohort === 'initial');
    expect(initial.map((t) => t.name).sort()).toEqual([...INITIAL_COHORT].sort());
    for (const t of initial) expect(t.effect, t.name).toBe('read');
    for (const t of initial) expect(t.signature.status, t.name).toBe('available');
  });

  it('inventories browser_action and report with their original schema hashes and an unavailable signature, hiding nothing', () => {
    const { tools, lists } = buildImplementationInventory(live);
    for (const [name, source, reason] of [['browser_action', live.browser, 'modifiers.items: union-valued array items'], ['report', live.core, 'unsupported keyword "uniqueItems"']] as const) {
      const row = tools.find((t) => t.name === name)!;
      const original = source.find((t) => t.name === name)!;
      expect(row.schemaSha256, name).toBe(canonicalSha256(original.inputSchema));
      expect(row.disposition, name).toBe('direct');
      expect(row.signature, name).toMatchObject({ status: 'unavailable' });
      expect((row.signature as { reasons: string[] }).reasons.join(' | '), name).toContain(reason);
      expect(lists.fullAgent.names, name).toContain(name);
      expect(lists.shortAgent.names, name).toContain(name);
      expect(lists.fullNoAgent.names.includes(name), name).toBe(name === 'report');
    }
    expect(tools.filter((t) => t.signature.status === 'unavailable').map((t) => t.name).sort()).toEqual(['browser_action', 'report']);
  });

  it('marks browser and the session-level tools as agent-channel only and find_skill as navigator only', () => {
    const { tools } = buildImplementationInventory(live);
    expect(tools.filter((t) => t.requiresAgentChannel).map((t) => t.name).sort()).toEqual([
      ...live.browser.map((t) => t.name), 'create_session', 'create_swarm', 'request_agent_switch', 'swarm_add',
    ].sort());
    expect(tools.filter((t) => t.requiresAgentChannel)).toHaveLength(19);
    expect(tools.filter((t) => t.requiresNavigator).map((t) => t.name)).toEqual(['find_skill']);
  });

  it('refuses duplicate names across lists', () => {
    expect(() => buildImplementationInventory({ ...live, session: [...live.session, live.core[0]!] })).toThrow(CatalogError);
  });
});

describe('catalogue from the actual session list', () => {
  it('documents exactly the five initial methods and nothing else on the full list', () => {
    const catalog = buildCatalog(fullAgent);
    expect(catalog.entries).toHaveLength(49);
    expect(catalog.entries.filter((e) => e.documented).map((e) => e.name).sort()).toEqual([...MIGRATABLE_READS].sort());
    expect(catalog.absent).toEqual([]);
  });

  it('documents on the short profile exactly the allowlisted reads it still lists (the hidden memory tools are not among them) with a different revision', () => {
    const full = buildCatalog(fullAgent);
    const short = buildCatalog(shortAgent);
    const hidden: readonly string[] = SHORT_PROFILE_HIDDEN_TOOLS;
    expect(short.entries.filter((e) => e.documented).map((e) => e.name).sort()).toEqual(MIGRATABLE_READS.filter((name) => !hidden.includes(name)).sort());
    expect(short.entries).toHaveLength(46);
    expect(short.revision).not.toBe(full.revision);
  });

  it('what a real server lists documents exactly the allowlisted reads the session lists, on all four agent variants and on the no-agent ones', () => {
    for (const variant of ['fullAgent', 'shortAgent', 'fullAgentNavigator', 'shortAgentNavigator', 'fullNoAgent', 'shortNoAgent'] as const) {
      const catalog = buildCatalog(served[variant]);
      const documented = catalog.entries.filter((e) => e.documented);
      const listed = (name: string): boolean => served[variant].some((t) => t.name === name);
      expect(documented.map((e) => e.name).sort(), variant).toEqual(MIGRATABLE_READS.filter(listed).sort());
      for (const e of documented) expect([e.effect, e.signature.status, e.cohort, e.migration, e.nativePolicy, e.executable], `${variant} ${e.name}`).toEqual(['read', 'available', 'initial', 'disabled', 'unknown', false]);
      expect(catalog.absent, variant).toEqual(MIGRATABLE_READS.filter((name) => !listed(name)).sort());
      expect(catalog.entries.length, variant).toBe(served[variant].length);
    }
  });

  it('intersects with the session list: an allowlisted method the session lacks is absent, undocumented and has no declaration', () => {
    const catalog = buildCatalog(without(fullAgent, 'list_roles', 'backlog_list'));
    expect(catalog.absent).toEqual(['backlog_list', 'list_roles']);
    expect(catalog.entries.some((e) => e.name === 'list_roles')).toBe(false);
    expect(() => declarationsFor(catalog, ['list_roles'])).toThrow(/not in this session's tool list/);
    expect(catalog.entries.filter((e) => e.documented)).toHaveLength(MIGRATABLE_READS.length - 2);
  });

  it('is empty-handed for a launch with no initial methods, and never invents entries', () => {
    const catalog = buildCatalog([fake('some_other_tool')]);
    expect(catalog.absent).toEqual([...MIGRATABLE_READS].sort());
    expect(catalog.entries.map((e) => e.name)).toEqual(['some_other_tool']);
    expect(catalog.entries[0]!.documented).toBe(false);
  });

  it('owns an immutable snapshot derived from the source: equal to it, not aliased to it', () => {
    const catalog = buildCatalog(fullAgent);
    for (const tool of fullAgent) {
      const entry = catalog.entries.find((e) => e.name === tool.name)!;
      expect(entry.inputSchema).toEqual(tool.inputSchema);
      expect(entry.inputSchema).not.toBe(tool.inputSchema);
      expect(entry.schemaSha256).toBe(canonicalSha256(tool.inputSchema));
    }
  });

  it('keeps declarations and revision stable when the caller mutates the source schema after the build, and a rebuild is a new revision', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const tools = [fake('get_map', schema)];
    const catalog = buildCatalog(tools);
    const before = declarationsFor(catalog, ['get_map']);
    expect(before).toContain('x?: string');
    (schema.properties.x as { type: string }).type = 'number';
    expect(declarationsFor(catalog, ['get_map'])).toBe(before);
    expect(catalog.entries[0]!.schemaSha256).toBe(canonicalSha256({ type: 'object', properties: { x: { type: 'string' } } }));
    const rebuilt = buildCatalog(tools);
    expect(rebuilt.revision).not.toBe(catalog.revision);
    expect(declarationsFor(rebuilt, ['get_map'])).toContain('x?: number');
  });

  it('does not let the caller change the catalogue through what it returns', () => {
    const catalog = buildCatalog([fake('get_map', { type: 'object', properties: { x: { type: 'string' } } })]);
    const before = declarationsFor(catalog, ['get_map']);
    const entry = catalog.entries[0]!;
    const schema = entry.inputSchema as { properties: { x: { type: string } } };
    expect(() => { schema.properties.x.type = 'number'; }).toThrow(TypeError);
    expect(() => { (schema as Record<string, unknown>)['extra'] = 1; }).toThrow(TypeError);
    expect(() => { (entry as { migration: string }).migration = 'enabled'; }).toThrow(TypeError);
    expect(() => { (entry as { executable: boolean }).executable = true; }).toThrow(TypeError);
    expect(() => { (catalog.entries as CatalogEntry[]).push(entry); }).toThrow(TypeError);
    expect(() => { (catalog.absent as string[]).push('x'); }).toThrow(TypeError);
    expect(declarationsFor(catalog, ['get_map'])).toBe(before);
    expect(buildCatalog([fake('get_map', { type: 'object', properties: { x: { type: 'string' } } })]).revision).toBe(catalog.revision);
  });

  it('freezes the reasons of an unavailable signature too', () => {
    const catalog = buildCatalog([fake('get_map', { type: 'object', properties: { x: { $ref: '#' } } })]);
    const sig = catalog.entries[0]!.signature as { reasons: string[] };
    expect(() => { sig.reasons.push('ok'); }).toThrow(TypeError);
  });

  it('promises a decoded output for a documented method, bound to its schema and adapter; nothing for any other', () => {
    for (const e of buildCatalog(fullAgent).entries) {
      if (e.documented) expect(e.output, e.name).toEqual({ guarantee: 'decoded', schemaSha256: canonicalSha256(READ_OUTPUT_SCHEMAS[e.name]), adapterRevision: adapterRevisionOf(e.name) });
      else expect(e.output, e.name).toEqual({ guarantee: 'unknown' });
    }
    expect(buildCatalog(fullAgent).entries.filter((e) => e.output.guarantee === 'decoded').map((e) => e.name).sort()).toEqual([...MIGRATABLE_READS].sort());
  });

  it('treats an allowlisted name with an unsupported schema as undocumented, with the reason, and gives it no stub', () => {
    const bad = fake('get_map', { type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } });
    const catalog = buildCatalog([bad, fake('read_room')]);
    const entry = catalog.entries.find((e) => e.name === 'get_map')!;
    expect(entry.documented).toBe(false);
    expect(entry.signature).toEqual({ status: 'unavailable', reasons: ['get_map.inputSchema.properties.x: unsupported keyword "anyOf"', 'get_map.inputSchema.properties.x: needs "type", "oneOf", "enum" or "const"'] });
    expect(() => declarationsFor(catalog, ['get_map'])).toThrow(/signature unavailable: get_map\.inputSchema\.properties\.x: unsupported keyword "anyOf"/);
    expect(() => declarationsFor(catalog, ['get_map', 'read_room'])).toThrow(CatalogError);
    expect(declarationsFor(catalog, ['read_room'])).toContain('read_room: (input: ReadRoomInput) => Promise<ReadRoomOutput>');
  });

  it('keeps unsafe names out of the callable surface, whatever their effect', () => {
    const catalog = buildCatalog([fake('constructor'), fake('__proto__'), fake('Get-Map'), fake('get_map')]);
    const unsafe = catalog.entries.filter((e) => e.name !== 'get_map');
    expect(unsafe).toHaveLength(3);
    for (const e of unsafe) {
      expect(e.signature.status).toBe('unavailable');
      expect(e.documented).toBe(false);
      expect(e.executable).toBe(false);
    }
    expect(catalog.entries.find((e) => e.name === 'get_map')!.documented).toBe(true);
  });

  it('does not document an allowlisted name that is not read-only by its annotations', () => {
    const catalog = buildCatalog([fake('get_map', { type: 'object', properties: {} }, { readOnlyHint: false }), fake('read_room', { type: 'object', properties: {} }, {})]);
    expect(catalog.entries.map((e) => [e.name, e.effect, e.documented]).sort()).toEqual([['get_map', 'write', false], ['read_room', 'unknown', false]]);
    expect(() => declarationsFor(catalog, ['get_map'])).toThrow(/effect write/);
  });

  it('rejects duplicate names in the session list', () => {
    expect(() => buildCatalog([fake('get_map'), fake('get_map')])).toThrow(/duplicate tool name/);
  });

  it('maps annotations to effects', () => {
    expect(effectOf({ annotations: { readOnlyHint: true } })).toBe('read');
    expect(effectOf({ annotations: { readOnlyHint: false, destructiveHint: true } })).toBe('destructive');
    expect(effectOf({ annotations: { readOnlyHint: false, destructiveHint: false } })).toBe('write');
    expect(effectOf({})).toBe('unknown');
  });
});

describe('report stays inventoried and direct with an unavailable signature, like browser_action', () => {
  it('has the original schema, no declaration, no stub, and cannot be migrated or executed even with policy allow', () => {
    const catalog = buildCatalog(fullAgent, { nativePolicy: { report: 'allow' } });
    const entry = catalog.entries.find((e) => e.name === 'report')!;
    const original = fullAgent.find((t) => t.name === 'report')!;
    expect(entry.schemaSha256).toBe(canonicalSha256(original.inputSchema));
    expect(entry.signature).toEqual({ status: 'unavailable', reasons: ['report.inputSchema.properties.backlog: unsupported keyword "uniqueItems"'] });
    expect(entry).toMatchObject({ migration: 'disabled', documented: false, executable: false, cohort: 'residual', effect: 'write' });
    expect(() => declarationsFor(catalog, ['report'])).toThrow(CatalogError);
    expect(() => buildCatalog(fullAgent, { migrated: ['report'] })).toThrow(/report: migration refused/);
  });

  it('is present in every launch variant that has the core tools, so the lifecycle report path is never hidden', () => {
    const inv = buildImplementationInventory(live);
    for (const variant of ['fullNoAgent', 'shortNoAgent', 'fullAgent', 'shortAgent', 'fullAgentNavigator', 'shortAgentNavigator'] as const) expect(inv.lists[variant].names, variant).toContain('report');
  });
});

describe('browser_action stays inventoried but never gets a stub', () => {
  it('has an unavailable signature, direct (migration disabled), not documented, not executable, even with policy allow', () => {
    const catalog = buildCatalog(fullAgent, { nativePolicy: { browser_action: 'allow' } });
    const entry = catalog.entries.find((e) => e.name === 'browser_action')!;
    expect(entry.signature.status).toBe('unavailable');
    expect(entry).toMatchObject({ migration: 'disabled', documented: false, executable: false, cohort: 'residual', nativePolicy: 'allow' });
    expect(() => declarationsFor(catalog, ['browser_action'])).toThrow(/browser_action: no declaration \(signature unavailable: .*modifiers\.items: union-valued array items/);
  });

  it('refuses a request to migrate it, so no contradictory enabled state can exist', () => {
    expect(() => buildCatalog(fullAgent, { nativePolicy: { browser_action: 'allow' }, migrated: ['browser_action'] })).toThrow(/browser_action: migration refused \(signature unavailable: .*modifiers\.items/);
  });
});

describe('migration can only be requested for eligible methods', () => {
  const schemaWithEnumArray = { type: 'object', properties: { m: { type: 'array', items: { enum: ['A', 'B'] } } } };

  it('refuses an initial-cohort method whose schema is unsupported', () => {
    expect(() => buildCatalog([fake('get_map', schemaWithEnumArray)], { migrated: ['get_map'], nativePolicy: { get_map: 'allow' } })).toThrow(/get_map: migration refused \(signature unavailable/);
  });

  it('refuses a residual method, a non-read initial method and a name the session does not have', () => {
    expect(() => buildCatalog(fullAgent, { migrated: ['wait_for'] })).toThrow(/wait_for: migration refused \(not in the allowlist\)/);
    // `report` is outside the allowlist AND has an unsupported schema: the schema reason is the one reported
    expect(() => buildCatalog(fullAgent, { migrated: ['report'] })).toThrow(/report: migration refused \(signature unavailable: report\.inputSchema\.properties\.backlog: unsupported keyword "uniqueItems"/);
    expect(() => buildCatalog([fake('get_map', { type: 'object', properties: {} }, { readOnlyHint: false })], { migrated: ['get_map'] })).toThrow(/get_map: migration refused \(effect write\)/);
    expect(() => buildCatalog(without(fullAgent, 'list_roles'), { migrated: ['list_roles'] })).toThrow(/list_roles: migration refused \(not in this session's tool list\)/);
  });

  it('lists every refused request in one error, and builds nothing', () => {
    expect(() => buildCatalog(fullAgent, { migrated: ['report', 'get_map', 'browser_action'] })).toThrow(/report: migration refused[\s\S]*browser_action: migration refused/);
  });

  it('never reports an enabled migration on a method that is not documented, whatever the request or policy', () => {
    const catalog = buildCatalog(fullAgent, { migrated: [...INITIAL_COHORT], nativePolicy: Object.fromEntries(fullAgent.map((t) => [t.name, 'allow' as const])) });
    for (const e of catalog.entries) if (e.migration === 'enabled') expect(e.documented, e.name).toBe(true);
    expect(catalog.entries.filter((e) => e.migration === 'enabled').map((e) => e.name).sort()).toEqual([...INITIAL_COHORT].sort());
  });
});

describe('signature, migration and native policy are separate', () => {
  const policies: NativePolicy[] = ['unknown', 'ask', 'deny', 'allow'];

  it('native policy unknown keeps documented methods non-executable, even migrated', () => {
    const catalog = buildCatalog(fullAgent, { migrated: [...INITIAL_COHORT] });
    for (const name of INITIAL_COHORT) {
      const e = catalog.entries.find((x) => x.name === name)!;
      expect(e).toMatchObject({ documented: true, migration: 'enabled', nativePolicy: 'unknown', executable: false });
    }
  });

  it.each(policies)('with policy %s and migration disabled nothing is executable', (policy) => {
    const catalog = buildCatalog(fullAgent, { nativePolicy: Object.fromEntries(INITIAL_COHORT.map((n) => [n, policy])) });
    expect(catalog.entries.some((e) => e.executable)).toBe(false);
  });

  it.each(policies)('with policy %s and migration enabled only allow executes', (policy) => {
    const catalog = buildCatalog(fullAgent, { migrated: [...INITIAL_COHORT], nativePolicy: Object.fromEntries(INITIAL_COHORT.map((n) => [n, policy])) });
    expect(catalog.entries.filter((e) => e.executable).length).toBe(policy === 'allow' ? 5 : 0);
  });

  it('never executes or migrates a residual method, whatever policy it is told', () => {
    const everything = fullAgent.map((t) => t.name);
    const catalog = buildCatalog(fullAgent, { migrated: [...INITIAL_COHORT], nativePolicy: Object.fromEntries(everything.map((n) => [n, 'allow' as const])) });
    expect(catalog.entries.filter((e) => e.executable).map((e) => e.name).sort()).toEqual([...INITIAL_COHORT].sort());
    expect(catalog.entries.filter((e) => e.migration === 'enabled').map((e) => e.name).sort()).toEqual([...INITIAL_COHORT].sort());
  });

  it('treats policy as fixture metadata supplied by the caller: it never makes a method documented', () => {
    const catalog = buildCatalog(fullAgent, { nativePolicy: Object.fromEntries(fullAgent.map((t) => [t.name, 'allow' as const])) });
    expect(catalog.entries.filter((e) => e.documented).map((e) => e.name).sort()).toEqual([...MIGRATABLE_READS].sort());
    expect(catalog.entries.some((e) => e.executable)).toBe(false);
  });

  it('ignores prototype-shaped policy keys instead of reading inherited values', () => {
    const catalog = buildCatalog([fake('get_map')], { nativePolicy: JSON.parse('{"__proto__":"allow","toString":"allow"}') as Record<string, NativePolicy> });
    expect(catalog.entries[0]!.nativePolicy).toBe('unknown');
  });
});

describe('the allowlist (T11 B0)', () => {
  const everyAllow = (): Record<string, 'allow'> => Object.fromEntries(fullAgent.map((t) => [t.name, 'allow' as const]));
  /** A catalogue module whose contract table also decodes `get_capacity`: the shape a T11 read lands in. */
  const withSixth = async () => {
    vi.resetModules();
    vi.doMock('./read-output-schemas.js', async (load) => {
      const real = await load<typeof import('./read-output-schemas.js')>();
      return {
        ...real,
        READ_OUTPUT_SCHEMAS: { ...real.READ_OUTPUT_SCHEMAS, get_capacity: real.READ_OUTPUT_SCHEMAS['read_guide'] },
        adapterRevisionOf: (m: string) => (m === 'get_capacity' ? 'read-adapters/get-capacity.ts@fixture' : real.adapterRevisionOf(m)),
      };
    });
    return (await import('./catalog.js')).buildCatalog;
  };
  afterEach(() => { vi.doUnmock('./read-output-schemas.js'); vi.resetModules(); });

  it('the shipped allowlist is MIGRATABLE_READS, sorted, and the revision binds it', () => {
    const catalog = buildCatalog(fullAgent);
    expect(catalog.allowlist).toEqual([...MIGRATABLE_READS].sort());
    expect(buildCatalog(fullAgent, { allowlist: [...MIGRATABLE_READS] }).revision).toBe(catalog.revision);
    expect(buildCatalog(fullAgent, { allowlist: ['get_map'] }).revision).not.toBe(catalog.revision);
    expect(buildCatalog(fullAgent, { allowlist: ['get_map'] }).entries.filter((e) => e.documented).map((e) => e.name)).toEqual(['get_map']);
  });

  it('a sixth read on a fixture allowlist is documented and decoded, and executable only when enabled and allowed', async () => {
    const build = await withSixth();
    const allowlist = [...MIGRATABLE_READS, 'get_capacity'];
    const docs = build(fullAgent, { allowlist });
    const sixth = docs.entries.find((e) => e.name === 'get_capacity')!;
    expect([sixth.documented, sixth.cohort, sixth.migration, sixth.executable]).toEqual([true, 'initial', 'disabled', false]);
    expect(sixth.output).toMatchObject({ guarantee: 'decoded', adapterRevision: 'read-adapters/get-capacity.ts@fixture' });
    expect(build(fullAgent, { allowlist, nativePolicy: everyAllow() }).entries.find((e) => e.name === 'get_capacity')!.executable).toBe(false);
    for (const policy of ['deny', 'ask', 'unknown'] as const) {
      expect(build(fullAgent, { allowlist, migrated: ['get_capacity'], nativePolicy: { get_capacity: policy } }).entries.find((e) => e.name === 'get_capacity')!.executable, policy).toBe(false);
    }
    expect(build(fullAgent, { allowlist, migrated: ['get_capacity'], nativePolicy: everyAllow() }).entries.find((e) => e.name === 'get_capacity')!.executable).toBe(true);
    // The five keep their revision-relevant promises; the catalogue revision moves with the allowlist.
    expect(docs.revision).not.toBe(build(fullAgent, { allowlist: [...MIGRATABLE_READS] }).revision);
  });

  it('a sixth read with no output contract on the allowlist fails the build: documented never means undecoded', () => {
    expect(() => buildCatalog(fullAgent, { allowlist: [...MIGRATABLE_READS, 'get_capacity'] })).toThrow(/get_capacity: documented without an output contract/);
  });

  it('a write on a fixture allowlist is refused: never documented, no declaration, migration refused', () => {
    const catalog = buildCatalog(fullAgent, { allowlist: [...MIGRATABLE_READS, 'send_message'], nativePolicy: everyAllow() });
    const entry = catalog.entries.find((e) => e.name === 'send_message')!;
    expect([entry.effect, entry.cohort, entry.documented, entry.executable, entry.output]).toEqual(['write', 'initial', false, false, { guarantee: 'unknown' }]);
    expect(() => declarationsFor(catalog, ['send_message'])).toThrow(/send_message: no declaration \(effect write\)/);
    expect(() => buildCatalog(fullAgent, { allowlist: [...MIGRATABLE_READS, 'send_message'], migrated: ['send_message'] })).toThrow(/send_message: migration refused \(effect write\)/);
  });
});

describe('stable content-derived revision', () => {
  const rev = (tools: readonly Tool[], options = {}): string => buildCatalog(tools, options).revision;

  it('is deterministic and independent of list order and object key order', () => {
    expect(rev(fullAgent)).toBe(rev(fullAgent));
    expect(rev([...fullAgent].reverse())).toBe(rev(fullAgent));
    const reordered = fullAgent.map((t) => ({ annotations: t.annotations, inputSchema: t.inputSchema, description: t.description, name: t.name }) as Tool);
    expect(rev(reordered)).toBe(rev(fullAgent));
  });

  it('changes when a launch profile or the tool list changes', () => {
    const base = rev(fullAgent);
    expect(rev(shortAgent)).not.toBe(base);
    expect(rev(without(fullAgent, 'create_session'))).not.toBe(base);
    expect(rev([...fullAgent, fake('brand_new_tool')])).not.toBe(base);
  });

  it('changes when a description, a schema or an annotation changes, including inside the five', () => {
    const base = rev(fullAgent);
    const edit = (mutate: (t: Tool) => Tool): string => rev(fullAgent.map((t) => (t.name === 'get_map' ? mutate(t) : t)));
    expect(edit((t) => ({ ...t, description: `${t.description} (edited)` }))).not.toBe(base);
    expect(edit((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, extra: { type: 'string' } } } }))).not.toBe(base);
    expect(edit((t) => ({ ...t, annotations: { readOnlyHint: false } }))).not.toBe(base);
  });

  it('changes when the policy or migration inputs change, so docs never hide an executability change', () => {
    const base = rev(fullAgent);
    expect(rev(fullAgent, { nativePolicy: { get_map: 'allow' } })).not.toBe(base);
    expect(rev(fullAgent, { migrated: ['get_map'] })).not.toBe(base);
  });

  it('is a 64-hex SHA-256', () => {
    expect(rev(fullAgent)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the output contract in the catalogue revision', () => {
  afterEach(() => { vi.doUnmock('./read-output-schemas.js'); vi.resetModules(); });

  /** A fresh catalogue module over a changed contract table. */
  const buildWith = async (change: (real: typeof import('./read-output-schemas.js')) => Partial<typeof import('./read-output-schemas.js')>) => {
    vi.resetModules();
    vi.doMock('./read-output-schemas.js', async (load) => {
      const real = await load<typeof import('./read-output-schemas.js')>();
      return { ...real, ...change(real) };
    });
    return (await import('./catalog.js')).buildCatalog;
  };

  it('an adapter revision change moves the revision', async () => {
    const build = await buildWith(() => ({ adapterRevisionOf: () => 'read-adapters.ts@another' }));
    expect(build(fullAgent).revision).not.toBe(buildCatalog(fullAgent).revision);
    expect(build(fullAgent).entries.find((e) => e.name === 'get_map')!.output).toMatchObject({ adapterRevision: 'read-adapters.ts@another' });
  });

  it('an output schema change moves the revision', async () => {
    const build = await buildWith((real) => ({ READ_OUTPUT_SCHEMAS: { ...real.READ_OUTPUT_SCHEMAS, read_guide: { oneOf: [{ type: 'null' }, { type: 'string' }] } } }));
    expect(build(fullAgent).revision).not.toBe(buildCatalog(fullAgent).revision);
  });

  it('the table unchanged leaves the revision unchanged', async () => {
    const build = await buildWith(() => ({}));
    expect(build(fullAgent).revision).toBe(buildCatalog(fullAgent).revision);
  });

  it('a documented method with no adapter fails the build, never a decoded promise without one', async () => {
    const build = await buildWith(() => ({ adapterRevisionOf: () => undefined }));
    expect(() => build(fullAgent)).toThrow(/documented without an adapter/);
  });

  it('a documented method without an output contract cannot be built', async () => {
    const build = await buildWith((real) => {
      return { READ_OUTPUT_SCHEMAS: Object.fromEntries(Object.entries(real.READ_OUTPUT_SCHEMAS).filter(([name]) => name !== 'read_guide')) };
    });
    // The default allowlist follows the contract table, so the shipped allowlist is given explicitly.
    expect(() => build(fullAgent, { allowlist: [...MIGRATABLE_READS] })).toThrow(/read_guide: documented without an output contract/);
  });

  it('the checked-in implementation inventory carries no output contract', () => {
    expect(JSON.stringify(readStored())).not.toContain('adapterRevision');
  });
});

describe('declarations on demand', () => {
  it('generates the five initial methods through the guarded public generator, each with its declared output', () => {
    const text = declarationsFor(buildCatalog(fullAgent), [...INITIAL_COHORT]);
    for (const name of INITIAL_COHORT) {
      const type = name.split('_').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
      expect(text).toContain(`\t${name}: (input: ${type}Input) => Promise<${type}Output>;`);
      expect(text).not.toContain(`type ${type}Output = unknown`);
      expect(text).toMatch(new RegExp(`type ${type}Output = \\{\\s+ok: true;`));
    }
  });

  it('the generator cannot change the frozen output schema it was given a copy of', () => {
    const before = JSON.stringify(READ_OUTPUT_SCHEMAS);
    declarationsFor(buildCatalog(fullAgent), [...INITIAL_COHORT]);
    expect(JSON.stringify(READ_OUTPUT_SCHEMAS)).toBe(before);
  });

  it('refuses a residual method: no declaration outside the allowlist', () => {
    expect(() => declarationsFor(buildCatalog(fullAgent), ['wait_for'])).toThrow(/wait_for: no declaration \(not in the allowlist\)/);
    expect(() => declarationsFor(buildCatalog(fullAgent), ['report'])).toThrow(/report: no declaration \(signature unavailable: .*uniqueItems/);
  });

  it('refuses unknown names', () => {
    expect(() => declarationsFor(buildCatalog(fullAgent), ['nope'])).toThrow(/nope: not in this session's tool list/);
  });
});
