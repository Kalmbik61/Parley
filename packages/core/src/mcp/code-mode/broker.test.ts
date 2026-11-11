// Code Mode fixture broker (plan T5b3) under the real sandboxed helper and the synthetic root agent host. The broker
// and helper run from the built dist (the helper spawns dist/helper-entry.js), so beforeAll rebuilds @parley/core. The
// root fixture policy source imports native-policy from src; it is mapped to the dist module here so the fixture's
// minted sources and the broker's gate share one module instance. Each test loads fresh module instances
// (vi.resetModules), so a run that keeps the process lease under U2 never makes a later test busy.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as BrokerModule from './broker.js';
import type * as CatalogModule from './catalog.js';
import type * as ContractsModule from './contracts.js';
import type * as FixtureModule from '../../../../../tests/fixtures/code-mode/native-policy.js';
import { type AgentHost, FIXTURE_TOKEN, type Script, okEnvelope, startAgentHost } from '../../../../../tests/fixtures/code-mode/agent-host.js';

const coreDir = fileURLToPath(new URL('../../../', import.meta.url));
const distUrl = (rel: string): string => pathToFileURL(path.join(coreDir, 'dist', rel)).href;
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec') && existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));
if (!supported) console.warn('broker.test: NOT RUN — needs darwin/arm64 sandbox-exec and the built product probe');

beforeAll(() => {
  if (supported) execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir });
}, 120_000);

const holdRoots: string[] = [];
/** Each broker's run record lives in a fresh directory unless a test shares one. */
const HOLD = () => { const workDir = mkdtempSync(path.join(tmpdir(), 'parley-t7a-hold-')); holdRoots.push(workDir); return { workDir, sessionId: 's-1' }; };
afterAll(() => { for (const d of holdRoots) rmSync(d, { recursive: true, force: true }); });
const hosts: AgentHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.close())); });
const host = async (script: Script): Promise<AgentHost> => { const h = await startAgentHost(script); hosts.push(h); return h; };

/**
 * Fresh dist module instances: a new process-wide lease, a new mint, a new gate module. The root fixture imports
 * native-policy from src; it is pointed at this fresh dist instance, so its minted sources are the broker's.
 */
async function fresh() {
  vi.resetModules();
  const NP = (await import(distUrl('mcp/code-mode/native-policy.js'))) as Record<string, unknown>;
  vi.doMock('./native-policy.js', () => NP);
  const B = (await import(distUrl('mcp/code-mode/broker.js'))) as typeof BrokerModule;
  const F = (await import('../../../../../tests/fixtures/code-mode/native-policy.js')) as typeof FixtureModule;
  const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
  const T = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof CatalogModule.buildCatalog>[0] };
  // The five are enabled (proven): only an enabled method has a guest stub (T11 B0).
  return { B, F, catalog: C.buildCatalog(T.TOOLS, { migrated: [...C.INITIAL_COHORT] }) };
}

const RESULT = { content: [{ type: 'text', text: '{"map":1}' }] };
const ERR = { content: [{ type: 'text', text: 'You are not a member of this room.' }], isError: true };
type Reply = Awaited<ReturnType<Script>>;
/** The list preflight answers ok; each call request gets `call(n, body)` (n counts call requests only). */
const tools = (call: (n: number, body: Record<string, unknown>) => Reply | Promise<Reply>): Script => {
  let n = 0;
  return (r) => {
    const body = JSON.parse(r.raw) as Record<string, unknown>;
    if (body['op'] === 'list') return { body: okEnvelope({ tools: [] }) };
    return call(++n, body);
  };
};
const calls = (h: AgentHost) => h.log.map((x) => JSON.parse(x.raw) as Record<string, unknown>).filter((b) => b['op'] === 'call');
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };
const busy = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* block */ } };
const T = 30_000;

/** A broker over a fresh module graph and a synthetic agent host. */
async function setup(script: Script, rule: FixtureModule.FixtureRule = () => 'allow', over: Partial<BrokerModule.BrokerOptions> = {}) {
  const { B, F, catalog } = await fresh();
  const h = await host(script);
  const fake = F.createFixturePolicySource(F.FIXTURE_HOST, rule);
  const hold = over.hold ?? HOLD();
  const broker = B.createBroker({ source: fake.source, catalog, launchId: 'launch-1', agent: h.agent, launch: { toolProfile: 'short' }, ...over, hold });
  return { B, F, catalog, h, fake, broker, hold, run: (code: string, limits?: Partial<import('./limits.js').RunLimits>, signal?: AbortSignal) => broker.run(code, broker.launch.apiRevision, signal, limits) };
}

describe.skipIf(!supported)('T5b3 broker: construction and provenance', () => {
  it('builds its own gate and caller: a look-alike source, bad agent, bad launch or bad meta is refused; injected bundles are ignored', async () => {
    const { B, F, catalog } = await fresh();
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    const agent = { url: 'http://127.0.0.1:1/agent/browser', token: FIXTURE_TOKEN };
    const base = { hold: HOLD(), source: fake.source, catalog, launchId: 'launch-1', agent, launch: {} };
    expect(() => B.createBroker({ ...base, source: { ...fake.source } })).toThrow('invalid-source');
    for (const bad of [{ url: 'ftp://x/', token: 't' }, { url: 'http://127.0.0.1:1', token: '' }]) expect(() => B.createBroker({ ...base, agent: bad })).toThrow(new B.BrokerError('invalid-agent'));
    expect(() => B.createBroker({ ...base, launch: { extra: 1 } as never })).toThrow(new B.BrokerError('invalid-launch'));
    for (const meta of [[1], 'x', 7, { big: 'm'.repeat(17 * 1024) }, { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }, Object.defineProperty({}, 'g', { get: () => 1, enumerable: true }), { n: Number.NaN }]) {
      expect(() => B.createBroker({ ...base, meta }), JSON.stringify(meta)?.slice(0, 40)).toThrow(new B.BrokerError('invalid-meta'));
    }
    // Extra option keys cannot inject a gate, validators or caller: the broker's own gate defines the launch.
    const own = B.createBroker({ ...base, gate: { launch: { apiRevision: 'cm1.' + '0'.repeat(64) } }, validators: {}, caller: {}, fallback: {} } as never);
    expect(own.launch.apiRevision).toMatch(/^cm1\.[0-9a-f]{64}$/);
    expect(own.launch.apiRevision).not.toBe('cm1.' + '0'.repeat(64));
    expect(own.launch.methods).toEqual(['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room']);
  });

  it('refuses a run method that is not a read effect (R2)', async () => {
    const { B, F, catalog } = await fresh();
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    const writeMap = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'get_map' ? { ...e, effect: 'write' as const } : e)) };
    expect(() => B.createBroker({ hold: HOLD(), source: fake.source, catalog: writeMap, launchId: 'l-1', agent: { url: 'http://127.0.0.1:1', token: 't' }, launch: {} })).toThrow(new B.BrokerError('non-read-method'));
  });

  it('a stale apiRevision runs nothing: zero requests', async () => {
    const { broker, h } = await setup(tools(() => ({ body: okEnvelope(RESULT) })));
    const r = await broker.run('return await parley.get_map({})', 'cm1.' + '1'.repeat(64));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'stale apiRevision', hostCalls: 0 });
    expect(h.log).toHaveLength(0);
  }, T);
});

