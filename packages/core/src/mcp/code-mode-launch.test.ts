// A replacement launch (plan T7b, T8h): the real entry point in a child process, the factory branch of the server, and what a classic start
// must not load. No live activation: nothing in the tree writes the decision file, and the live backend has no broker.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { type AgentHost, type Script, okEnvelope, startAgentHost } from '../../../../tests/fixtures/code-mode/agent-host.js';
import { MIGRATION_REGISTRY, type MigrationRegistry } from './code-mode/migration-registry.js';
import { readExposureRecord } from './code-mode/exposure-record.js';
import { type LaunchDecision, launchDecisionPath, newLaunchNonce, writeLaunchDecision } from './code-mode/launch-decision.js';
import { createCodeModeSurface, replacementSurfaceFactory } from './code-mode-tools.js';
import { CodeModeStartError, type McpContext, contextFromEnv } from './context.js';
import { TOOLS, createParleyServer, originalToolNames } from './tools.js';
import { PROVEN_PROVIDERS } from '../work/launch-exposure.js';

const coreDir = fileURLToPath(new URL('../../', import.meta.url));
const AGENT = { url: 'http://127.0.0.1:1/agent/browser', token: 't' };
const WRAPPERS = ['code_search', 'code_docs', 'code_execute'];

let root: string;
let project: string;
let workId: string;
let sessionId: string;
let workDir: string;
const was = process.env['PARLEY_HOME'];
const clients: Client[] = [];
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'parley-t7b-'));
  project = path.join(root, 'project');
  mkdirSync(project);
  process.env['PARLEY_HOME'] = path.join(root, 'home');
  workId = (await createWork(project, { title: 'T7b' })).work.id;
  await updateMap(project, workId, (map) => { const s = addSession(map, { provider: 'claude', label: 'lead', task: 'Check' }); transitionSession(map, s.id, 'active'); sessionId = s.id; });
  workDir = workPaths(project, workId).dir;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  if (was === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = was;
  try { chmodSync(path.join(workDir, 'code-mode'), 0o700); } catch { /* none */ }
  rmSync(root, { recursive: true, force: true });
});

const contextOf = (extra: Partial<McpContext> = {}): McpContext => ({ projectPath: project, workId, workDir, sessionId, channel: false, agent: AGENT, codeModeExposure: 'replacement', ...extra });
async function connect(context: McpContext, surface?: Parameters<typeof createParleyServer>[2]): Promise<Client> {
  const server = createParleyServer(context, undefined, surface);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}
const namesOf = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name);
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;
const VARIANTS: [string, Partial<McpContext>][] = [['full', {}], ['short', { toolProfile: 'short' }], ['full, navigator', { skillNavigator: true }], ['short, navigator', { toolProfile: 'short', skillNavigator: true }]];
const NO_AGENT_VARIANTS: [string, Partial<McpContext>][] = VARIANTS.map(([n, e]) => [`${n}, no agent`, { ...e, agent: undefined as never }]);
const withProven = (...proven: string[]): MigrationRegistry => ({ ...MIGRATION_REGISTRY, proven });

describe('the original list', () => {
  it.each([...VARIANTS, ...NO_AGENT_VARIANTS])('%s: local names are the runtime list, and all are in the registry', async (_n, extra) => {
    const { agent, ...rest } = { ...contextOf(extra) };
    const context: McpContext = { ...rest, ...(agent === undefined ? {} : { agent }) };
    delete (context as { codeModeExposure?: unknown }).codeModeExposure;
    const runtime = await namesOf(await connect(context));
    expect([...originalToolNames(context)].sort()).toEqual([...runtime].sort());
    const known = MIGRATION_REGISTRY.entries.map((e) => e.name);
    expect(runtime.filter((n) => !known.includes(n))).toEqual([]);
  });
});

