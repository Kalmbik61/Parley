/**
 * Code Mode fixture broker (plan T5b3) against the REAL `/agent/tools` endpoint and the real tool authority path: a
 * temporary synthetic work (`createWork`, sessions s-01/s-02, one room) and the real token registry
 * (`createBrowserEndpoint`). Nothing here touches a live work or token. The broker runs from @parley/core's dist under
 * the real sandboxed helper; the root fixture policy source is pointed at that dist native-policy module so its minted
 * source is the broker's. Each test loads fresh dist modules, so a run that keeps the process lease (U2) never makes a
 * later test busy. Test-only: no host production code is changed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { type ClientRequest, createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_TOOLS_PATH, HUMAN, addRoom, addSession, createRemoteToolRunner, createWork, readStoredMap, updateMap, type ProviderRow, type ToolLaunch } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrokerModule from '../../../core/src/mcp/code-mode/broker.js';
import type * as CatalogModule from '../../../core/src/mcp/code-mode/catalog.js';
import type * as ContractsModule from '../../../core/src/mcp/code-mode/contracts.js';
import type * as RemoteToolsModule from '../../../core/src/mcp/remote-tools.js';
import type * as FixtureModule from '../../../../tests/fixtures/code-mode/native-policy.js';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { hostToolContext, mapChangeSignal } from './tool-context.js';
import { createToolsEndpoint } from './tools-endpoint.js';

const coreDir = fileURLToPath(new URL('../../../core/', import.meta.url));
const distUrl = (rel: string): string => pathToFileURL(path.join(coreDir, 'dist', rel)).href;
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec') && existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));
if (!supported) console.warn('code-mode-broker.test: NOT RUN — needs darwin/arm64 sandbox-exec and the built product probe');

beforeAll(() => {
  if (supported) execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir });
}, 120_000);

let home = '';
let project = '';
let workId = '';
let roomOther = '';
let roomOwn = '';
const servers: Server[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-cm-broker-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-cm-broker-project-'));
  process.env['PARLEY_HOME'] = home;
  workId = (await createWork(project, { title: 'Code Mode broker fixture' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'one', task: 'first' });
    addSession(map, { provider: 'claude', label: 'two', task: 'second' });
    roomOther = addRoom(map, { creator: HUMAN, title: 'Not ours', lead: 's-02', members: ['s-02'] }).id;
    roomOwn = addRoom(map, { creator: HUMAN, title: 'Ours', lead: 's-01', members: ['s-01', 's-02'] }).id;
  });
});

const holdRoots: string[] = [];
/** Each broker's run record lives in a fresh directory unless a test shares one. */
const HOLD = () => { const workDir = mkdtempSync(path.join(tmpdir(), 'parley-t7a-hold-')); holdRoots.push(workDir); return { workDir, sessionId: 's-1' }; };
afterAll(() => { for (const d of holdRoots) rmSync(d, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The real endpoint for session s-01, with a request log (raw bodies) and the peak of concurrent requests. */
async function bootHost(onCallDone?: (n: number, revoke: () => void) => void, holdMs = 0, rows: () => Promise<ProviderRow[]> = async () => [], restart?: { port: number; keep?: { registry: ReturnType<typeof createBrowserEndpoint>; token: string } }) {
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registry = restart?.keep?.registry ?? createBrowserEndpoint({ log: silent, clients: () => [], roomsOf: () => [] });
  const ref: SessionRef = { projectPath: project, workId, sessionId: 's-01' };
  const token = restart?.keep?.token ?? registry.register(ref);
  const providerRows = vi.fn(rows);
  const works = { onChange: () => () => {}, onMail: () => () => {} };
  // Each new tool slot of the session builds one context: the count shows whether two launches shared a slot.
  let contexts = 0;
  const endpoint = createToolsEndpoint({
    authenticate: (req) => registry.authenticate(req),
    contextFor: async (target: SessionRef, launch: ToolLaunch) => { contexts++; return hostToolContext(target, launch, { providerRows, onWorksChange: mapChangeSignal(works as never) }); },
    log: silent,
  });
  const log: { raw: string; status: number }[] = [];
  let callsDone = 0;
  let active = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let isCall = false;
    req.on('data', (c: Buffer) => chunks.push(c));
    // Count tool calls in flight at the host (from the full request to the response), holding each answer `holdMs`.
    req.on('end', () => { isCall = Buffer.concat(chunks).toString('utf8').startsWith('{"op":"call"'); if (isCall) { active++; peak = Math.max(peak, active); } });
    if (holdMs > 0) {
      const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
      res.end = ((...a: unknown[]) => { setTimeout(() => end(...a), holdMs); return res; }) as typeof res.end;
    }
    res.on('close', () => {
      if (isCall) active--;
      const raw = Buffer.concat(chunks).toString('utf8');
      log.push({ raw, status: res.statusCode });
      if (onCallDone !== undefined && raw.startsWith('{"op":"call"')) onCallDone(++callsDone, () => registry.unregister(ref));
    });
    endpoint.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(restart?.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const agent = { url: `http://127.0.0.1:${port}/agent/browser`, token };
  const stop = (): Promise<void> => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); };
  return { registry, ref, token, agent, port, stop, log, peak: () => peak, contexts: () => contexts, calls: () => log.map((l) => JSON.parse(l.raw) as Record<string, unknown>).filter((b) => b['op'] === 'call') };
}

/** Fresh dist modules, with the root fixture's native-policy import pointed at the same dist instance. */
async function fresh() {
  vi.resetModules();
  const NP = (await import(distUrl('mcp/code-mode/native-policy.js'))) as Record<string, unknown>;
  vi.doMock('../../../core/src/mcp/code-mode/native-policy.js', () => NP);
  const B = (await import(distUrl('mcp/code-mode/broker.js'))) as typeof BrokerModule;
  const F = (await import('../../../../tests/fixtures/code-mode/native-policy.js')) as typeof FixtureModule;
  const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
  const T = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof CatalogModule.buildCatalog>[0] };
  return { B, F, catalog: C.buildCatalog(T.TOOLS) };
}

async function setup(meta?: Record<string, unknown>, onCallDone?: (n: number, revoke: () => void) => void, holdMs = 0, launch: ToolLaunch = { toolProfile: 'short' }) {
  const host = await bootHost(onCallDone, holdMs);
  const { B, F, catalog } = await fresh();
  const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
  const broker = B.createBroker({ hold: HOLD(), source: fake.source, catalog, launchId: 'launch-1', agent: host.agent, launch, ...(meta === undefined ? {} : { meta }) });
  const run = (code: string, limits?: Record<string, number>, signal?: AbortSignal) => broker.run(code, broker.launch.apiRevision, signal, limits);
  return { ...host, broker, launch, run, catalog };
}

const T = 60_000;

describe.skipIf(!supported)('T5b3 broker through the real /agent/tools endpoint and tool authority', () => {
  it('room authority is the original one: a room the session is not in is a failed receipt with the host error as data; its own room reads', async () => {
    const { run, calls } = await setup();
    const denied = await run(`return await parley.read_room({ room: ${JSON.stringify(roomOther)} })`);
    expect(denied).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 1 });
    expect(denied.ledger!.entries[0]).toMatchObject({ state: 'failed', deliveryFailure: null });
    const value = JSON.parse(denied.outcome!.value as string) as { ok: false; error: { kind: string; result: { isError: boolean; content: { text: string }[] } } };
    expect(value).toMatchObject({ ok: false, error: { kind: 'tool-error', result: { isError: true } } });
    expect(value.error.result.content[0]!.text).toContain(`room ${roomOther} is not available to this session`);
    const own = await run(`const r = await parley.read_room({ room: ${JSON.stringify(roomOwn)} }); return r.ok ? "ok" : "error";`);
    expect(own).toMatchObject({ runStatus: 'completed', outcome: { value: '"ok"' } });
    expect(own.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
    expect(calls().map((b) => b['name'])).toEqual(['read_room', 'read_room']);
  }, T);

  it('identity comes from the session token: get_map answers for s-01; a token revoked mid-run makes the next call unknown (401), U2', async () => {
    // The token is revoked by the host right after it answered the second call (the first of the second run).
    const { run, log } = await setup(undefined, (n, revoke) => { if (n === 2) revoke(); });
    const ok = await run('const m = await parley.get_map({}); return m.ok ? "ok" : "error";');
    expect(ok).toMatchObject({ runStatus: 'completed', outcome: { value: '"ok"' } });
    const body = JSON.parse(log.find((l) => JSON.parse(l.raw)['op'] === 'call')!.raw) as { args: unknown };
    expect(body.args).toEqual({});
    // One run, two sequential calls: the first settles, then the token is revoked, and the endpoint refuses the second (401).
    const r = await run('const a = await parley.get_map({}); try { await parley.get_map({}); return "second ok"; } catch (e) { return e.message; }');
    expect(r.ledger!.entries.map((e) => e.state)).toEqual(['succeeded', 'unknown']);
    expect(r.audit.at(-1)).toMatchObject({ ordinal: 2, outcome: 'unknown', why: '401' });
    expect(log.at(-1)!.status).toBe(401);
  }, T);

  it('the request bodies equal the classic runner bodies for the same call (name, args, launch, meta), callId aside', async () => {
    const meta = { threadId: 'thread-1' };
    const { run, agent, launch, calls } = await setup(meta);
    await run(`return await parley.read_room({ room: ${JSON.stringify(roomOwn)}, limit: 2 })`);
    await createRemoteToolRunner(agent, launch).call('read_room', { room: roomOwn, limit: 2 }, meta);
    const [broker, classic] = calls();
    const strip = (b: Record<string, unknown> | undefined) => { const { callId, ...rest } = b ?? {}; expect(typeof callId).toBe('string'); return rest; };
    expect(strip(broker)).toEqual(strip(classic));
    expect(strip(broker)).toEqual({ op: 'call', launch: { toolProfile: 'short' }, name: 'read_room', args: { room: roomOwn, limit: 2 }, meta });
  }, T);

  it('the default call budget through the real endpoint: 33 sequential reads send exactly 32, the 33rd is refused', async () => {
    const { run, calls } = await setup();
    const r = await run('const out = []; for (let i = 0; i < 33; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push("refused"); } } return out.filter((x) => x === "ok").length;');
    expect(calls()).toHaveLength(32);
    expect(r.ledger!.dispatched).toBe(32);
    expect(r.ledger!.entries.slice(0, 32).every((e) => e.state === 'succeeded')).toBe(true);
    expect(r.outcome).toMatchObject({ value: '32' });
  }, T);

  it('the strict boundaries hold before any host request: at most 2 in flight, the call budget, schema-invalid arguments', async () => {
    // Each answer is held 300 ms at the host, so four concurrent guest calls overlap there as far as the parent allows.
    const { run, calls, peak } = await setup(undefined, undefined, 300);
    const many = await run('return (await Promise.all([1, 2, 3, 4].map(() => parley.get_map({})))).length');
    expect(many).toMatchObject({ runStatus: 'completed', outcome: { value: '4' } });
    expect(peak()).toBe(2);
    expect(calls()).toHaveLength(4);
    const budget = await run('const out = []; for (let i = 0; i < 4; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push("refused"); } } return out;', { maxRpcs: 3 });
    expect(calls()).toHaveLength(7);
    expect(budget.ledger!.dispatched).toBe(3);
    const invalid = await run('try { await parley.read_room({ room: 7 }); return "sent"; } catch (e) { return e.message; }');
    expect(invalid).toMatchObject({ outcome: { value: '"parley: call refused"' } });
    expect(calls()).toHaveLength(7);
  }, T);
});