describe.skipIf(!supported)('T5b3 broker: identity of every request', () => {
  it('a switched session builds a broker, and the preflight, every call and every retry carry its exact agentRevision', async () => {
    // launchOf's canonical key order, with the revision a switched session has.
    const launch = { nativeContextRevision: 'r1', agentRevision: 'rev-new', toolProfile: 'short' as const };
    const { h, run } = await setup(tools((n) => (n === 1 ? { status: 503 } : { body: okEnvelope(RESULT) })), () => 'allow', { launch });
    const r = await run('await parley.get_map({}); return await parley.read_guide({});');
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 2 });
    expect(r.audit.map((a) => a.attempts)).toEqual([2, 1]);
    expect(h.log[0]!.raw).toBe(JSON.stringify({ op: 'list', launch }));
    expect(h.log).toHaveLength(4);
    expect(h.log[2]!.raw).toBe(h.log[1]!.raw);
    for (const entry of h.log.slice(1)) expect(entry.raw.startsWith(`{"op":"call","launch":${JSON.stringify(launch)},`)).toBe(true);
  }, T);

  it('an invalid agentRevision is invalid-launch: no broker, no request', async () => {
    const { B, F, catalog } = await fresh();
    const h = await host(tools(() => ({ body: okEnvelope(RESULT) })));
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    for (const agentRevision of [7, true, null, '', {}, ['rev-new']]) {
      expect(() => B.createBroker({ hold: HOLD(), source: fake.source, catalog, launchId: 'launch-1', agent: h.agent, launch: { agentRevision } as never }), JSON.stringify(agentRevision)).toThrow(new B.BrokerError('invalid-launch'));
    }
    expect(h.log).toHaveLength(0);
  });

  it('the launch and host meta are byte-identical in every body; guest fields never become meta; no token, URL or callId reaches the guest', async () => {
    // launchOf's canonical key order (skillNavigator, skillListReduced, nativeContextRevision, toolProfile).
    const launch = { nativeContextRevision: 'r1', toolProfile: 'short' as const };
    const meta = { threadId: 't-1', nested: { a: [1, 'x'] } };
    const { h, run } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => 'allow', { launch, meta });
    meta.threadId = 'changed-after-construction';
    const r = await run('const a = await parley.read_room({ room: "r-1", meta: { threadId: "guest" } }); const b = await parley.get_map({}); return [a, b];');
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 2 });
    expect(h.log[0]!.raw).toBe(JSON.stringify({ op: 'list', launch }));
    const bodies = h.log.slice(1).map((x) => x.raw);
    const parsed = bodies.map((b) => JSON.parse(b) as { callId: string });
    expect(bodies[0]).toBe(`{"op":"call","launch":${JSON.stringify(launch)},"name":"read_room","args":{"room":"r-1","meta":{"threadId":"guest"}},"meta":{"threadId":"t-1","nested":{"a":[1,"x"]}},"callId":${JSON.stringify(parsed[0]!.callId)}}`);
    expect(bodies[1]).toBe(`{"op":"call","launch":${JSON.stringify(launch)},"name":"get_map","args":{},"meta":{"threadId":"t-1","nested":{"a":[1,"x"]}},"callId":${JSON.stringify(parsed[1]!.callId)}}`);
    expect(h.log.every((x) => x.authorization === `Bearer ${FIXTURE_TOKEN}`)).toBe(true);
    const guestSide = JSON.stringify({ ...r, drained: null });
    for (const secret of [FIXTURE_TOKEN, h.agent.url, ...parsed.map((p) => p.callId)]) expect(guestSide).not.toContain(secret);
    // Broker audit identity (this run's snapshot), distinct from the transport callId.
    const audit = r.audit;
    expect(Object.isFrozen(audit)).toBe(true);
    expect(audit.map((a) => [a.launchId, a.runId, a.ordinal, a.method, a.outcome, a.attempts])).toEqual([['launch-1', r.runId, 1, 'read_room', 'ok', 1], ['launch-1', r.runId, 2, 'get_map', 'ok', 1]]);
    expect(audit[0]!.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit)).not.toContain(parsed[0]!.callId);
  }, T);
});

describe.skipIf(!supported)('T5b3 r2 (A1): the audit is a per-run snapshot returned with the result', () => {
  it('records are ordered by ordinal even when the receipts complete in reverse', async () => {
    // Call 1 is answered late, call 2 at once: completion order 2, 1.
    const { run, h } = await setup(tools((n) => ({ body: okEnvelope(RESULT), delayMs: n === 1 ? 700 : 20 })));
    const r = await run('return await Promise.all([parley.get_map({}), parley.read_room({ room: "r-1" })]).then((x) => x.length)');
    expect(r).toMatchObject({ runStatus: 'completed', outcome: { value: '2' } });
    expect(calls(h).map((b) => b['name'])).toEqual(['get_map', 'read_room']);
    expect(r.audit.map((a) => [a.ordinal, a.method, a.outcome])).toEqual([[1, 'get_map', 'ok'], [2, 'read_room', 'ok']]);
    expect(Object.isFrozen(r.audit)).toBe(true);
  }, T);

  it('each run carries only its own records; a later run neither contains nor changes an earlier result', async () => {
    const { run, broker } = await setup(tools(() => ({ body: okEnvelope(RESULT) })));
    const first = await run('return await parley.get_map({})');
    const before = JSON.stringify(first.audit);
    const second = await run('await parley.get_map({}); return await parley.read_guide({})');
    expect(first.audit.map((a) => a.runId)).toEqual([first.runId]);
    expect(second.audit.map((a) => [a.runId, a.ordinal, a.method])).toEqual([[second.runId, 1, 'get_map'], [second.runId, 2, 'read_guide']]);
    expect(second.runId).not.toBe(first.runId);
    expect(JSON.stringify(first.audit)).toBe(before);
    expect('audit' in broker).toBe(false);
  }, T);
});

describe.skipIf(!supported)('T5b3 broker: native policy at the dispatch edge', () => {
  it.each(['deny', 'ask', 'unknown'] as const)('%s: zero call requests, a fixed line, the entry records it', async (state) => {
    const { run, h } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => state);
    const r = await run('try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }');
    expect(calls(h)).toHaveLength(0);
    expect(r).toMatchObject({ status: 'finished', hostCalls: 0, outcome: { value: '"parley: not permitted by native policy"' } });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'policy', policy: state });
  }, T);

  it('argument-dependent: read_room r-secret is denied, r-1 is sent', async () => {
    const { run, h } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), (q) => ((q.args as { room?: string }).room === 'r-secret' ? 'deny' : 'allow'));
    const r = await run('const out = []; for (const room of ["r-secret", "r-1"]) { try { await parley.read_room({ room }); out.push("ok"); } catch (e) { out.push(e.message); } } return out;');
    expect(r.outcome).toMatchObject({ value: JSON.stringify(['parley: not permitted by native policy', 'ok']) });
    expect(calls(h).map((b) => b['args'])).toEqual([{ room: 'r-1' }]);
  }, T);
});

// A is started and held by the host; B is revoked at the edge; C would follow B if admission were still open.
const DRAIN = 'const a = parley.get_map({}); let b; try { await parley.read_room({ room: "r-1" }); } catch (e) { b = e.message; } await parley.get_map({}); return [await a, b];';
const revokeRoom: FixtureModule.FixtureRule = (q) => (q.method === 'read_room' ? 'revoked' : 'allow');

describe.skipIf(!supported)('T5b3 broker: terminal policy stop drains, abort and wall cancel', () => {
  it('A drains to its receipt, C is never sent, status policy; the gate is terminal for later runs', async () => {
    const { run, h, broker } = await setup(tools(() => ({ body: okEnvelope(RESULT), delayMs: 600 })), revokeRoom);
    const r = await run(DRAIN);
    expect(r).toMatchObject({ status: 'policy', reason: 'native policy revoked', runStatus: 'error', hostCalls: 1 });
    expect(r.ledger!.entries.map((e) => [e.method, e.state, e.policy])).toEqual([['get_map', 'succeeded', null], ['read_room', 'refused', 'revoked']]);
    expect(calls(h).map((b) => b['name'])).toEqual(['get_map']);
    await r.drained;
    expect(await broker.run('return 1', broker.launch.apiRevision)).toMatchObject({ status: 'unavailable', reason: 'native policy revoked: use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts', hostCalls: 0 });
    // the refusal reason names no client list and leans on no bare "listed" either (T8e)
    const refused = await broker.run('return 1', broker.launch.apiRevision);
    expect(refused.status === 'unavailable' ? String(refused.reason).split('listed or loadable on demand').join('') : '').not.toMatch(/\blisted\b|tool list/i);
  }, T);

  it('a caller abort during the drain cancels A: its request is aborted, the outcome unknown (U2)', async () => {
    const { run, h } = await setup(tools(() => ({ hang: true })), revokeRoom);
    const ctl = new AbortController();
    const pending = run(DRAIN, undefined, ctl.signal);
    await until(() => calls(h).length === 1);
    await settle(400);
    ctl.abort();
    const r = await pending;
    expect(r.status).toBe('policy');
    // A was asked to cancel; its late outcome belongs to the ledger, and the audit snapshot only has what settled by return.
    expect(r.ledger!.entries[0]).toMatchObject({ method: 'get_map', cancelRequested: true });
    expect(r.audit.every((a) => a.outcome === 'unknown' && a.why === 'aborted')).toBe(true);
    expect(calls(h)).toHaveLength(1);
  }, T);

  it('the run wall during the drain cancels A as well', async () => {
    const { run, h } = await setup(tools(() => ({ hang: true })), revokeRoom);
    const r = await run(DRAIN, { wallMs: 3500 });
    expect(r).toMatchObject({ status: 'policy', runStatus: 'partial-or-unknown' });
    expect(r.ledger!.entries[0]).toMatchObject({ method: 'get_map', cancelRequested: true });
    expect(r.audit.every((a) => a.outcome === 'unknown' && a.why === 'aborted')).toBe(true);
    expect(calls(h)).toHaveLength(1);
  }, T);
});