describe('the factory branch of the third parameter (s-296 Q3)', () => {
  it('without one, nothing is built, and the list has no wrappers', async () => {
    const names = await namesOf(await connect(contextOf({ codeModeExposure: undefined as never })));
    for (const w of WRAPPERS) expect(names).not.toContain(w);
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
  });
  it('called once per server, synchronously, with a list that has no wrappers; a list request builds no backend', async () => {
    const backend = vi.fn(() => { throw new Error('the backend must not be built by a list'); });
    let listOriginal: (() => Promise<{ name: string }[]>) | undefined;
    const factory = vi.fn((list: () => Promise<{ name: string }[]>) => { listOriginal = list; return createCodeModeSurface({ backend }); });
    const server = createParleyServer(contextOf(), undefined, factory as never);
    expect(factory).toHaveBeenCalledTimes(1);
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    clients.push(client);
    const names = await namesOf(client);
    await namesOf(client);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(backend).not.toHaveBeenCalled();
    expect(names).toEqual(expect.arrayContaining(WRAPPERS));
    const original = (await listOriginal!()).map((t) => t.name);
    for (const w of WRAPPERS) expect(original).not.toContain(w);
    expect(names).toEqual([...original, ...WRAPPERS]);
  });
  it('the wrappers answer from that one surface, behind the same stale-agent fence', async () => {
    await updateMap(project, workId, (map) => { map.sessions[0]!.agentRevision = 'rev-new'; });
    const backend = vi.fn();
    const client = await connect(contextOf({ agentRevision: 'rev-old' }), () => createCodeModeSurface({ backend: backend as never }));
    const r = await client.callTool({ name: 'code_search', arguments: { query: 'map' } });
    expect(r.isError).toBe(true);
    expect(backend).not.toHaveBeenCalled();
  });
});