describe.skipIf(!supported)('T5b-agentRevision: a switched session through the real /agent/tools endpoint and the real agent fence', () => {
  const STALE = 'This session now continues with another agent';
  const switched: ToolLaunch = { agentRevision: 'rev-new', toolProfile: 'short' };
  const setRevision = (revision: string): Promise<unknown> => updateMap(project, workId, (map) => { map.sessions.find((s) => s.id === 's-01')!.agentRevision = revision; });
  const textsOf = (text: string) => readStoredMap(project, workId).messages.filter((m) => m.text === text);
  const post = async (agent: { url: string; token: string }, body: unknown) => {
    const res = await fetch(new URL(AGENT_TOOLS_PATH, agent.url), { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  /** The dist remote-only caller, the one the broker builds, sending one call of any method. */
  const callOnce = async (agent: { url: string; token: string }, launch: ToolLaunch, name: string, args: Record<string, unknown>) => {
    const R = (await import(distUrl('mcp/remote-tools.js'))) as typeof RemoteToolsModule;
    const caller = R.createRemoteOnlyCaller(agent, launch);
    const prepared = caller.prepare(name, args, undefined);
    if (!('body' in prepared)) throw new Error('refused');
    return caller.send(prepared, { signal: new AbortController().signal, remainingRaw: () => 1024 * 1024, beforeRetry: () => true, retryBudgetMs: 5000 });
  };

  it('a broker is built for a switched session and reads, with the same launch bytes and the same tool slot as the classic runner', async () => {
    await setRevision('rev-new');
    const { run, agent, calls, log, contexts } = await setup(undefined, undefined, 0, switched);
    const r = await run(`return await parley.read_room({ room: ${JSON.stringify(roomOwn)}, limit: 2 })`);
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed' });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
    await createRemoteToolRunner(agent, switched).call('read_room', { room: roomOwn, limit: 2 }, undefined);
    const raws = log.map((l) => l.raw).filter((raw) => raw.startsWith('{"op":"call"'));
    const [broker, classic] = raws.map((raw) => raw.replace((JSON.parse(raw) as { callId: string }).callId, 'CALL'));
    expect(broker).toBe(classic);
    expect(calls()[0]!['launch']).toEqual(switched);
    // The preflight list, the broker's call and the classic call all reached one slot.
    expect(contexts()).toBe(1);
  }, T);

  it('a broker run does not evict the classic replay memory; a launch without the revision, what stripping would send, does', async () => {
    await setRevision('rev-new');
    const { run, agent, contexts } = await setup(undefined, undefined, 0, switched);
    const write = { op: 'call', launch: switched, name: 'send_message', args: { to: 's-02', text: 'once' }, callId: 'call-1' };
    const first = await post(agent, write);
    expect(first.status).toBe(200);
    expect(textsOf('once')).toHaveLength(1);
    const r = await run('return await parley.get_map({})');
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
    const replay = await post(agent, write);
    expect(replay).toEqual(first);
    expect(textsOf('once')).toHaveLength(1);
    expect(contexts()).toBe(1);
    // Control: the same read under a launch without the revision takes the session's only slot, and the retried write runs again.
    await post(agent, { op: 'call', launch: { toolProfile: 'short' }, name: 'get_map', args: {}, callId: 'call-2' });
    expect(contexts()).toBe(2);
    await post(agent, write);
    expect(contexts()).toBe(3);
    expect(textsOf('once')).toHaveLength(2);
  }, T);

  it('the fence decides on the forwarded value: the current revision writes; a stale or absent one is refused like the classic runner; fence-free reads stay open', async () => {
    await setRevision('rev-new');
    const { agent, run } = await setup(undefined, undefined, 0, { agentRevision: 'rev-old', toolProfile: 'short' });
    const send = (text: string) => ({ to: 's-02', text });
    expect(await callOnce(agent, switched, 'send_message', send('current'))).toMatchObject({ kind: 'ok' });
    expect(textsOf('current')).toHaveLength(1);
    for (const stale of [{ agentRevision: 'rev-old', toolProfile: 'short' }, { toolProfile: 'short' }] as ToolLaunch[]) {
      const mine = await callOnce(agent, stale, 'send_message', send('stale'));
      expect(mine).toMatchObject({ kind: 'tool-error' });
      expect(mine.kind === 'tool-error' && mine.text).toContain(STALE);
      const classic = await createRemoteToolRunner(agent, stale).call('send_message', send('stale'), undefined);
      expect(classic.isError).toBe(true);
      expect(JSON.stringify(classic)).toContain(STALE);
    }
    expect(textsOf('stale')).toHaveLength(0);
    // The stale launch's broker reads: the cohort is fence-free on master, as for the classic runner.
    const r = await run('const m = await parley.get_map({}); return m.ok ? "ok" : "error";');
    expect(r).toMatchObject({ runStatus: 'completed', outcome: { value: '"ok"' } });
    // A switch during the launch's life: the same caller launch is stale at the next call.
    await setRevision('rev-newer');
    const after = await callOnce(agent, switched, 'send_message', send('after switch'));
    expect(after.kind === 'tool-error' && after.text).toContain(STALE);
    expect(textsOf('after switch')).toHaveLength(0);
  }, T);

  it('a session that never switched is unchanged: no revision in the map or the launch, no fence, and the body has no such key', async () => {
    const { run, agent, calls } = await setup();
    const r = await run('return await parley.get_map({})');
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
    expect(calls()[0]!['launch']).toEqual({ toolProfile: 'short' });
    expect(await callOnce(agent, { toolProfile: 'short' }, 'send_message', { to: 's-02', text: 'plain' })).toMatchObject({ kind: 'ok' });
    expect(textsOf('plain')).toHaveLength(1);
  }, T);

  it('invalid values are refused before any request; the endpoint keeps refusing a non-string on its own', async () => {
    const host = await bootHost();
    const { B, F, catalog } = await fresh();
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    for (const agentRevision of [7, true, null, '', {}, ['rev-new']]) {
      expect(() => B.createBroker({ hold: HOLD(), source: fake.source, catalog, launchId: 'launch-1', agent: host.agent, launch: { agentRevision } as never }), JSON.stringify(agentRevision)).toThrow(new B.BrokerError('invalid-launch'));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.log).toHaveLength(0);
    const refused = await post(host.agent, { op: 'list', launch: { agentRevision: 7 } });
    expect(JSON.parse(refused.text)).toMatchObject({ ok: false, error: { code: 'bad_request', message: 'launch.agentRevision must be a string.' } });
  }, T);
});

describe.skipIf(!supported)('T6c: the real handlers through the real endpoint', () => {
  const finalOf = async (r: { runId: string | null; evidence: unknown; incomplete: boolean }, apiRevision: string, catalog: unknown) => {
    const C = (await import(distUrl('mcp/code-mode/contracts.js'))) as typeof ContractsModule;
    const validators = C.compileCallValidators(catalog as never, apiRevision);
    return C.makeExecuteResult(validators, { runId: r.runId!, status: 'completed', operations: r.evidence as never, incomplete: r.incomplete });
  };

  it('236 summaries: nine rows on the first page; a script that keeps only the count still ends incomplete', async () => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 234; i++) addSession(map, { provider: 'claude', label: `w${i}`, task: 't' });
      for (const s of map.sessions) { s.summary = `${s.id} `.padEnd(7000, 'x'); s.summarySource = 'agent'; }
    });
    const { run, broker, catalog } = await setup();
    const r = await run('const p = await parley.get_map({ field: "summaries" }); return p.ok ? p.value.summaries.length : p.error.kind;');
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', outcome: { value: '9' }, incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment: 'partial' });
    expect(r.evidence[0]).toMatchObject({ outcome: 'succeeded', incomplete: true });
    const final = await finalOf(r, broker.launch.apiRevision, catalog);
    expect(final).toMatchObject({ status: 'completed', incomplete: true, value: null });
  }, T);

  it('paged to the end it stays incomplete: a later read does not clear it (30 sessions: paging 236 reaches the raw budget, see T5b-budget-wedge)', async () => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 28; i++) addSession(map, { provider: 'claude', label: `w${i}`, task: 't' });
      for (const s of map.sessions) { s.summary = `${s.id} `.padEnd(7000, 'x'); s.summarySource = 'agent'; }
    });
    const { run } = await setup();
    const r = await run(`
      let cursor; let rows = 0; let pages = 0; let last;
      do {
        const p = await parley.get_map({ field: "summaries", ...(cursor ? { cursor } : {}) });
        if (!p.ok) return p.error;
        rows += p.value.summaries.length; pages++; cursor = p.value.page.next; last = p.value.page.complete;
      } while (cursor && pages < 30);
      return { rows, last, pages };
    `);
    const out = JSON.parse(r.outcome!.value as string) as { rows: number; last: boolean; pages: number };
    expect(out).toMatchObject({ rows: 30, last: true });
    expect(out.pages).toBeGreaterThan(1);
    expect(r.ledger!.entries.at(-1)).toMatchObject({ state: 'succeeded' });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
  }, 2 * T);

  it.each([
    ['the overview', 'return await parley.get_map({})', 'unknown', true],
    ['read_guide', 'return (await parley.read_guide({})).ok', 'unknown', true],
    ['backlog_list', 'return (await parley.backlog_list({})).ok', 'unknown', true],
  ])('%s is incomplete by design', async (_name, code, assessment, incomplete) => {
    const { run } = await setup();
    const r = await run(code);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete });
  }, T);

  it('read_room of a short room and a room-less map form can be complete', async () => {
    const { run } = await setup();
    const room = await run(`return (await parley.read_room({ room: ${JSON.stringify(roomOwn)} })).ok`);
    expect(room.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment: 'complete' });
    expect(room).toMatchObject({ outcome: { value: 'true' }, incomplete: false });
    const goal = await run('return (await parley.get_map({ field: "title" })).value.text');
    expect(goal).toMatchObject({ outcome: { value: JSON.stringify('Code Mode broker fixture') }, incomplete: false });
  }, T);

  it('a call refused by the input schema never reaches the host or a decoder', async () => {
    const { run, calls } = await setup();
    const r = await run('try { await parley.read_room({ room: "r", limit: "x" }); return "sent"; } catch (e) { return e.message; }');
    expect(r).toMatchObject({ outcome: { value: '"parley: call refused"' } });
    expect(calls()).toHaveLength(0);
  }, T);
});