describe.skipIf(!supported)('T5b3 broker: retries after a send', () => {
  it('503 then revocation: exactly one request, unknown (retry-not-authorized) with dispatched evidence, the session stays busy', async () => {
    const { B, F, catalog } = await fresh();
    // The host revokes the policy (a revision bump) while it answers attempt 1 with 503.
    const holder: { fake?: ReturnType<typeof F.createFixturePolicySource> } = {};
    const h = await host(tools(() => { holder.fake!.bump(); return { status: 503, body: 'busy' }; }));
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    holder.fake = fake;
    const broker = B.createBroker({ hold: HOLD(), source: fake.source, catalog, launchId: 'launch-1', agent: h.agent, launch: {} });
    const r = await broker.run('try { await parley.get_map({}); } catch (e) { return e.message; }', broker.launch.apiRevision);
    expect(calls(h)).toHaveLength(1);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown', unknownWhy: 'host-unknown', responseBytes: 4 });
    expect(r.evidence[0]).toMatchObject({ dispatched: true, outcome: 'unknown' });
    expect(r.audit).toEqual([expect.objectContaining({ ordinal: 1, outcome: 'unknown', why: 'retry-not-authorized', attempts: 1, observedBytes: 4 })]);
    // U2: the process lease is held; another broker of the same process is busy.
    const other = B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog, launchId: 'launch-2', agent: h.agent, launch: {} });
    expect(await other.run('return 1', other.launch.apiRevision)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run has calls with unknown outcome/) });
  }, T);

  it('retries are bounded by the remaining total run wall: the caller gives up before the wall instead of being aborted by it', async () => {
    const { run, h } = await setup(tools(() => ({ status: 503 })));
    const t0 = Date.now();
    const r = await run('try { await parley.get_map({}); } catch (e) { return e.message; }', { wallMs: 2500 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    // The window is the run's remaining wall: the next pause would cross it, so the caller stops (gave-up) on its own.
    expect(r.audit[0]).toMatchObject({ outcome: 'unknown', why: 'gave-up' });
    expect(r.status).toBe('finished');
    expect(calls(h).length).toBeGreaterThanOrEqual(2);
    expect(calls(h).length).toBeLessThanOrEqual(6);
  }, T);

  it('a lost response is retried with the same callId; a restarted host may execute it again (no exactly-once claim)', async () => {
    const { run, h } = await setup(tools((n) => (n === 1 ? { body: okEnvelope(RESULT), drop: { afterBytes: 10 } } : { body: okEnvelope(RESULT) })));
    const r = await run('return await parley.get_map({})');
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed' });
    const ids = calls(h).map((b) => b['callId']);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(r.audit[0]).toMatchObject({ outcome: 'ok', attempts: 2, observedBytes: 10 + Buffer.byteLength(okEnvelope(RESULT)) });
  }, T);

  it('every attempt lost: unknown (U2), never a settled outcome', async () => {
    const { run } = await setup(tools(() => ({ drop: 'before-headers' })));
    const r = await run('try { await parley.get_map({}); } catch (e) { return e.message; }', { wallMs: 3000 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]!.outcome).toBe('unknown');
  }, T);

  it('a 404 after a good preflight is refused with zero dispatch (spec §5.2), never read locally, and the lease goes', async () => {
    const { run, h } = await setup(tools(() => ({ status: 404 })));
    const r = await run('try { await parley.get_map({}); } catch (e) { return e.message; }');
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'host-unavailable' });
    expect(r.evidence[0]).toMatchObject({ dispatched: false, outcome: 'refused' });
    expect(r.hostCalls).toBe(0);
    expect(r.audit[0]).toMatchObject({ outcome: 'not-dispatched', why: '404', attempts: 1 });
    expect(r.outcome).toMatchObject({ ok: true, value: JSON.stringify('parley: host unavailable, call not dispatched') });
    expect(calls(h)).toHaveLength(1);
    expect(await r.drained).toMatchObject({ quiescent: true });
    expect(await run('return 1')).toMatchObject({ status: 'finished', runStatus: 'completed' });
  }, T);

  it('a reset after the body left, then a 404: unknown (attempt 1 may have run), and the lease is held (s-296 m-7463)', async () => {
    let n = 0;
    const { run, h } = await setup(tools(() => (++n === 1 ? { drop: 'before-headers' } : { status: 404 })));
    const r = await run('try { await parley.get_map({}); } catch (e) { return e.message; }');
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(r.audit[0]).toMatchObject({ outcome: 'unknown', why: '404', attempts: 2 });
    expect(calls(h)).toHaveLength(2);
    expect(await run('return 1')).toMatchObject({ status: 'busy' });
  }, T);
});

describe.skipIf(!supported)('T5b3 broker: stash', () => {
  it('nothing stays prepared after a run, including a call authorized after the deadline (zero sends)', async () => {
    let slow = false;
    const { run, h, broker } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => { if (slow) busy(4200); return 'allow'; });
    expect((await run('return await parley.get_map({})')).runStatus).toBe('completed');
    expect(broker.stashSize()).toBe(0);
    slow = true;
    const r = await run('try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }', { wallMs: 4000 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended' });
    expect(calls(h)).toHaveLength(1);
    expect(broker.stashSize()).toBe(0);
  }, T);
});

describe.skipIf(!supported)('T5b3 broker: bytes, errors and the preflight', () => {
  it('an isError result is a terminal failed receipt delivered as data, charged its wire bytes', async () => {
    const body = okEnvelope(ERR);
    const { run } = await setup(tools(() => ({ body })));
    const r = await run('return await parley.read_room({ room: "r-x" })');
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', outcome: { value: JSON.stringify({ ok: false, error: { kind: 'tool-error', result: ERR } }) } });
    expect(r.ledger).toMatchObject({ hostBytes: Buffer.byteLength(body), entries: [{ state: 'failed', responseBytes: Buffer.byteLength(body) }] });
  }, T);

  it('two started calls may each read up to their own cap (m-4295): every wire byte is recorded and further admission stops', async () => {
    const big = okEnvelope({ content: [{ type: 'text', text: 'w'.repeat(2500) }] });
    const n = Buffer.byteLength(big);
    const { run, h } = await setup(tools(() => ({ body: big, delayMs: 200 })));
    const r = await run('const out = await Promise.allSettled([parley.get_map({}), parley.get_map({})]); try { await parley.get_map({}); out.push("third sent"); } catch (e) { out.push(e.message); } return out.length;', { responseBytes: 4000 });
    expect(calls(h)).toHaveLength(2);
    expect(r.ledger!.hostBytes).toBe(2 * n);
    expect(2 * n).toBeGreaterThan(4000);
    expect(r.ledger!.entries.map((e) => e.state)).toEqual(['succeeded', 'succeeded', 'refused']);
    expect(r.ledger!.entries[2]).toMatchObject({ refusal: 'response-budget-exhausted' });
  }, T);

  it('a failing preflight (404) makes the run unavailable: nothing spawned, zero calls', async () => {
    const { run, h } = await setup((r) => (r.n === 1 ? { status: 404 } : { body: okEnvelope(RESULT) }));
    const res = await run('return await parley.get_map({})');
    expect(res).toMatchObject({ status: 'unavailable', reason: 'preflight refused the run', spawned: false, hostCalls: 0, preflight: { ok: false } });
    expect(h.log).toHaveLength(1);
    await res.drained;
  }, T);

  it('a hanging preflight: deadline-triggered wall-time with cleanup pending; the lease goes once the aborted list settles', async () => {
    const { run, B, F, catalog, h } = await setup(() => ({ hang: true }));
    const res = await run('return 1', { wallMs: 1500 });
    expect(res).toMatchObject({ status: 'wall-time', cleanup: 'pending', spawned: false });
    await res.drained;
    const other = B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog, launchId: 'launch-2', agent: h.agent, launch: {} });
    expect((await other.run('return 1', other.launch.apiRevision, undefined, { wallMs: 1500 })).status).not.toBe('busy');
  }, T);
});