describe('the replacement surface over the real server', () => {
  it.each(VARIANTS)('%s: exactly the original list plus three, in order, since nothing is proven', async (_n, extra) => {
    const context = contextOf(extra);
    const names = await namesOf(await connect(context, replacementSurfaceFactory(context)));
    const classic = await namesOf(await connect({ ...context, codeModeExposure: undefined as never }));
    expect(names).toEqual([...classic, ...WRAPPERS]);
    expect(names).toHaveLength(classic.length + 3);
  });
  it('code_search and code_docs answer; code_execute is unavailable: the live backend has no broker', async () => {
    const context = contextOf();
    const client = await connect(context, replacementSurfaceFactory(context));
    expect(JSON.parse(textOf(await client.callTool({ name: 'code_search', arguments: { query: 'get_map' } })))).toMatchObject({ kind: 'search' });
    expect(JSON.parse(textOf(await client.callTool({ name: 'code_docs', arguments: { names: ['get_map'] } })))).toMatchObject({ kind: 'docs' });
    const r = await client.callTool({ name: 'code_execute', arguments: { code: 'return 1', apiRevision: `cm1.${'0'.repeat(64)}` } });
    expect(r.isError).toBe(true);
    // the agent view of a refusal before any run: the status, the completeness and the error; no run id, no operations
    const view = JSON.parse(textOf(r)) as Record<string, unknown>;
    expect(view).toMatchObject({ status: 'error', incomplete: true, error: { kind: 'unavailable' } });
    expect(Object.keys(view)).toEqual(['status', 'incomplete', 'error']);
  });
  it.each(VARIANTS)('%s, a fixture registry with the five proven: three wrappers plus the source list less five; the shipped registry cannot reach this', async (_n, extra) => {
    const context = contextOf(extra);
    const five = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
    const classic = await namesOf(await connect({ ...context, codeModeExposure: undefined as never }));
    const client = await connect(context, replacementSurfaceFactory(context, withProven(...five)));
    const names = await namesOf(client);
    expect(names).toEqual([...classic.filter((n) => !five.includes(n)), ...WRAPPERS]);
    const direct = names.length - 3;
    expect(direct).toBe(classic.length - 5);
    const r = await client.callTool({ name: 'get_map', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('unknown tool get_map');
    expect(textOf(await client.callTool({ name: 'no_such_tool', arguments: {} }))).toBe('unknown tool no_such_tool');
  });
  it('the numbers on this source: 44 and 41 direct, 45 and 42 with the navigator', async () => {
    const five = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
    const counts: number[] = [];
    for (const [, extra] of VARIANTS) { const context = contextOf(extra); counts.push((await namesOf(await connect(context, replacementSurfaceFactory(context, withProven(...five))))).length - 3); }
    expect(counts).toEqual([44, 41, 45, 42]);
  });
  it('a tool not in the registry: the list request fails with a fixed error, no tool is hidden, the record says failed, and the process is told to stop', async () => {
    const context = contextOf();
    const short: MigrationRegistry = { ...MIGRATION_REGISTRY, entries: MIGRATION_REGISTRY.entries.filter((e) => e.name !== 'report'), proven: [] };
    const stop = vi.fn();
    const client = await connect(context, replacementSurfaceFactory(context, short, stop));
    await expect(client.listTools()).rejects.toThrow('code mode replacement cannot start: uninventoried-tool');
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: 'uninventoried-tool', residual: [] } });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.calls[0]![0]).toBeInstanceOf(CodeModeStartError);
  });
  it('a list that passes tells nothing to stop', async () => {
    const context = contextOf();
    const stop = vi.fn();
    await namesOf(await connect(context, replacementSurfaceFactory(context, MIGRATION_REGISTRY, stop)));
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('the exposure record of a running launch', () => {
  it('written at the first list: what was exposed, names and hashes', async () => {
    const context = contextOf();
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
    const client = await connect(context, replacementSurfaceFactory(context));
    const names = await namesOf(client);
    const read = readExposureRecord(workDir, sessionId);
    expect(read).toMatchObject({ kind: 'record', record: { v: 1, effective: 'replacement', reason: null, migrated: [] } });
    if (read.kind !== 'record') throw new Error('no record');
    expect(read.record.residual).toEqual(names.filter((n) => !WRAPPERS.includes(n)));
    expect(read.record.residualSchemaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.record.launchId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('a write failure changes nothing about what is exposed', async () => {
    const context = contextOf();
    const healthy = await namesOf(await connect(context, replacementSurfaceFactory(context)));
    rmSync(path.join(workDir, 'code-mode'), { recursive: true, force: true });
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o500 });
    expect(await namesOf(await connect(context, replacementSurfaceFactory(context)))).toEqual(healthy);
  });
});

describe('the backend memo', () => {
  it('two first calls at once share one resolution', async () => {
    const context = contextOf();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = vi.fn(async () => { await gate; return (await import('./code-mode-tools.js')).liveBackend((await import('./code-mode/catalog.js')).buildCatalog(TOOLS), 'l'); });
    const surface = createCodeModeSurface({ backend: calls });
    const both = Promise.all([surface.call('code_search', { query: 'get_map' }), surface.call('code_search', { query: 'get_map' })]);
    release();
    await both;
    expect(calls).toHaveBeenCalledTimes(1);
    expect(context.codeModeExposure).toBe('replacement');
  });
  it('a rejected backend is final unless it is a BackendRetry (T12a §6.3: an unread list retries, code-mode-live.test.ts)', async () => {
    const backend = vi.fn(async () => { throw new Error('list failed'); });
    const surface = createCodeModeSurface({ backend });
    for (let i = 0; i < 3; i++) expect((await surface.call('code_search', { query: 'x' })).isError).toBe(true);
    expect(backend).toHaveBeenCalledTimes(1);
  });
});

describe('the environment (T8h)', () => {
  it.each(['replacement', 'nope', ''])('an exposure variable set to %j is not read: the context says nothing of Code Mode', (value) => {
    for (const name of ['PARLEY_CODE_MODE_EXPOSURE', 'HARNAS_CODE_MODE_EXPOSURE']) {
      const context = contextFromEnv({ PARLEY_WORK_DIR: '/p/.parley/works/w-1', [name]: value });
      expect(Object.keys(context)).not.toContain('codeModeExposure');
    }
  });
  it('no source file names the old variable, its parameter or its error any more', () => {
    for (const file of ['./context.ts', './server.ts', '../work/mcp-config.ts', '../providers.ts']) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'), file).not.toMatch(/CODE_MODE_EXPOSURE|unknown-exposure/);
    }
    expect(readFileSync(fileURLToPath(new URL('../work/mcp-config.ts', import.meta.url)), 'utf8')).not.toContain('codeModeExposure');
  });
});

describe('nothing activates it', () => {
  it('PROVEN is empty and frozen: no provider passes the gate, so a real launch writes classic and never a nonce (T12a; the behaviour is in launch-exposure.test.ts)', () => {
    expect(PROVEN_PROVIDERS).toEqual([]);
    expect(Object.isFrozen(PROVEN_PROVIDERS)).toBe(true);
  });
  it('the launcher writes the decision in one place only, through launchExposure (T12a)', () => {
    const text = readFileSync(fileURLToPath(new URL('../work/launch.ts', import.meta.url)), 'utf8');
    const start = text.indexOf('async function launchExposure(');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    for (const call of [/writeLaunchDecision\(/g, /newLaunchNonce\(/g]) {
      expect((body.match(call) ?? []).length, String(call)).toBeGreaterThan(0);
      expect((text.match(call) ?? []).length, String(call)).toBe((body.match(call) ?? []).length);
    }
    // The config's nonce has one source: what launchExposure returned.
    expect(text.match(/\bcodeModeLaunch\s*=(?!=)/g)).toEqual(['codeModeLaunch =']);
    expect(text).toContain('const codeModeLaunch = exposure.nonce;');
  });
  it('a classic start does not load Code Mode: the static import graph from server.js stops short of it (s-296 R1)', () => {
    execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir });
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\b[^'"\n;]*(?:\n[^'"\n;]*)*?from\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]/gm)) {
        walk(path.resolve(path.dirname(file), m[1] ?? m[2]!));
      }
    };
    walk(path.join(coreDir, 'dist/mcp/server.js'));
    expect(seen.size).toBeGreaterThan(20);
    const rel = [...seen].map((f) => path.relative(path.join(coreDir, 'dist'), f));
    expect(rel).toContain('mcp/tools.js');
    expect(rel.filter((f) => f === 'mcp/code-mode-tools.js' || f.startsWith('mcp/code-mode/'))).toEqual([]);
  }, 120_000);
});

// ----- The real entry point -----

describe('the real server entry, in a child process', () => {
  const hosts: AgentHost[] = [];
  const children: ChildProcess[] = [];
  beforeAll(() => { execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir }); }, 120_000);
  afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.close())); });
  afterAll(() => { for (const c of children) c.kill('SIGKILL'); });
  const entry = path.join(coreDir, 'dist/mcp/server.js');
  const envOf = (extra: Record<string, string>): Record<string, string> => ({ PATH: process.env['PATH']!, HOME: process.env['HOME']!, PARLEY_HOME: process.env['PARLEY_HOME']!, PARLEY_WORK_DIR: workDir, ...extra });
  const run = (extra: Record<string, string>): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: envOf(extra) });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  const hostFor = async (): Promise<AgentHost> => {
    // No such route: a remote runner hands everything to its local fallback, as after an update.
    const script: Script = () => ({ status: 404 });
    const h = await startAgentHost(script);
    hosts.push(h);
    return h;
  };
  const stdioClient = async (extra: Record<string, string>): Promise<Client> => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: envOf(extra) }));
    clients.push(client);
    return client;
  };

  /** What a launcher writes (T12a): a fresh nonce and the decision file. The env of a process of that launch is what `launched` returns. */
  const decide = (over: Partial<LaunchDecision> = {}): string => {
    const nonce = newLaunchNonce();
    expect(writeLaunchDecision(workDir, sessionId, { v: 1, nonce, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: new Date().toISOString(), ...over })).toBe(true);
    return nonce;
  };
  const channel = (h: AgentHost): Record<string, string> => ({ PARLEY_SESSION_ID: sessionId, PARLEY_AGENT_URL: `${h.agent.url}/agent/browser`, PARLEY_AGENT_TOKEN: h.agent.token });

  it.each(['nope', 'replacement', 'classic'])('an exposure variable %j with no nonce, as a repository could set it: stays up, the classic 49, no record (red on the T7b code)', async (value) => {
    const h = await hostFor();
    for (const name of ['PARLEY_CODE_MODE_EXPOSURE', 'HARNAS_CODE_MODE_EXPOSURE']) {
      const client = await stdioClient({ ...channel(h), [name]: value });
      const names = await namesOf(client);
      expect(names).toHaveLength(49);
      for (const w of WRAPPERS) expect(names).not.toContain(w);
    }
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
  }, 30_000);

  it('a valid nonce whose file says classic: the classic 49, no record, and an exposure variable that says otherwise changes nothing', async () => {
    const h = await hostFor();
    const nonce = decide({ effective: 'classic', reason: 'not-requested' });
    const client = await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: nonce, PARLEY_CODE_MODE_EXPOSURE: 'replacement' });
    expect(await namesOf(client)).toHaveLength(49);
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
  }, 30_000);

  it('a file that says replacement and an exposure variable that says nope: the file decides', async () => {
    const h = await hostFor();
    const nonce = decide();
    const client = await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: nonce, PARLEY_CODE_MODE_EXPOSURE: 'nope' });
    expect(await namesOf(client)).toHaveLength(52);
  }, 30_000);

  it.each(['alongside', 'on', 'Replacement'])('a valid nonce whose effective is %j: exit 1, a fixed line that does not repeat it, and the record says failed', async (value) => {
    const nonce = decide({ effective: value as never });
    const r = await run({ PARLEY_SESSION_ID: sessionId, PARLEY_CODE_MODE_LAUNCH: nonce });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('parley-mcp: code mode replacement cannot start: unknown-decision\n');
    expect(r.stderr).not.toContain(`: ${value}`);
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: 'unknown-decision', launchId: null, nonce } });
  }, 30_000);

  it('no agent channel: exit 1, and the record says failed', async () => {
    const nonce = decide();
    const r = await run({ PARLEY_SESSION_ID: sessionId, PARLEY_CODE_MODE_LAUNCH: nonce });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no-session-or-agent');
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: 'no-session-or-agent', nonce } });
  }, 30_000);

  it('no session: classic, no exit, and the file is not looked at', async () => {
    const h = await hostFor();
    const nonce = decide();
    const client = await stdioClient({ PARLEY_AGENT_URL: `${h.agent.url}/agent/browser`, PARLEY_AGENT_TOKEN: h.agent.token, PARLEY_CODE_MODE_LAUNCH: nonce });
    const names = await namesOf(client);
    for (const w of WRAPPERS) expect(names).not.toContain(w);
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
  }, 30_000);

  describe('a nonce that does not reach a valid decision: classic, no exit, no record', () => {
    const plain = async (h: AgentHost, nonce: string): Promise<void> => {
      const client = await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: nonce });
      expect(await namesOf(client)).toHaveLength(49);
      expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
    };
    it('no file at all', async () => { await plain(await hostFor(), newLaunchNonce()); }, 30_000);
    it('another launch wrote it', async () => { const h = await hostFor(); decide(); await plain(h, newLaunchNonce()); }, 30_000);
    it('a nonce of the wrong shape', async () => { const h = await hostFor(); decide(); await plain(h, 'replacement'); }, 30_000);
    it('torn', async () => { const h = await hostFor(); const n = decide(); writeFileSync(launchDecisionPath(workDir, sessionId), '{"v":1,"non', { mode: 0o600 }); await plain(h, n); }, 30_000);
    it('a symlink at the path', async () => {
      const h = await hostFor();
      const n = decide();
      const file = launchDecisionPath(workDir, sessionId);
      writeFileSync(path.join(root, 'elsewhere.json'), readFileSync(file));
      rmSync(file);
      symlinkSync(path.join(root, 'elsewhere.json'), file);
      await plain(h, n);
    }, 30_000);
    it('a FIFO at the path: no hang', async () => {
      const h = await hostFor();
      const n = decide();
      const file = launchDecisionPath(workDir, sessionId);
      rmSync(file);
      execFileSync('mkfifo', [file]);
      await plain(h, n);
    }, 30_000);
    it('an untrusted directory', async () => { const h = await hostFor(); const n = decide(); chmodSync(path.dirname(launchDecisionPath(workDir, sessionId)), 0o755); await plain(h, n); }, 30_000);
    it('another session\'s file: the same nonce under a different id', async () => {
      const h = await hostFor();
      const n = decide();
      renameSync(launchDecisionPath(workDir, sessionId), launchDecisionPath(workDir, 's-other'));
      await plain(h, n);
    }, 30_000);
  });

  describe('launches over time', () => {
    it('a stale config after a new classic launch: the old nonce no longer matches, classic', async () => {
      const h = await hostFor();
      const old = decide();
      expect(await namesOf(await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: old }))).toHaveLength(52);
      decide({ nonce: null, effective: 'classic', requested: false, reason: 'not-requested' });
      expect(await namesOf(await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: old }))).toHaveLength(49);
    }, 30_000);
    it('a respawn inside one launch keeps its exposure, twice: the nonce is not consumed', async () => {
      const h = await hostFor();
      const nonce = decide();
      for (let i = 0; i < 2; i++) expect(await namesOf(await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: nonce }))).toHaveLength(52);
    }, 30_000);
    it('a later launch replacing the file: the earlier env is classic, the new one replacement', async () => {
      const h = await hostFor();
      const one = decide();
      const two = decide();
      expect(await namesOf(await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: one }))).toHaveLength(49);
      expect(await namesOf(await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: two }))).toHaveLength(52);
    }, 30_000);
  });

  // This build's registry is complete, so these two load it changed: the only way the entry point can meet a tool it does not know.
  const withRegistryPatched = (from: string, to: string): string => {
    const preload = path.join(root, 'preload.mjs');
    writeFileSync(preload, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/code-mode/migration-registry.js')) return result;
  const source = String(result.source);
  if (!source.includes(\`${from}\`)) throw new Error('anchor');
  return { ...result, source: source.replace(\`${from}\`, \`${to}\`) };
} });
`);
    return preload;
  };
  const runWith = (preload: string, extra: Record<string, string>): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', preload, entry], { stdio: ['pipe', 'pipe', 'pipe'], env: envOf(extra) });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('exit', (code) => resolve({ code, stderr }));
  });

  it.each([
    ['a tool the registry does not know', "'report', ", '', 'uninventoried-tool'],
    ['an invalid registry', 'proven: Object.freeze([])', "proven: Object.freeze(['report'])", 'invalid-registry'],
  ])('%s: exit 1 at start, a fixed line, and the record says failed', async (_name, from, to, code) => {
    const h = await hostFor();
    const r = await runWith(withRegistryPatched(from, to), { ...channel(h), PARLEY_CODE_MODE_LAUNCH: decide() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`parley-mcp: code mode replacement cannot start: ${code}\n`);
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: code } });
    expect(h.log).toHaveLength(0);
  }, 30_000);

  it('a host whose list really differs: the client gets its answer, the record says failed, and the process exits 1', async () => {
    // The start check passes on the local list; the host then answers the list with a tool this build does not know.
    const script: Script = (q) => {
      const body = JSON.parse(q.raw) as { op: string };
      return body.op === 'list' ? { body: okEnvelope({ tools: [{ name: 'new_tool_from_a_newer_host', description: 'x', inputSchema: { type: 'object' } }] }) } : { status: 500 };
    };
    const h = await startAgentHost(script);
    hosts.push(h);
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: envOf({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: decide() }) });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)); });
    const send = (o: unknown): void => { child.stdin!.write(`${JSON.stringify(o)}\n`); };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await exited).toBe(1);
    const replies = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id?: number; error?: { message: string } });
    expect(replies.find((r) => r.id === 2)?.error?.message).toContain('code mode replacement cannot start: uninventoried-tool');
    expect(stderr).toContain('parley-mcp: code mode replacement cannot start: uninventoried-tool\n');
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: 'uninventoried-tool' } });
    expect(h.log.map((x) => JSON.parse(x.raw) as { op: string }).filter((b) => b.op === 'call')).toEqual([]);
  }, 30_000);

  it('replacement with a session and a channel: the original list plus three, the record, and zero tool calls at the host', async () => {
    const h = await hostFor();
    const nonce = decide();
    const client = await stdioClient({ ...channel(h), PARLEY_CODE_MODE_LAUNCH: nonce });
    const names = await namesOf(client);
    expect(names.slice(-3)).toEqual(WRAPPERS);
    expect(names).toHaveLength(49 + 3);
    const r = await client.callTool({ name: 'code_execute', arguments: { code: 'return await parley.get_map({})', apiRevision: `cm1.${'0'.repeat(64)}` } });
    const view = JSON.parse(textOf(r)) as Record<string, unknown>;
    expect(view).toMatchObject({ status: 'error', incomplete: true, error: { kind: 'unavailable' } });
    expect(Object.keys(view)).toEqual(['status', 'incomplete', 'error']);
    expect(h.log.map((x) => JSON.parse(x.raw) as { op: string }).filter((b) => b.op === 'call')).toEqual([]);
    expect(readExposureRecord(workDir, sessionId)).toMatchObject({ kind: 'record', record: { effective: 'replacement', nonce } });
  }, 30_000);

  it('absent: the classic 49, no wrappers, no record', async () => {
    const h = await hostFor();
    const client = await stdioClient({ PARLEY_SESSION_ID: sessionId, PARLEY_AGENT_URL: `${h.agent.url}/agent/browser`, PARLEY_AGENT_TOKEN: h.agent.token });
    const names = await namesOf(client);
    expect(names).toHaveLength(49);
    for (const w of WRAPPERS) expect(names).not.toContain(w);
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
    expect(existsSync(launchDecisionPath(workDir, sessionId))).toBe(false);
  }, 30_000);

  it('a classic start opens no decision file and loads no Code Mode: its FIFO would stall a reader that tried', async () => {
    const h = await hostFor();
    const file = launchDecisionPath(workDir, sessionId);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [file]);
    const preload = path.join(root, 'trace.mjs');
    const log = path.join(root, 'loaded.log');
    writeFileSync(preload, `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({ load(url, context, next) { if (url.includes('/code-mode')) appendFileSync(${JSON.stringify(log)}, url + '\\n'); return next(url, context); } });
`);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry], env: envOf(channel(h)) }));
    clients.push(client);
    expect(await namesOf(client)).toHaveLength(49);
    expect(existsSync(log)).toBe(false);
  }, 30_000);
});