describe.skipIf(!supported)('T5b-budget-wedge: what the real endpoint proves, and paging to the budget', () => {
  const SESSIONS = async (count: number): Promise<void> => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < count - 2; i++) addSession(map, { provider: 'claude', label: `w${i}`, task: 't' });
      for (const s of map.sessions) { s.summary = `${s.id} `.padEnd(7000, 'x'); s.summarySource = 'agent'; }
    });
  };
  const PAGING = (catchIt: boolean): string => `
    let cursor; let rows = 0; let pages = 0;
    const page = () => parley.get_map({ field: "summaries", ...(cursor ? { cursor } : {}) });
    do {
      let p;
      ${catchIt ? 'try { p = await page(); } catch (e) { return { rows, pages, stopped: e.message }; }' : 'p = await page();'}
      rows += p.value.summaries.length; pages++; cursor = p.value.page.next;
    } while (cursor && pages < 40);
    return { rows, pages };
  `;

  /** A call to the endpoint's real route whose response is watched from the first byte. */
  const watch = (agent: { url: string; token: string }, body: unknown, onBody?: (req: ClientRequest) => void) => new Promise<{ status: number | undefined; headersAt: number }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(new URL(AGENT_TOOLS_PATH, agent.url), { method: 'POST', agent: false, headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      resolve({ status: res.statusCode, headersAt: performance.now() });
      res.on('data', () => undefined);
      res.on('error', () => undefined);
      onBody?.(req);
    });
    req.on('error', (e) => { if (onBody === undefined) reject(e); });
    req.end(payload);
  });

  it('the endpoint sends no 200 while work is outstanding, and a client cutting right after it aborts nothing', async () => {
    let release: (rows: ProviderRow[]) => void = () => undefined;
    let started = 0;
    const held = (): Promise<ProviderRow[]> => { started++; return new Promise((resolve) => { release = resolve; }); };
    const host = await bootHost(undefined, 0, held);
    const call = (callId: string) => ({ op: 'call', launch: {}, name: 'get_map', args: { field: 'providers' }, callId });
    let answered = false;
    const reply = watch(host.agent, call('order-1'), (req) => req.destroy()).then((r) => { answered = true; return r; });
    await vi.waitFor(() => { expect(started).toBe(1); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Handler still running: no status line, not even headers.
    expect(answered).toBe(false);
    const releasedAt = performance.now();
    release([]);
    const { status, headersAt } = await reply;
    expect(status).toBe(200);
    expect(headersAt).toBeGreaterThanOrEqual(releasedAt);
    // The client cut after the headers. The call had settled, so a replay of its callId finds the finished record.
    const again = await watch(host.agent, call('order-1'));
    expect(again.status).toBe(200);
    expect(started).toBe(1);
    expect(host.contexts()).toBe(1);
  }, T);

  describe('a host stopped with a read in flight (plan T8h, §9.1): one process of the session, the endpoint and its memory replaced', () => {
    /** A read held inside the real handler, a host stopped under it, and a new host on the same port. Handler starts are counted per host. */
    async function stoppedUnderARead(keepToken: boolean) {
      let startedOld = 0;
      let startedNew = 0;
      const old = await bootHost(undefined, 0, () => { startedOld++; return new Promise<ProviderRow[]>(() => undefined); });
      const { B, F, catalog } = await fresh();
      const hold = HOLD();
      const broker = B.createBroker({ hold, source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog, launchId: 'launch-1', agent: old.agent, launch: { toolProfile: 'short' } });
      const running = broker.run('try { await parley.get_map({ field: "providers" }); } catch {} return 1;', broker.launch.apiRevision);
      await vi.waitFor(() => { expect(startedOld).toBe(1); }, { timeout: 20_000 });
      await old.stop();
      const next = await bootHost(undefined, 0, async () => { startedNew++; return []; }, { port: old.port, ...(keepToken ? { keep: { registry: old.registry, token: old.token } } : {}) });
      const result = await running;
      return { result, hold, broker, next, startedOld, startedNew: () => startedNew };
    }
    const inspect = async (hold: { workDir: string; sessionId: string }) => {
      const R = (await import(distUrl('mcp/code-mode/run-record.js'))) as { inspectRunRecord: (w: string, s: string) => { kind: string } };
      const D = (await import(distUrl('mcp/code-mode/launch-decision.js'))) as { selectExposure: (i: unknown) => { effective: string; reason: string } };
      const record = R.inspectRunRecord(hold.workDir, hold.sessionId);
      return { record, chosen: D.selectExposure({ requested: true, refused: null, record }) };
    };
    it('the host as it is: its token registry is memory too, so the new host answers 401. Unknown, no second handler start, the lease stays held, and the next launch is classic', async () => {
      const { result, hold, broker, next, startedOld, startedNew } = await stoppedUnderARead(false);
      expect(result.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
      expect(result.audit).toEqual([expect.objectContaining({ outcome: 'unknown', why: '401' })]);
      expect(startedOld).toBe(1);
      expect(startedNew()).toBe(0);
      expect(next.contexts()).toBe(0);
      expect(await broker.run('return 2', broker.launch.apiRevision)).toMatchObject({ status: 'busy' });
      const { record, chosen } = await inspect(hold);
      expect(record.kind).toBe('held-live');
      expect(chosen).toMatchObject({ effective: 'classic', reason: 'held-run' });
    }, T);
    it('were a token to survive: the replay memory does not, so the new host runs the read again under one call id. Harmless for a read; T11 inherits this for anything else', async () => {
      const { result, next, startedOld, startedNew } = await stoppedUnderARead(true);
      expect(startedOld).toBe(1);
      expect(startedNew()).toBe(1);
      expect(result.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
      expect(next.calls()).toHaveLength(1);
    }, T);
  });

  it('a 200 does not prove the handler ran: a refused request also answers 200, and the broker treats it as unread', async () => {
    const host = await bootHost();
    const refused = await fetch(new URL(AGENT_TOOLS_PATH, host.agent.url), { method: 'POST', headers: { authorization: `Bearer ${host.agent.token}` }, body: JSON.stringify({ op: 'nonsense', launch: {} }) });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  }, T);

  it('paging 236 summaries, caught: stops at the raw budget with the fixed refusal, incomplete, and the next run is not busy', async () => {
    await SESSIONS(236);
    const { run } = await setup();
    const r = await run(PAGING(true));
    const out = JSON.parse(r.outcome!.value as string) as { rows: number; pages: number; stopped: string };
    expect(out.stopped).toBe('parley: call response not delivered');
    expect(out.rows).toBeLessThan(236);
    expect(out.pages).toBeGreaterThan(1);
    const entries = r.ledger!.entries;
    expect(entries.at(-1)).toMatchObject({ state: 'unread' });
    expect(entries.slice(0, -1).every((e) => e.state === 'succeeded')).toBe(true);
    expect(r.audit.at(-1)).toMatchObject({ outcome: 'unread', why: 'body-over-cap' });
    expect(r.ledger!.hostBytes).toBeGreaterThan(1024 * 1024);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    await r.drained;
    expect(await run('return (await parley.read_guide({})).ok;')).toMatchObject({ runStatus: 'completed', outcome: { value: 'true' } });
  }, 2 * T);

  it('paging 236 summaries, uncaught: error and incomplete, not wedged', async () => {
    await SESSIONS(236);
    const { run } = await setup();
    const r = await run(PAGING(false));
    expect(r).toMatchObject({ status: 'finished', runStatus: 'error', killedBy: null, incomplete: true });
    expect(r.ledger!.entries.at(-1)).toMatchObject({ state: 'unread' });
    await r.drained;
    expect(await run('return 1')).toMatchObject({ runStatus: 'completed', outcome: { value: '1' } });
  }, 2 * T);
});