// ----- Output contract (plan T6c) -----

const text = (value: unknown): { content: { type: string; text: string }[] } => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const PAGE_DONE = { total: 0, returned: 0, complete: true, next: null, bytes: 2, cut: 0 };
const ROLE = (description = 'd') => ({ id: 'claude:r', name: 'r', description, source: 'claude-project', provider: 'claude', model: null, effort: null, readOnly: false });
/** Shapes each decoder accepts, by method. */
const VALID: Record<string, unknown> = {
  read_guide: text('The guide.'),
  read_room: text({ messages: [], page: PAGE_DONE }),
  list_roles: text({ roles: [ROLE()], partial: false, diagnostics: [] }),
  backlog_list: text({ version: 'v1', items: [], suggestions: [], rule: 'r', diagnostics: [] }),
  get_map: text({ providers: [{ id: 'claude', label: 'Claude', available: true }] }),
};
const ARGS: Record<string, string> = { read_guide: '{}', read_room: '{ room: "r-1" }', list_roles: '{}', backlog_list: '{}', get_map: '{ field: "providers" }' };
const byMethod = (table: Record<string, unknown>): Script => tools((_n, body) => ({ body: okEnvelope(table[body['name'] as string]) }));

describe.skipIf(!supported)('T6c: what the guest receives and what the host keeps', () => {
  it.each([
    ['read_guide', 'unknown', true],
    ['backlog_list', 'unknown', true],
    ['read_room', 'complete', false],
    ['list_roles', 'complete', false],
    ['get_map', 'complete', false],
  ] as const)('%s: ok value to the guest, assessment %s to the ledger, final incomplete %s', async (method, assessment, incomplete) => {
    const { run } = await setup(byMethod(VALID));
    const r = await run(`const r = await parley.${method}(${ARGS[method]}); return { ok: r.ok, keys: Object.keys(r).sort() };`);
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 1, incomplete });
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: true, keys: ['ok', 'value'] });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment });
    expect(r.evidence[0]).toMatchObject({ outcome: 'succeeded', incomplete });
  }, T);

  it('a malformed DTO: operation succeeded, guest invalid-output with a fixed code, unknown, completed AND incomplete', async () => {
    const { run } = await setup(tools(() => ({ body: okEnvelope(text({ map: 1 })) })));
    const r = await run('return await parley.get_map({})');
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: false, error: { kind: 'invalid-output', code: 'shape-mismatch' } });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment: 'unknown' });
  }, T);

  it('a tool error: the original strict result as data, never an empty success; failed, unknown, incomplete', async () => {
    const { run } = await setup(tools(() => ({ body: okEnvelope(ERR) })));
    const r = await run('const r = await parley.read_room({ room: "r-x" }); return r.ok ? "success" : r.error.result.content[0].text;');
    expect(r.outcome).toMatchObject({ value: JSON.stringify(ERR.content[0]!.text) });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'failed', assessment: 'unknown' });
  }, T);

  it('a value the decoder lets through and the output schema does not fails closed as decoder-fault: still a receipt, no U2', async () => {
    const { run, B, F, catalog, h } = await setup(tools(() => ({ body: okEnvelope(text({ session: { id: 's-01', historyCount: 1, artifactCount: 0, history: [1], artifacts: [] } })) })));
    const r = await run('return await parley.get_map({ session: "s-01" })');
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: false, error: { kind: 'invalid-output', code: 'decoder-fault' } });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment: 'unknown', unknownWhy: null });
    await r.drained;
    const next = B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog, launchId: 'launch-2', agent: h.agent, launch: {} });
    expect((await next.run('return 1', next.launch.apiRevision)).status).not.toBe('busy');
  }, T);

  it('a transport unknown is not decoded: no assessment, the fixed message, incomplete', async () => {
    const { run } = await setup(tools(() => ({ status: 500 })));
    const r = await run('try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }');
    expect(r.outcome).toMatchObject({ value: '"parley: call outcome unknown"' });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown', assessment: null });
    expect(r.incomplete).toBe(true);
  }, T);

  it('envelope extras stay host-only: not in the guest value, not in the audit, not in the ledger', async () => {
    const CANARY = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
    const result = { ...text('The guide.'), _meta: { canary: CANARY }, structuredContent: { canary: CANARY } };
    result.content[0] = { ...result.content[0]!, annotations: { canary: CANARY } } as never;
    const { run } = await setup(tools(() => ({ body: okEnvelope(result) })));
    const r = await run('return JSON.stringify(await parley.read_guide({}));');
    expect(r.outcome).toMatchObject({ value: JSON.stringify(JSON.stringify({ ok: true, value: { text: 'The guide.' } })) });
    expect(JSON.stringify({ ...r, drained: null })).not.toContain(CANARY);
  }, T);

  it('a projection cannot clear it, and neither do later reads: the guest never sees the assessment', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: `s-${i}`, text: 't' }));
    const first = text({ summaries: rows, page: { total: 236, returned: 9, complete: false, next: 'after:9', bytes: 10, cut: 0 } });
    const { run } = await setup(tools((n) => ({ body: okEnvelope(n === 1 ? first : VALID['get_map']) })));
    const r = await run(`
      const page = await parley.get_map({ field: "summaries" });
      const count = page.ok ? page.value.summaries.length : -1;
      const more = await parley.get_map({ field: "providers" });
      return { count, sawAssessment: "assessment" in page || "incomplete" in page || "assessment" in more };
    `);
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ count: 9, sawAssessment: false });
    expect(r.ledger!.entries.map((e) => e.assessment)).toEqual(['partial', 'complete']);
    expect(r.evidence.map((e) => e.incomplete)).toEqual([true, false]);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
  }, T);

  it('raw and delivered bytes are separate counters', async () => {
    const body = okEnvelope(VALID['read_room']);
    const { run } = await setup(tools(() => ({ body })));
    const r = await run('await parley.read_room({ room: "r-1" }); return 1;');
    expect(r.ledger!.hostBytes).toBe(Buffer.byteLength(body));
    expect(r.ledger!.entries[0]!.responseBytes).toBe(Buffer.byteLength(body));
    expect(r.ledger!.entries[0]!.deliveredBytes).toBeGreaterThan(Buffer.byteLength(body));
    expect(r.ledger!.deliveredBytes).not.toBe(r.ledger!.hostBytes);
  }, T);
});

describe.skipIf(!supported)('T6c: the delivered-budget edge with the wrapper (s-296 m-5612)', () => {
  // Quote-heavy text is escaped once in the delivered JSON and again in the helper's message line, and the line is what is charged.
  const QUOTES = text({ roles: [ROLE('"'.repeat(1500))], partial: false, diagnostics: [] });
  const body = okEnvelope(QUOTES);
  const CAUGHT = 'try { const r = await parley.list_roles({}); return r.ok; } catch (e) { return e.message; }';

  it('at the exact line size it is delivered and complete; one byte less it is not, and the operation still succeeded', async () => {
    const measured = await (await setup(tools(() => ({ body })))).run(CAUGHT);
    expect(measured).toMatchObject({ runStatus: 'completed', incomplete: false, outcome: { value: 'true' } });
    const line = measured.ledger!.deliveredBytes;
    expect(measured.ledger!.entries[0]!.deliveredBytes).toBe(line);
    // The cause: each quote costs 2 bytes in the delivered JSON and 4 in its message line, and the line is what is charged.
    expect(line).toBeGreaterThan(4 * 1500);
    expect(Buffer.byteLength(body)).toBeLessThan(line);

    const exact = await (await setup(tools(() => ({ body })))).run(CAUGHT, { responseBytes: line });
    expect(exact).toMatchObject({ runStatus: 'completed', incomplete: false, outcome: { value: 'true' } });
    expect(exact.ledger!.entries[0]).toMatchObject({ state: 'succeeded', deliveryFailure: null, assessment: 'complete' });

    const under = await (await setup(tools(() => ({ body })))).run(CAUGHT, { responseBytes: line - 1 });
    expect(under).toMatchObject({ runStatus: 'completed', incomplete: true, outcome: { value: '"parley: call response not delivered"' } });
    expect(under.ledger!.entries[0]).toMatchObject({ state: 'succeeded', deliveryFailure: 'response-budget', assessment: 'complete' });
    expect(under.evidence[0]).toMatchObject({ outcome: 'succeeded', incomplete: true });
  }, 3 * T);

  it('a script that does not catch the refusal ends in error: this is the quote-heavy `error` below 1 MiB; no kill, still a receipt', async () => {
    const line = (await (await setup(tools(() => ({ body })))).run(CAUGHT)).ledger!.deliveredBytes;
    const r = await (await setup(tools(() => ({ body })))).run('return (await parley.list_roles({})).ok;', { responseBytes: line - 1 });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'error', killedBy: null, cleanup: 'confirmed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', deliveryFailure: 'response-budget' });
  }, 2 * T);

  it('a wrapper larger than the budget while the raw body fits: succeeded, not delivered, incomplete', async () => {
    // Every row gains `unknownFields`, so the delivered JSON outgrows the raw one.
    const many = okEnvelope(text({ roles: [], partial: false, diagnostics: Array.from({ length: 200 }, () => ({ source: 'a', code: 'b' })) }));
    const raw = Buffer.byteLength(many);
    const r = await (await setup(tools(() => ({ body: many })))).run(CAUGHT, { responseBytes: raw + 1 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment: 'partial', responseBytes: raw });
    expect(r.ledger!.entries[0]!.deliveryFailure).not.toBeNull();
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true, outcome: { value: '"parley: call response not delivered"' } });
  }, T);
});

describe.skipIf(!supported)('T6c: the contract is bound to the catalogue, and an unproved read is incomplete', () => {
  const agent = { url: 'http://127.0.0.1:1/agent/browser', token: FIXTURE_TOKEN };

  it('a catalogue promising anything else cannot be run: unknown guarantee, other schema, other adapter', async () => {
    const { B, F, catalog } = await fresh();
    const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
    const output = catalog.entries.find((e) => e.name === 'read_guide')!.output;
    for (const changed of [{ guarantee: 'unknown' }, { ...output, schemaSha256: '0'.repeat(64) }, { ...output, adapterRevision: 'read-adapters@other' }]) {
      const other = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'read_guide' ? { ...e, output: changed as typeof output } : e)) };
      expect(() => B.createBroker({ hold: HOLD(), source: fake.source, catalog: other, launchId: 'launch-1', agent, launch: {} }), JSON.stringify(changed)).toThrow(new B.BrokerError('no-output-contract'));
    }
    expect(() => B.createOutputContract(catalog, ['wait_for'])).toThrow(new B.BrokerError('no-output-contract'));
  });

  it('settle never throws and always carries an assessment, on every path', async () => {
    const { B, catalog } = await fresh();
    const contract = B.createOutputContract(catalog, ['get_map', 'read_guide']);
    const cases: [string, 'ok' | 'error', string, string, string][] = [
      ['decoded', 'ok', 'read_guide', JSON.stringify(text('g')), 'unknown'],
      ['tool error', 'error', 'get_map', JSON.stringify(ERR), 'unknown'],
      ['malformed', 'ok', 'get_map', JSON.stringify(text({ map: 1 })), 'unknown'],
      ['schema refusal', 'ok', 'get_map', JSON.stringify(text({ session: { id: 's', historyCount: 1, artifactCount: 0, history: [1], artifacts: [] } })), 'unknown'],
      ['not strict JSON', 'ok', 'get_map', '{"content":', 'unknown'],
      ['duplicate keys', 'ok', 'get_map', '{"content":[],"content":[]}', 'unknown'],
    ];
    const args: Record<string, unknown> = { decoded: {}, 'tool error': {}, malformed: {}, 'schema refusal': { session: 's' }, 'not strict JSON': {}, 'duplicate keys': {} };
    for (const [name, kind, method, transport, assessment] of cases) {
      const s = contract.settle(method, args[name] as never, kind, transport, 7) as { kind: string; text: string; observedBytes: number; assessment: string };
      expect(s, name).toMatchObject({ kind, observedBytes: 7, assessment });
      expect(() => JSON.parse(s.text), name).not.toThrow();
      expect(Object.isFrozen(s), name).toBe(true);
    }
    expect(JSON.parse((contract.settle('get_map', {} as never, 'ok', '{"content":', 7) as { text: string }).text)).toEqual({ ok: false, error: { kind: 'invalid-output', code: 'result-not-strict-json' } });
    // A fault inside the decoding step is a fixed code too, not a throw: a throw would read as an unknown outcome for a settled call.
    const fault = contract.settle('not_compiled', {} as never, 'ok', JSON.stringify(text('g')), 7) as { kind: string; text: string; assessment: string };
    expect(fault).toMatchObject({ kind: 'ok', assessment: 'unknown' });
    expect(JSON.parse(fault.text)).toEqual({ ok: false, error: { kind: 'invalid-output', code: 'decoder-fault' } });
  });

  it('a settled read with no assessment is incomplete on the broker path, for each receipt; the run floor holds otherwise', async () => {
    const { B } = await fresh();
    const entry = (state: string, assessment: string | null) => ({ state, assessment }) as never;
    const CLEAN = { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 };
    const result = (over: Record<string, unknown>) => ({ runStatus: 'completed', evidence: [], ledger: { entries: [] }, outcome: { unsettled: [], refused: CLEAN }, ...over }) as never;
    for (const state of ['succeeded', 'failed']) {
      expect(B.finalIncomplete(result({ ledger: { entries: [entry(state, null)] } })), `${state} without`).toBe(true);
      expect(B.finalIncomplete(result({ ledger: { entries: [entry(state, 'complete')] } })), `${state} complete`).toBe(false);
    }
    expect(B.finalIncomplete(result({ ledger: { entries: [entry('refused', null)] } }))).toBe(true);
    expect(B.finalIncomplete(result({}))).toBe(false);
    expect(B.finalIncomplete(result({ runStatus: 'error' }))).toBe(true);
    expect(B.finalIncomplete(result({ runStatus: null }))).toBe(true);
    expect(B.finalIncomplete(result({ ledger: null }))).toBe(true);
    expect(B.finalIncomplete(result({ evidence: [{ incomplete: true }] }))).toBe(true);
    // T7a-guest-floor: what the guest refused or dropped without the parent seeing a call.
    for (const key of Object.keys(CLEAN)) expect(B.finalIncomplete(result({ outcome: { unsettled: [], refused: { ...CLEAN, [key]: 1 } } })), key).toBe(true);
    expect(B.finalIncomplete(result({ outcome: { unsettled: [3], refused: CLEAN } }))).toBe(true);
    expect(B.finalIncomplete(result({ outcome: null }))).toBe(true);
  });

  it('a run the broker refuses is incomplete', async () => {
    const { run, broker } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), revokeRoom);
    await (await run(DRAIN)).drained;
    expect(await broker.run('return 1', broker.launch.apiRevision)).toMatchObject({ status: 'unavailable', hostCalls: 0, incomplete: true });
  }, T);
});

describe.skipIf(!supported)('T6c: a refused read raises the floor, whatever the reason (s-296 B1)', () => {
  const SWALLOW = (call: string): string => `const a = await parley.list_roles({}); let b; try { b = await ${call}; } catch (e) { b = 'swallowed: ' + e.message; } return { ok: a.ok, b };`;
  const COMPLETE = { list_roles: VALID['list_roles'], read_room: VALID['read_room'] };

  it('native policy: the first read is complete, the refusal is swallowed, the value returns, and the run is incomplete', async () => {
    const { run, h } = await setup(byMethod(COMPLETE), (q) => (q.method === 'read_room' ? 'deny' : 'allow'));
    const r = await run(SWALLOW('parley.read_room({ room: "r-1" })'));
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: true, b: 'swallowed: parley: not permitted by native policy' });
    expect(r.ledger!.entries.map((e) => [e.state, e.refusal, e.assessment])).toEqual([['succeeded', null, 'complete'], ['refused', 'policy', null]]);
    // Each operation's evidence stays what it was, so nothing but the refusal can have raised this.
    expect(r.evidence.map((e) => [e.dispatched, e.incomplete])).toEqual([[true, false], [false, false]]);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(calls(h).map((b) => b['name'])).toEqual(['list_roles']);
  }, T);

  it('through the real makeExecuteResult the broker\'s claim is what raises it: without the claim the same evidence says complete', async () => {
    const { run, broker, catalog } = await setup(byMethod(COMPLETE), (q) => (q.method === 'read_room' ? 'deny' : 'allow'));
    const r = await run(SWALLOW('parley.read_room({ room: "r-1" })'));
    expect(r.evidence.every((e) => !e.incomplete)).toBe(true);
    const C = (await import(distUrl('mcp/code-mode/contracts.js'))) as typeof ContractsModule;
    const validators = C.compileCallValidators(catalog, broker.launch.apiRevision);
    const input = { runId: r.runId!, status: 'completed' as const, value: 1, operations: r.evidence };
    expect(C.makeExecuteResult(validators, { ...input, incomplete: r.incomplete })).toMatchObject({ status: 'completed', incomplete: true });
    expect(C.makeExecuteResult(validators, input)).toMatchObject({ status: 'completed', incomplete: false });
  }, T);

  it('invalid arguments from the guest: no exception to the rule', async () => {
    const { run, h } = await setup(byMethod(COMPLETE));
    const r = await run(SWALLOW('parley.read_room({ room: 7 })'));
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: true, b: 'swallowed: parley: call refused' });
    expect(r.ledger!.entries.map((e) => [e.state, e.refusal])).toEqual([['succeeded', null], ['refused', 'invalid-arguments']]);
    expect(r.evidence.map((e) => e.incomplete)).toEqual([false, false]);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(calls(h)).toHaveLength(1);
  }, T);

  it('the response budget exhausted: raw bytes used up by a complete read, the next call refused and swallowed', async () => {
    // Host-only envelope padding: charged as raw, never delivered, so the first read itself is delivered whole and complete.
    const body = okEnvelope({ ...(VALID['list_roles'] as object), _meta: { pad: 'p'.repeat(4000) } });
    const { run, h } = await setup(tools(() => ({ body })));
    const r = await run(SWALLOW('parley.read_room({ room: "r-1" })'), { responseBytes: Buffer.byteLength(body) });
    expect(JSON.parse(r.outcome!.value as string)).toEqual({ ok: true, b: 'swallowed: parley: call refused' });
    expect(r.ledger!.entries.map((e) => [e.state, e.refusal, e.deliveryFailure, e.assessment])).toEqual([['succeeded', null, null, 'complete'], ['refused', 'response-budget-exhausted', null, null]]);
    expect(r.evidence.map((e) => e.incomplete)).toEqual([false, false]);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(calls(h)).toHaveLength(1);
  }, T);

  it('unsettled capacity: unknown calls hold it, the next call is refused and swallowed', async () => {
    const { run } = await setup(tools(() => ({ status: 500 })));
    const r = await run(`
      for (let i = 0; i < 2; i++) { try { await parley.list_roles({}); } catch {} }
      try { await parley.read_room({ room: "r-1" }); return "sent"; } catch (e) { return e.message; }
    `);
    expect(r.outcome).toMatchObject({ value: '"parley: capacity held by unresolved calls"' });
    expect(r.ledger!.entries.map((e) => [e.state, e.refusal])).toEqual([['unknown', null], ['unknown', null], ['refused', 'unsettled-capacity']]);
    expect(r.incomplete).toBe(true);
  }, T);
});

describe.skipIf(!supported)('T5b-budget-wedge: a read that cannot be read ends incomplete, not wedged', () => {
  const big = okEnvelope(text('x'.repeat(4000)));
  const CAUGHT = 'try { await parley.read_guide({}); return "read"; } catch (e) { return e.message; }';

  it.each([
    ['our own cap on a 200', { body: big }, 'body-over-cap', { responseBytes: 1000 }],
    ['route-refusal after a complete 200', { body: '{"ok":false,"error":{"code":"internal","message":"x"}}' }, 'route-refusal', {}],
    ['unreadable after a complete 200', { body: 'not json' }, 'unreadable', {}],
    ['invalid-result after a complete 200', { body: okEnvelope({ content: 'text' }) }, 'invalid-result', {}],
  ] as const)('%s: caught gives completed + incomplete, and the next run is not busy', async (_name, reply, why, limits) => {
    const { run, h } = await setup(tools(() => reply));
    const r = await run(CAUGHT, limits);
    expect(r.outcome).toMatchObject({ value: '"parley: call response not delivered"' });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unread', assessment: null, unknownWhy: null });
    // Typed evidence from the transport: only the run budget's own cut says so (the other causes read the same `unread`).
    expect(r.ledger!.entries[0]!.runBudgetCut).toBe(why === 'body-over-cap');
    expect(r.ledger!.entries[0]!.responseBytes).toBeGreaterThan(0);
    expect(r.evidence[0]).toMatchObject({ outcome: 'unread', incomplete: true });
    expect(r.audit[0]).toMatchObject({ outcome: 'unread', why });
    expect(calls(h)).toHaveLength(1);
    await r.drained;
    const next = await run('return 1');
    expect(next).toMatchObject({ status: 'finished', runStatus: 'completed', outcome: { value: '1' } });
  }, 2 * T);

  it('uncaught gives error + incomplete, no kill, and the next run is not busy', async () => {
    const { run } = await setup(tools(() => ({ body: big })));
    const r = await run('return (await parley.read_guide({})).ok;', { responseBytes: 1000 });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'error', killedBy: null, cleanup: 'confirmed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unread' });
    await r.drained;
    expect(await run('return 1')).toMatchObject({ runStatus: 'completed' });
  }, 2 * T);

  it('a cut while draining: the receipt is recorded, nobody is told, and the lease is released', async () => {
    const chunks = Array.from({ length: 20 }, () => 'k'.repeat(1000));
    const { run } = await setup(tools(() => ({ chunks, delayMs: 700 })), revokeRoom);
    const r = await run(DRAIN, { responseBytes: 2000 });
    expect(r).toMatchObject({ status: 'policy', incomplete: true });
    const drained = await r.drained!;
    expect(drained.entries[0]).toMatchObject({ method: 'get_map', state: 'unread' });
    expect(drained.quiescent).toBe(true);
  }, T);

  it.each([
    ['a non-200 over the cap', () => ({ status: 500, body: 'n'.repeat(5000) }), 'status', { responseBytes: 1000 }],
    ['a 401', () => ({ status: 401 }), '401', {}],
  ] as const)('%s stays unknown and holds the lease', async (_name, reply, why, limits) => {
    const { run } = await setup(tools(reply as never));
    const r = await run(CAUGHT, limits);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(r.audit[0]!.outcome).toBe('unknown');
    expect(String(r.audit[0]!.why).startsWith(why === 'status' ? 'body-over-cap' : why)).toBe(true);
    expect(r).toMatchObject({ runStatus: 'partial-or-unknown', incomplete: true });
    expect(await run('return 1')).toMatchObject({ status: 'busy' });
  }, 2 * T);

  it('a socket failure after a 200 and abort during a read stay unknown and hold the lease', async () => {
    const dropped = await setup(tools(() => ({ body: 'y'.repeat(100), drop: { afterBytes: 40 } })));
    const r = await dropped.run(CAUGHT, { wallMs: 1500 });
    expect(r.incomplete).toBe(true);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(await dropped.run('return 1')).toMatchObject({ status: 'busy' });
    const ctl = new AbortController();
    // The abort follows the host's receipt of the call: on a timer, a slow helper start let it beat the call, and then there is no entry.
    const hanging = await setup(tools(() => { setTimeout(() => ctl.abort(), 100); return { hang: true }; }));
    const a = await hanging.run(CAUGHT, {}, ctl.signal);
    expect(a.incomplete).toBe(true);
    expect(a.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(await hanging.run('return 1')).toMatchObject({ status: 'busy' });
  }, 2 * T);

  it('the effect guard: for a method whose catalogue effect is not read, unread stays unknown', async () => {
    const { B, catalog } = await fresh();
    const contract = B.createOutputContract(catalog, ['get_map']);
    expect(contract.unread('get_map', 5)).toEqual({ kind: 'unread', observedBytes: 5 });
    expect(contract.unread('get_map', 5, true)).toEqual({ kind: 'unread', observedBytes: 5, runBudgetCut: true });
    for (const effect of ['write', 'destructive', 'unknown'] as const) {
      const other = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'get_map' ? { ...e, effect } : e)) };
      expect(B.createOutputContract(other, ['get_map']).unread('get_map', 5), effect).toEqual({ kind: 'unknown', observedBytes: 5 });
      // The cut's typed evidence belongs to a terminal `unread` of a read; an `unknown` never carries it.
      expect(B.createOutputContract(other, ['get_map']).unread('get_map', 5, true), effect).toEqual({ kind: 'unknown', observedBytes: 5 });
    }
    expect(contract.unread('not_compiled', 5)).toEqual({ kind: 'unknown', observedBytes: 5 });
  });

  it('a body with no decoded output is never guessed at: nothing but the fixed refusal reaches the guest', async () => {
    const CANARY = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
    const { run } = await setup(tools(() => ({ body: okEnvelope(text(CANARY.repeat(200))) })));
    const r = await run(CAUGHT, { responseBytes: 1000 });
    expect(JSON.stringify({ ...r, drained: null })).not.toContain(CANARY);
  }, T);
});

describe.skipIf(!supported)('the durable run record through the broker (T7a-sleep)', () => {
  const recordOf = (hold: { workDir: string; sessionId: string }): string => path.join(hold.workDir, 'code-mode', `${hold.sessionId}.run`);
  const READ = 'try { await parley.read_guide({}); return "read"; } catch (e) { return e.message; }';
  const RESULT = { content: [{ type: 'text', text: 'guide' }] };
  const tools = (call: () => Awaited<ReturnType<Script>>, onList: () => void = () => {}): Script => (r) => {
    const body = JSON.parse(r.raw) as Record<string, unknown>;
    if (body['op'] === 'list') { onList(); return { body: okEnvelope({ tools: [] }) }; }
    return call();
  };

  it('a missing or bad hold refuses at construction: no broker runs without a record', async () => {
    const { B, F, catalog } = await fresh();
    const base = { source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog, launchId: 'l-1', agent: { url: 'http://127.0.0.1:1', token: 't' }, launch: {} };
    expect(() => B.createBroker(base as never)).toThrow(new B.BrokerError('invalid-hold'));
    for (const hold of [{ workDir: '', sessionId: 's-1' }, { workDir: '/tmp/x', sessionId: '../x' }, {}, null]) expect(() => B.createBroker({ ...base, hold } as never), JSON.stringify(hold)).toThrow(new B.BrokerError('invalid-hold'));
  });

  it('the intent line is on disk when the request arrives, and holds the method and a hash, no raw arguments', async () => {
    const CANARY = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
    const hold = HOLD();
    let seen = '';
    const { run } = await setup(tools(() => { seen = readFileSync(recordOf(hold), 'utf8'); return { body: okEnvelope(RESULT) }; }), () => 'allow', { hold });
    const r = await run(`await parley.get_map({ session: ${JSON.stringify(CANARY.replace(/[^a-z0-9-]/g, ''))} }); return 1;`);
    expect(r.hostCalls).toBe(1);
    const lines = seen.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[1]).toEqual({ o: 1, m: 'get_map', a: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(seen).not.toContain('synthetic');
    expect(seen).not.toContain('sk-ant');
  }, T);

  it('a run that settled: the record is gone once quiescent', async () => {
    const hold = HOLD();
    const { run } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => 'allow', { hold });
    const r = await run(READ);
    expect(r.runStatus).toBe('completed');
    await r.drained;
    expect(existsSync(recordOf(hold))).toBe(false);
  }, T);

  it('an unread run: the record is gone too, the session is not wedged by it', async () => {
    const hold = HOLD();
    const { run } = await setup(tools(() => ({ body: 'not json' })), () => 'allow', { hold });
    const r = await run(READ);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    await r.drained;
    expect(existsSync(recordOf(hold))).toBe(false);
    expect(await run('return 1')).toMatchObject({ runStatus: 'completed' });
  }, T);

  it('a U2 run: the record stays, with the intent and the unknown line, and this process stays busy for its own reason', async () => {
    const hold = HOLD();
    const { run } = await setup(tools(() => ({ status: 500 })), () => 'allow', { hold });
    const r = await run(READ);
    expect(r.runStatus).toBe('partial-or-unknown');
    const text = readFileSync(recordOf(hold), 'utf8');
    expect(text).toContain('"m":"read_guide"');
    expect(text).toContain('"s":"unknown"');
    expect(await run('return 1')).toMatchObject({ status: 'busy', reason: expect.stringContaining('previous run has calls with unknown outcome') });
    expect(existsSync(recordOf(hold))).toBe(true);
  }, T);

  it('a record held by a dead process: no spawn, no call, a named busy reason with no pid; a new launch does not change that', async () => {
    const hold = HOLD();
    mkdirSync(path.dirname(recordOf(hold)), { recursive: true, mode: 0o700 });
    const header = { v: 1, runId: 'run-1-1', launchId: 'other-launch', pid: 999_999, startedAt: null, nonce: 'a'.repeat(32), at: 't' };
    writeFileSync(recordOf(hold), `${JSON.stringify(header)}\n${JSON.stringify({ o: 1, m: 'get_map', a: 'b'.repeat(64) })}\n`);
    const { run, h } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => 'allow', { hold });
    const r = await run(READ);
    expect(r).toMatchObject({ status: 'busy', spawned: false, hostCalls: 0, reason: 'busy: previous process left calls unaccounted (run record)', incomplete: true });
    expect(h.log).toHaveLength(0);
    expect(r.reason).not.toContain('999999');
    expect(existsSync(recordOf(hold))).toBe(true);
  }, T);

  it('a directory that cannot be written: no spawn, no call', async () => {
    const hold = HOLD();
    writeFileSync(path.join(hold.workDir, 'code-mode'), 'a file where the directory should be');
    const { run, h } = await setup(tools(() => ({ body: okEnvelope(RESULT) })), () => 'allow', { hold });
    expect(await run(READ)).toMatchObject({ status: 'busy', spawned: false, reason: 'busy: run record unavailable (run record)' });
    expect(h.log).toHaveLength(0);
  }, T);

  it('an intent that cannot be written: the edge refuses, nothing reaches the host, and the run floors', async () => {
    const hold = HOLD();
    // A real write failure: the record's own descriptor is closed under the store, once the run holds it.
    const closeRecord = (): void => {
      const { ino } = statSync(recordOf(hold));
      for (let fd = 3; fd < 4096; fd++) { try { if (fstatSync(fd).ino === ino) { closeSync(fd); return; } } catch { /* not open */ } }
      throw new Error('record descriptor not found');
    };
    const calls: string[] = [];
    const { run } = await setup(tools(() => { calls.push('call'); return { body: okEnvelope(RESULT) }; }, closeRecord), () => 'allow', { hold });
    const r = await run(READ);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 0, incomplete: true, outcome: { value: expect.stringContaining('parley:') } });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-record' });
  }, T);
});

describe.skipIf(!supported)('T11 B0: the allowlist reaches the guest only through enabled reads', () => {
  const READ = () => ({ body: okEnvelope(RESULT) });
  /** Fresh dist modules: a catalogue module, its tool list and the broker. (Dist modules load natively, so their tables cannot be mocked here.) */
  async function freshParts() {
    const { B, F } = await fresh();
    const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
    const TL = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof CatalogModule.buildCatalog>[0] };
    return { B, F, C, TL };
  }
  const open = async (parts: Awaited<ReturnType<typeof freshParts>>, options: CatalogModule.CatalogOptions, rule: FixtureModule.FixtureRule = () => 'allow') => {
    const h = await host(tools(READ));
    const catalog = parts.C.buildCatalog(parts.TL.TOOLS, options);
    const broker = parts.B.createBroker({ hold: HOLD(), source: parts.F.createFixturePolicySource(parts.F.FIXTURE_HOST, rule).source, catalog, launchId: 'launch-1', agent: h.agent, launch: {} });
    return { h, broker, run: (code: string) => broker.run(code, broker.launch.apiRevision) };
  };

  it('a documented method that is not enabled has no guest stub: not in the launch methods, typeof undefined in the guest, zero requests', async () => {
    const parts = await freshParts();
    const one = await open(parts, { migrated: ['get_map'] });
    expect(one.broker.launch.methods).toEqual(['get_map']);
    const r = await one.run('return [typeof parley.get_map, typeof parley.read_room]');
    expect(r.outcome).toMatchObject({ value: JSON.stringify(['function', 'undefined']) });
    expect(calls(one.h)).toHaveLength(0);
    const none = await open(parts, {});
    expect(none.broker.launch.methods).toEqual([]);
    expect((await none.run('return typeof parley.get_map')).outcome).toMatchObject({ value: '"undefined"' });
    expect(calls(none.h)).toHaveLength(0);
  }, T);

  it('the catalogue allowlist bounds the broker: an enabled read off a narrowed allowlist has no stub, one on it runs once', async () => {
    const parts = await freshParts();
    const narrow = await open(parts, { allowlist: ['get_map', 'read_room'], migrated: ['get_map', 'read_room'] });
    expect(narrow.broker.launch.methods).toEqual(['get_map', 'read_room']);
    const r = await narrow.run('await parley.get_map({}); return typeof parley.read_guide');
    expect(r.outcome).toMatchObject({ value: '"undefined"' });
    expect(calls(narrow.h).map((b) => b['name'])).toEqual(['get_map']);
  }, T);

  it.each(['deny', 'ask', 'unknown', 'stale', 'revoked'] as const)('an enabled allowlisted read under %s dispatches nothing', async (state) => {
    const parts = await freshParts();
    const gated = await open(parts, { migrated: ['get_map'] }, () => state);
    const r = await gated.run('try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }');
    expect(r.hostCalls).toBe(0);
    expect(calls(gated.h)).toHaveLength(0);
  }, T);

  it('an enabled read that a forged catalogue leaves off its allowlist gets no guest stub: the run is bounded by the allowlist, not only by the entries', async () => {
    const { B, F, catalog } = await fresh();
    expect(catalog.entries.find((e) => e.name === 'read_guide')!.migration).toBe('enabled');
    const forged = { ...catalog, allowlist: catalog.allowlist.filter((n) => n !== 'read_guide') };
    const h = await host(tools(READ));
    const broker = B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog: forged, launchId: 'l-1', agent: h.agent, launch: {} });
    const r = await broker.run('await parley.get_map({}); return [typeof parley.get_map, typeof parley.read_guide]', broker.launch.apiRevision);
    expect(r.outcome).toMatchObject({ value: JSON.stringify(['function', 'undefined']) });
    expect(calls(h).map((b) => b['name'])).toEqual(['get_map']);
  }, T);

  it('a write on the allowlist is refused by the broker even when a forged catalogue documents and enables it', async () => {
    const { B, F, catalog } = await fresh();
    const send = catalog.entries.find((e) => e.name === 'get_map')!;
    const forged = { ...catalog, allowlist: [...catalog.allowlist, 'send_message'].sort(), entries: [...catalog.entries.filter((e) => e.name !== 'send_message'), { ...send, name: 'send_message', effect: 'write' as const }].sort((a, b) => (a.name < b.name ? -1 : 1)) };
    expect(() => B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog: forged, launchId: 'l-1', agent: { url: 'http://127.0.0.1:1', token: 't' }, launch: {} })).toThrow(new B.BrokerError('non-read-method'));
  }, T);
});

describe.skipIf(!supported)('T11 R1: memory_read and search_history through the real helper and the real decoders', () => {
  const entry = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: 'fact', fact: `fact ${id}`, details: '', state: 'current', by: 'human', ...extra });
  const hit = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ source: 'memory', title: 'T', excerpt: 'e', date: null, complete: true, length: 1, hash: '0123456789abcdef', ...extra });
  const search = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ query: 'needle', scope: 'all', limit: 10, total: 1, hits: [hit()], unavailable: [], ...extra });
  /** The host answers each call by its method name. */
  const answers = (byMethod: Record<string, unknown>): Script => tools((_n, body) => ({ body: okEnvelope(byMethod[String(body['name'])]) }));
  /** Both T11 reads enabled with the five: the shipped allowlist. */
  async function openR1(script: Script, rule: FixtureModule.FixtureRule = () => 'allow') {
    const { B, F } = await fresh();
    const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
    const TL = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof CatalogModule.buildCatalog>[0] };
    const M = (await import(distUrl('mcp/code-mode/migration-registry.js'))) as { MIGRATABLE_READS: readonly string[] };
    const h = await host(script);
    const catalog = C.buildCatalog(TL.TOOLS, { migrated: [...M.MIGRATABLE_READS] });
    const broker = B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, rule).source, catalog, launchId: 'launch-1', agent: h.agent, launch: {} });
    return { h, catalog, run: (code: string) => broker.run(code, broker.launch.apiRevision) };
  }
  const BOTH = 'const a = await parley.memory_read({}); const b = await parley.search_history({ query: "needle" }); return [a.ok, b.ok]';

  it('both methods are documented, enabled and callable, and a whole answer to each leaves the run complete', async () => {
    const { run, h, catalog } = await openR1(answers({ memory_read: text({ items: [entry('m-001')], total: 1 }), search_history: text(search()) }));
    for (const name of ['memory_read', 'search_history']) expect(catalog.entries.find((e) => e.name === name), name).toMatchObject({ documented: true, migration: 'enabled' });
    const r = await run(BOTH);
    expect(r.outcome).toMatchObject({ value: JSON.stringify([true, true]) });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: false });
    expect(r.ledger!.entries.map((e) => e.assessment)).toEqual(['complete', 'complete']);
    expect(calls(h).map((b) => b['name'])).toEqual(['memory_read', 'search_history']);
  }, T);

  it.each<[string, string, unknown, string]>([
    ['memory_read truncated: true', 'return (await parley.memory_read({})).ok', text({ items: [entry('m-001')], total: 2, truncated: true }), 'partial'],
    ['search_history with an unavailable source', 'return (await parley.search_history({ query: "needle" })).ok', text(search({ unavailable: ['memory'] })), 'partial'],
    ['search_history cut by the limit', 'return (await parley.search_history({ query: "needle", limit: 1 })).ok', text(search({ limit: 1, total: 4 })), 'partial'],
    ['a malformed memory_read', 'return (await parley.memory_read({})).ok', text({ items: [entry('m-001')], total: 5 }), 'unknown'],
    ['a malformed search_history', 'return (await parley.search_history({ query: "needle" })).ok', text(search({ query: 'other' })), 'unknown'],
  ])('%s: the run is incomplete and the receipt carries the expected assessment', async (_name, code, body, assessment) => {
    const method = code.includes('memory_read') ? 'memory_read' : 'search_history';
    const { run } = await openR1(answers({ [method]: body }));
    const r = await run(code);
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: true });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', assessment });
  }, T);

  it('a cut excerpt (complete: false on a hit) stays a typed field of the value and does not make the run incomplete', async () => {
    const { run } = await openR1(answers({ search_history: text(search({ hits: [hit({ complete: false, length: 5000 })] })) }));
    const r = await run('const r = await parley.search_history({ query: "needle" }); return r.ok && r.value.hits[0].complete');
    expect(r.outcome).toMatchObject({ value: 'false' });
    expect(r).toMatchObject({ runStatus: 'completed', incomplete: false });
  }, T);

  it.each(['deny', 'ask', 'unknown', 'stale', 'revoked'] as const)('under policy %s nothing is dispatched for either method', async (state) => {
    const { run, h } = await openR1(answers({ memory_read: text({ items: [], total: 0 }), search_history: text(search()) }), () => state);
    const r = await run('const out = []; for (const f of [() => parley.memory_read({}), () => parley.search_history({ query: "needle" })]) { try { await f(); out.push("sent"); } catch (e) { out.push(e.message); } } return out');
    expect(r.hostCalls).toBe(0);
    expect(calls(h)).toHaveLength(0);
  }, T);

  describe('the 16 KiB final value cap', () => {
    const LIMIT = 16384;
    /** A memory entry whose `fact` is `pad` characters long; the script returns the whole decoded result. */
    const withPad = (pad: number) => answers({ memory_read: text({ items: [entry('m-001', { fact: 'x'.repeat(pad) })], total: 1 }) });
    const SCRIPT = 'return await parley.memory_read({})';
    const sizeOf = (r: { outcome?: { value?: unknown } | null }): number => Buffer.byteLength(String(r.outcome!.value), 'utf8');

    it('exactly 16,384 bytes of final value is delivered; one byte more is the result-size error, and the same content stays reachable through ids slices', async () => {
      const probe = await (await openR1(withPad(100))).run(SCRIPT);
      expect(probe).toMatchObject({ runStatus: 'completed' });
      const pad = 100 + (LIMIT - sizeOf(probe));
      const exact = await (await openR1(withPad(pad))).run(SCRIPT);
      expect(sizeOf(exact)).toBe(LIMIT);
      expect(exact).toMatchObject({ runStatus: 'completed', incomplete: false });
      const over = await (await openR1(withPad(pad + 1))).run(SCRIPT);
      expect(over).toMatchObject({ runStatus: 'error', outcome: { ok: false, error: { kind: 'result-size' } } });
      // The classic answer is far larger than the cap; a script reaches the same entry by a one-id slice and returns only the fact length.
      const big = await openR1(withPad(60_000));
      const sliced = await big.run('const r = await parley.memory_read({ ids: ["m-001"] }); return r.ok ? r.value.items[0].fact.length : -1');
      expect(sliced.outcome).toMatchObject({ value: '60000' });
    }, 4 * T);
  });
});
