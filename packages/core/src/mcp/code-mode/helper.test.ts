// Integration tests for the sandboxed helper (plan T4a). They run the BUILT helper (dist), because the helper process
// executes JavaScript under sandbox-exec: beforeAll rebuilds @parley/core. Fixture probes and forged helpers are
// compiled/written into a temporary directory only; nothing here writes into packages/core/native. Where a required
// tool is missing (cc, sandbox-exec, the product probe), the affected tests are skipped and reported as NOT RUN.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as CatalogModule from './catalog.js';
import type * as ContractsModule from './contracts.js';
import type * as HelperModule from './helper.js';
import type * as ProfileModule from './helper-profile.js';
import type * as SchedulerModule from './scheduler.js';

const coreDir = fileURLToPath(new URL('../../../', import.meta.url));
const distHelper = path.join(coreDir, 'dist/mcp/code-mode/helper.js');
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec');
const hasCc = existsSync('/usr/bin/cc') && spawnSync('/usr/bin/cc', ['--version']).status === 0;
const productProbeBuilt = existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));
if (!supported) console.warn('helper.test: NOT RUN — needs darwin/arm64 with /usr/bin/sandbox-exec');
if (supported && !hasCc) console.warn('helper.test: native fixture tests NOT RUN — /usr/bin/cc unavailable');
if (supported && !productProbeBuilt) console.warn('helper.test: product-path tests NOT RUN — probe not built (node packages/desktop/scripts/build-procinfo-probe.mjs)');

let H: typeof HelperModule;
let P: typeof ProfileModule;
let S: typeof SchedulerModule;
/** The genuine T3b handle and revision, minted by the SAME dist modules the helper uses (handles are module-private). */
let VAL: ContractsModule.CallValidators;
let REV: string;
const distUrl = (rel: string): string => pathToFileURL(path.join(coreDir, 'dist', rel)).href;
type Req = Omit<HelperModule.HelperRequest, 'validators' | 'apiRevision'> & Partial<Pick<HelperModule.HelperRequest, 'validators' | 'apiRevision'>>;
/** A fixture run with the run handle and a fresh scheduler (so a draining run of one test never makes another busy). */
const runW = (loc: HelperModule.HelperLocations, req: Req, scheduler?: SchedulerModule.SessionScheduler) =>
  H.runWith(loc, { validators: VAL, apiRevision: REV, ...req } as HelperModule.HelperRequest, scheduler ?? new S.SessionScheduler());
const runP = (req: Req) => H.runHelper({ validators: VAL, apiRevision: REV, ...req } as HelperModule.HelperRequest);
let tmp: string;
let fixtureNative: string;

const sha = (b: Buffer | string): string => P.sha256(b);
/** Typed fixture host: an authoritative `ok` receipt echoing the method and the exact validated arguments text. */
const echoHost: SchedulerModule.FixtureHost = async (call) => ({ kind: 'ok', text: JSON.stringify({ method: call.method, args: call.argsText }) });

/** A test-built probe directory: the real source, compiled into tmp, signed ad hoc, with a manifest. */
function buildFixtureProbe(dir: string, source = path.join(coreDir, 'native/procinfo-probe.c')): string {
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'procinfo-probe');
  execFileSync('/usr/bin/cc', ['-arch', 'arm64', '-O2', '-o', bin, source], { stdio: 'ignore' });
  execFileSync('/usr/bin/codesign', ['-s', '-', '-f', '-i', 'dev.parley.procinfo-probe', bin], { stdio: 'ignore' });
  writeManifest(dir, {});
  return dir;
}
function writeManifest(dir: string, over: Record<string, unknown>): void {
  const bin = path.join(dir, 'procinfo-probe');
  const m = { v: 1, arch: 'arm64', identifier: 'dev.parley.procinfo-probe', signature: 'adhoc', sourceSha256: H.PROCINFO_SOURCE_SHA256, binarySha256: sha(readFileSync(bin)), compiler: 'fixture', ...over };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
}
/** A fake "probe" compiled from inline C, with a manifest that matches it (the manifest is integrity, not authority). */
function fakeProbe(name: string, cSource: string): string {
  const dir = path.join(tmp, `fake-${name}`);
  mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'fake.c');
  writeFileSync(src, cSource);
  const bin = path.join(dir, 'procinfo-probe');
  execFileSync('/usr/bin/cc', ['-arch', 'arm64', '-o', bin, src], { stdio: 'ignore' });
  rmSync(src);
  writeManifest(dir, {});
  return dir;
}

const FORGED_PRELUDE = `import { createInterface } from 'node:readline';
import net from 'node:net';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const DENIED = { loopbackTcp: 'EPERM', outboundTcp: 'EPERM', loopbackUdp: 'EPERM', outboundUdp: 'EPERM', loopbackTcp6: 'EPERM', loopbackUdp6: 'EPERM', outboundTcp6: 'EPERM', outboundUdp6: 'EPERM', unixSocket: 'EPERM', dnsQuery: 'ECONNREFUSED', systemDns: 'ENOTFOUND', fileRead: 'EPERM', spawn: 'EPERM', spawnNode: 'EPERM' };
const lines = []; let w = null;
createInterface({ input: process.stdin }).on('line', (l) => { lines.push(JSON.parse(l)); if (w) { const f = w; w = null; f(); } });
const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => { w = () => r(lines.shift()); });
const hold = () => new Promise((r) => setTimeout(r, 20000));
`;
/** Locations with a forged helper entry (and optionally another wrapper or probe dir); everything else is the product's. */
function forged(name: string, body: string, over: Partial<HelperModule.HelperLocations> = {}): HelperModule.HelperLocations {
  const file = path.join(tmp, `forged-${name}.mjs`);
  writeFileSync(file, FORGED_PRELUDE + body);
  return { ...H.PRODUCT_LOCATIONS, entry: file, nativeDir: fixtureNative, ...over };
}

beforeAll(async () => {
  if (!supported) return;
  execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir });
  H = (await import(pathToFileURL(distHelper).href)) as typeof HelperModule;
  P = (await import(pathToFileURL(path.join(coreDir, 'dist/mcp/code-mode/helper-profile.js')).href)) as typeof ProfileModule;
  S = (await import(distUrl('mcp/code-mode/scheduler.js'))) as typeof SchedulerModule;
  const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
  const K = (await import(distUrl('mcp/code-mode/contracts.js'))) as typeof ContractsModule;
  const { TOOLS } = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof C.buildCatalog>[0] };
  const catalog = C.buildCatalog(TOOLS);
  REV = K.computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
  VAL = K.compileCallValidators(catalog, REV);
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-t4a-')));
  if (hasCc) fixtureNative = buildFixtureProbe(path.join(tmp, 'native'));
}, 120_000);

afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!supported || !hasCc)('a sandboxed run (fixture probe dir)', () => {
  const run = (code: string, extra: Partial<HelperModule.HelperRequest> = {}, loc?: HelperModule.HelperLocations) =>
    runW(loc ?? { ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative }, { code, methods: ['get_map', 'read_room'], host: echoHost, ...extra });

  it('passes the launch probe and the whole self-test, then relays fixture calls', async () => {
    const r = await run('const a = await parley.get_map({ session: "s-01" }); const b = await parley.read_room({ room: "r-1" }); return [a.method, b.method];');
    expect(r).toMatchObject({ status: 'finished', spawned: true, hostCalls: 2, outcome: { ok: true, value: '["get_map","read_room"]', unsettled: [], disposed: true } });
    expect(r.launch).toMatchObject({ ok: true, reason: null });
    expect(H.judgeSelfTest(r.probes)).toBeNull();
    expect(r.probes).toMatchObject({ loopbackTcp: 'EPERM', outboundTcp6: 'EPERM', outboundUdp6: 'EPERM', unixSocket: 'EPERM', fileRead: 'EPERM', spawn: 'EPERM', spawnNode: 'EPERM', dnsQuery: 'ECONNREFUSED', systemDns: 'ENOTFOUND' });
    expect(Object.keys(r.probes!)).toHaveLength(14);
    expect(r.maxPendingBytes).toBe(0);
    expect(r.listenerHits).toEqual({ tcp: 0, udp: 0, unix: 0 });
    expect(r.ledger!.entries.map((e) => [e.method, e.state])).toEqual([['get_map', 'succeeded'], ['read_room', 'succeeded']]);
    expect(r.runStatus).toBe('completed');
  });

  it('caches the launch proof per profile/probe identity; another probe path runs it again', async () => {
    const a = await run('return 1');
    const b = await run('return 2');
    expect(b.launch).toBe(a.launch);
    const copy = path.join(tmp, 'native-copy');
    cpSync(fixtureNative, copy, { recursive: true });
    const c = await run('return 3', {}, { ...H.PRODUCT_LOCATIONS, nativeDir: copy });
    expect(c.launch).not.toBe(a.launch);
    expect(c.launch).toMatchObject({ ok: true });
    expect(c.launch!.probeProfileSha256).not.toBe(a.launch!.probeProfileSha256);
  });

  it('keeps the parent responsive while the guest spins, then reports the interrupt', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const started = Date.now();
    const r = await run('for (;;) {}', { limits: { activeMs: 500 } });
    clearInterval(timer);
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ status: 'finished', outcome: { ok: false, error: { kind: 'interrupted' }, disposed: true } });
    expect(ticks).toBeGreaterThan(elapsed / 10 / 3);
  });

  it('memory growth inside the sandbox ends the guest, not the parent', async () => {
    const r = await run('const a = []; for (;;) a.push("x".repeat(1 << 20) + a.length);', {});
    expect(['finished', 'crashed']).toContain(r.status);
    expect(r.outcome?.ok ?? false).toBe(false);
    expect(r.hostCalls).toBe(0);
    expect(r.peakRssKb).toBeLessThan(256 * 1024);
  }, 40_000);

  it('a syntax error or static import dispatches nothing', async () => {
    const r = await run('await parley.get_map({}); import fs from "fs";');
    expect(r).toMatchObject({ status: 'finished', hostCalls: 0, outcome: { ok: false, error: { kind: 'syntax' } } });
  });

  it('an aborted signal spawns nothing; an abort during the run kills the helper', async () => {
    const pre = new AbortController();
    pre.abort();
    expect(await run('return 1', { signal: pre.signal })).toMatchObject({ status: 'cancelled', spawned: false, hostCalls: 0 });
    const mid = new AbortController();
    setTimeout(() => mid.abort(), 600);
    const r = await run('for (;;) {}', { signal: mid.signal });
    expect(r).toMatchObject({ status: 'cancelled', killedBy: 'cancel' });
  });

  it('an authoritative host error reaches the guest as a fixed message and the earlier calls stay in the ledger', async () => {
    const r = await run('await parley.get_map({}); try { await parley.read_room({ room: "x" }); } catch (e) { return e.message; }', { host: async (c) => (c.method === 'read_room' ? { kind: 'error' } : { kind: 'ok', text: '{}' }) });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 2, outcome: { ok: true, value: '"parley: call failed"' } });
    expect(r.ledger!.entries.map((e) => e.state)).toEqual(['succeeded', 'failed']);
  });
});

describe.skipIf(!supported || !hasCc)('untrusted helper: refusals and protocol violations', () => {
  const go = (loc: HelperModule.HelperLocations, host: SchedulerModule.FixtureHost = echoHost) => runW(loc, { code: 'return 1', methods: ['get_map'], host });
  const passthrough = (): string => {
    const w = path.join(tmp, 'passthrough-wrapper.sh');
    writeFileSync(w, '#!/bin/sh\n# drops "-p <profile>": runs the helper WITHOUT the sandbox\nshift 2\nexec "$@"\n');
    chmodSync(w, 0o755);
    return w;
  };

  it('the helper gets an empty environment', async () => {
    const r = await go(forged('env', `await next(); send({ t: 'fatal', reason: 'env=' + Object.keys(process.env).length }); await hold();`));
    expect(r).toMatchObject({ status: 'unavailable', hostCalls: 0 });
    expect(r.reason).toContain('env=0');
  });

  const refusals: [string, string, RegExp][] = [
    ['garbage before the self-test', `process.stdout.write('not json\\n'); await hold();`, /malformed helper output/],
    ['exit before the self-test', 'process.exit(3);', /exited before the self-test/],
    ['missing self-test key', `await next(); const p = { ...DENIED }; delete p.spawn; send({ t: 'probed', probes: p }); await hold();`, /malformed self-test report/],
    ['extra self-test key', `await next(); send({ t: 'probed', probes: { ...DENIED, extra: 'EPERM' } }); await hold();`, /malformed self-test report/],
    ['non-string self-test value', `await next(); send({ t: 'probed', probes: { ...DENIED, spawn: 1 } }); await hold();`, /malformed self-test report/],
    ['a socket reported open', `await next(); send({ t: 'probed', probes: { ...DENIED, outboundTcp6: 'CONNECTED' } }); await hold();`, /not denied: outboundTcp6/],
    ['system resolver resolved', `await next(); send({ t: 'probed', probes: { ...DENIED, systemDns: 'RESOLVED' } }); await hold();`, /system resolver not as expected: RESOLVED/],
    ['system resolver with another error', `await next(); send({ t: 'probed', probes: { ...DENIED, systemDns: 'EAI_AGAIN' } }); await hold();`, /system resolver not as expected: EAI_AGAIN/],
    ['c-ares with another error', `await next(); send({ t: 'probed', probes: { ...DENIED, dnsQuery: 'ETIMEOUT' } }); await hold();`, /c-ares DNS not as expected: ETIMEOUT/],
    ['c-ares resolved', `await next(); send({ t: 'probed', probes: { ...DENIED, dnsQuery: 'RESOLVED' } }); await hold();`, /c-ares DNS not as expected: RESOLVED/],
    ['child Node allowed', `await next(); send({ t: 'probed', probes: { ...DENIED, spawnNode: 'EXITED:0' } }); await hold();`, /not denied: spawnNode=EXITED:0/],
    ['rpc before the self-test', `send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); await hold();`, /rpc in phase self-test/],
    ['done before run', `await next(); send({ t: 'probed', probes: DENIED }); send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`, /done in phase checking/],
    ['unknown message type', `await next(); send({ t: 'probed', probes: DENIED }); await next(); send({ t: 'hello' }); await hold();`, /unknown message type/],
  ];
  it.each(refusals)('%s → refused with zero calls', async (_label, body, why) => {
    const r = await go(forged(_label.replace(/\W+/g, '-'), body));
    expect(['unavailable', 'violation']).toContain(r.status);
    expect(r.reason).toMatch(why);
    expect(r.hostCalls).toBe(0);
  });

  const RUNNING = `await next(); send({ t: 'probed', probes: DENIED }); const run = await next();\n`;
  const violations: [string, string, number, RegExp][] = [
    ['unknown method', `send({ t: 'rpc', rid: 1, method: 'report', args: '{}' }); await hold();`, 0, /method not allowed/],
    ['oversized arguments', `send({ t: 'rpc', rid: 1, method: 'get_map', args: 'x'.repeat(65537) }); await hold();`, 0, /arguments too large/],
    ['duplicate rid', `send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); await next(); send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); await hold();`, 1, /duplicate rid/],
    ['third call in flight', `for (const rid of [1, 2, 3]) send({ t: 'rpc', rid, method: 'get_map', args: '{}' }); await hold();`, 2, /too many calls in flight/],
    ['33rd call', `for (let rid = 1; rid <= 33; rid++) { send({ t: 'rpc', rid, method: 'get_map', args: '{}' }); if (rid < 33) await next(); } await hold();`, 32, /call budget exceeded/],
    ['bad rpc shape', `send({ t: 'rpc', rid: -1, method: 'get_map', args: '{}' }); await hold();`, 0, /bad rpc shape/],
    ['bad done', `send({ t: 'done', ok: true, value: 1, rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`, 0, /bad done/],
    ['done: no refused count', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true }); await hold();`, 0, /bad done/],
    ['done: refused not an object', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: 0 }); await hold();`, 0, /bad done/],
    ['done: refused an array', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: [] }); await hold();`, 0, /bad done/],
    ['done: refused with a key missing', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0 } }); await hold();`, 0, /bad done/],
    ['done: refused with an extra key', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0, other: 0 } }); await hold();`, 0, /bad done/],
    ['done: refused negative', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: -1, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`, 0, /bad done/],
    ['done: refused fractional', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0.5, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`, 0, /bad done/],
    ['done: refused a string', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: '1', notSerializable: 0, notParsed: 0 } }); await hold();`, 0, /bad done/],
    ['done: refused with notParsed negative', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: -1 } }); await hold();`, 0, /bad done/],
    ['done: refused not a safe integer', `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 2 ** 53, notParsed: 0 } }); await hold();`, 0, /bad done/],
  ];
  it.each(violations)('%s → violation, at most the counted calls', async (label, body, calls, why) => {
    const hostSlow: SchedulerModule.FixtureHost = async () => { await new Promise((r) => setTimeout(r, label === 'third call in flight' ? 2000 : 0)); return { kind: 'ok', text: '{}' }; };
    const r = await go(forged(label.replace(/\W+/g, '-'), RUNNING + body), hostSlow);
    expect(r.status).toBe('violation');
    expect(r.reason).toMatch(why);
    expect(r.hostCalls).toBe(calls);
    expect(r.killedBy).toBe('violation');
  }, 20_000);

  it('a lying helper is caught by the listeners when the network is really open', async () => {
    const body = `const p = await next(); await new Promise((r) => { const s = net.connect({ port: p.tcpPort, host: '127.0.0.1' }, () => { s.destroy(); r(); }); s.on('error', r); }); send({ t: 'probed', probes: DENIED }); await hold();`;
    const r = await go(forged('liar', body, { wrapper: passthrough() }));
    expect(r).toMatchObject({ status: 'unavailable', hostCalls: 0 });
    expect(r.reason).toMatch(/listener hits/);
    expect(r.listenerHits!.tcp).toBeGreaterThan(0);
  });

  it('the real helper without the sandbox fails its own self-test (unsandboxed contrast, incl. a child Node that runs)', async () => {
    const r = await go({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative, wrapper: passthrough() });
    expect(r).toMatchObject({ status: 'unavailable', hostCalls: 0 });
    expect(r.reason).toMatch(/self-test failed: not denied/);
    expect(r.reason).toMatch(/spawnNode=EXITED:0/);
    expect(r.probes).toMatchObject({ spawnNode: 'EXITED:0', spawn: 'EXITED:0' });
  });

  it('a missing wrapper spawns nothing', async () => {
    expect(await go({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative, wrapper: path.join(tmp, 'no-such-wrapper') })).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0 });
  });

  it('unresolvable QuickJS packages make the run unavailable before spawning', async () => {
    const lonely = path.join(tmp, 'lonely');
    mkdirSync(lonely, { recursive: true });
    copyFileSync(H.PRODUCT_LOCATIONS.guest, path.join(lonely, 'guest.js'));
    const r = await go({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative, guest: path.join(lonely, 'guest.js') });
    expect(r).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0 });
    expect(r.reason).toMatch(/helper not resolvable/);
  });
});

describe.skipIf(!supported)('preflights in another process', () => {
  const runIn = (prefix: string[], script: string): { status: string; reason: string; hostCalls: number } => {
    const code = `const h = await import(${JSON.stringify(pathToFileURL(distHelper).href)}); const C = await import(${JSON.stringify(distUrl('mcp/code-mode/catalog.js'))}); const K = await import(${JSON.stringify(distUrl('mcp/code-mode/contracts.js'))}); const { TOOLS } = await import(${JSON.stringify(distUrl('mcp/tools.js'))}); const cat = C.buildCatalog(TOOLS); const rev = K.computeApiRevision({ catalog: cat, launch: 'fixture-launch-1', policySnapshot: 'unavailable' }); const val = K.compileCallValidators(cat, rev); const r = await h.runWith({ ...h.PRODUCT_LOCATIONS, nativeDir: ${JSON.stringify(fixtureNative ?? '/nonexistent')} }, { code: 'return 1', methods: ['get_map'], host: async () => ({ kind: 'ok', text: '{}' }), validators: val, apiRevision: rev }); process.stdout.write(JSON.stringify({ status: r.status, reason: r.reason, hostCalls: r.hostCalls }));`;
    const out = spawnSync(prefix[0]!, [...prefix.slice(1), ...(script === '' ? [] : [script]), '--input-type=module', '-e', code], { encoding: 'utf8', env: {} });
    return JSON.parse(out.stdout) as { status: string; reason: string; hostCalls: number };
  };

  it('a stack rlimit below 8000 KiB is refused', () => {
    const node = realpathSync(process.execPath);
    const code = `const h = await import(${JSON.stringify(pathToFileURL(distHelper).href)}); const C = await import(${JSON.stringify(distUrl('mcp/code-mode/catalog.js'))}); const K = await import(${JSON.stringify(distUrl('mcp/code-mode/contracts.js'))}); const { TOOLS } = await import(${JSON.stringify(distUrl('mcp/tools.js'))}); const cat = C.buildCatalog(TOOLS); const rev = K.computeApiRevision({ catalog: cat, launch: 'fixture-launch-1', policySnapshot: 'unavailable' }); const val = K.compileCallValidators(cat, rev); const r = await h.runHelper({ code: 'return 1', methods: ['get_map'], host: async () => ({ kind: 'ok', text: '{}' }), validators: val, apiRevision: rev }); process.stdout.write(JSON.stringify({ status: r.status, reason: r.reason, spawned: r.spawned }));`;
    const out = spawnSync('/bin/sh', ['-c', `ulimit -s 4000 && exec "$0" --input-type=module -e "$1"`, node, code], { encoding: 'utf8', env: {} });
    expect(JSON.parse(out.stdout)).toEqual({ status: 'unavailable', reason: 'stack rlimit 4000 KiB < 8000 KiB', spawned: false });
  });

  it.skipIf(!hasCc)('inside another sandbox the run is unavailable, never unsandboxed', () => {
    const r = runIn(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', realpathSync(process.execPath)], '');
    expect(r.status).toBe('unavailable');
    expect(r.hostCalls).toBe(0);
  });

  it('an x64 process is refused even though the arm64 probe ships', async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'arch')!;
    Object.defineProperty(process, 'arch', { value: 'x64' });
    try {
      expect(await runP({ code: 'return 1', methods: ['get_map'], host: echoHost })).toMatchObject({ status: 'unavailable', reason: 'unsupported platform darwin/x64', spawned: false });
      expect(await H.checkLaunchProof()).toEqual({ ok: false, reason: 'unsupported platform darwin/x64' });
    } finally {
      Object.defineProperty(process, 'arch', desc);
    }
  });
});

describe.skipIf(!supported || !hasCc)('native launch probe', () => {
  const go = (nativeDir: string) => runW({ ...H.PRODUCT_LOCATIONS, nativeDir }, { code: 'return 1', methods: ['get_map'], host: echoHost });

  it('a missing probe directory is "not built": unavailable, nothing spawned', async () => {
    const r = await go(path.join(tmp, 'never-built'));
    expect(r).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0, reason: 'launch probe: native probe not built' });
  });

  it('manifest and binary mismatches are refused before running anything', async () => {
    const tampered = path.join(tmp, 'tampered');
    cpSync(fixtureNative, tampered, { recursive: true });
    writeFileSync(path.join(tampered, 'procinfo-probe'), Buffer.concat([readFileSync(path.join(tampered, 'procinfo-probe')), Buffer.from([0])]));
    expect((await go(tampered)).reason).toBe('launch probe: native probe hash mismatch');
    const otherSource = path.join(tmp, 'other-source');
    cpSync(fixtureNative, otherSource, { recursive: true });
    writeManifest(otherSource, { sourceSha256: '0'.repeat(64) });
    expect((await go(otherSource)).reason).toBe('launch probe: native probe built from another source');
    const extra = path.join(tmp, 'extra-key');
    cpSync(fixtureNative, extra, { recursive: true });
    writeManifest(extra, { note: 'x' });
    expect((await go(extra)).reason).toBe('launch probe: native probe manifest malformed');
    const x64 = path.join(tmp, 'x64-manifest');
    cpSync(fixtureNative, x64, { recursive: true });
    writeManifest(x64, { arch: 'x86_64' });
    expect((await go(x64)).reason).toBe('launch probe: native probe manifest malformed');
  });

  const fakes: [string, string, RegExp][] = [
    ['prints nothing', 'int main(void){return 0;}', /did not start/],
    ['crashes after starting', '#include <stdio.h>\n#include <stdlib.h>\nint main(void){puts("PARLEY_PROCINFO_PROBE_STARTED 1");fflush(stdout);abort();}', /native probe failed/],
    ['reports READ', '#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(int c,char**v){puts("PARLEY_PROCINFO_PROBE_STARTED 1");printf("{\\"v\\":1,\\"target\\":%s,\\"ppid\\":%d,\\"kinfo\\":{\\"errno\\":0,\\"read\\":true},\\"procargs2\\":{\\"errno\\":0,\\"read\\":true,\\"marker\\":true}}\\n",v[1],(int)getppid());return 0;}', /foreign kinfo_proc not denied \(errno 0\)/],
    ['reports another errno', '#include <stdio.h>\n#include <unistd.h>\nint main(int c,char**v){puts("PARLEY_PROCINFO_PROBE_STARTED 1");printf("{\\"v\\":1,\\"target\\":%s,\\"ppid\\":%d,\\"kinfo\\":{\\"errno\\":1,\\"read\\":false},\\"procargs2\\":{\\"errno\\":22,\\"read\\":false,\\"marker\\":false}}\\n",v[1],(int)getppid());return 0;}', /KERN_PROCARGS2 not denied \(errno 22\)/],
    ['reports a kinfo errno other than EPERM', '#include <stdio.h>\n#include <unistd.h>\nint main(int c,char**v){puts("PARLEY_PROCINFO_PROBE_STARTED 1");printf("{\\"v\\":1,\\"target\\":%s,\\"ppid\\":%d,\\"kinfo\\":{\\"errno\\":22,\\"read\\":false},\\"procargs2\\":{\\"errno\\":1,\\"read\\":false,\\"marker\\":false}}\\n",v[1],(int)getppid());return 0;}', /foreign kinfo_proc not denied \(errno 22\)/],
    ['reports another parent', '#include <stdio.h>\nint main(int c,char**v){puts("PARLEY_PROCINFO_PROBE_STARTED 1");printf("{\\"v\\":1,\\"target\\":%s,\\"ppid\\":1,\\"kinfo\\":{\\"errno\\":1,\\"read\\":false},\\"procargs2\\":{\\"errno\\":1,\\"read\\":false,\\"marker\\":false}}\\n",v[1]);return 0;}', /synthetic parent/],
    ['reports extra fields', '#include <stdio.h>\n#include <unistd.h>\nint main(int c,char**v){puts("PARLEY_PROCINFO_PROBE_STARTED 1");printf("{\\"v\\":1,\\"x\\":0,\\"target\\":%s,\\"ppid\\":%d,\\"kinfo\\":{\\"errno\\":1,\\"read\\":false},\\"procargs2\\":{\\"errno\\":1,\\"read\\":false,\\"marker\\":false}}\\n",v[1],(int)getppid());return 0;}', /malformed/],
  ];
  it.each(fakes)('a probe that %s makes Code Mode unavailable with zero calls', async (label, c, why) => {
    const r = await go(fakeProbe(label.replace(/\W+/g, '-'), c));
    expect(r).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0 });
    expect(r.reason).toMatch(why);
  });

  it('positive control (fixture only): removing the two process-info lines lets the probe READ the synthetic parent', async () => {
    const paths = H.resolveProfilePaths(H.PRODUCT_LOCATIONS);
    const bin = realpathSync(path.join(fixtureNative, 'procinfo-probe'));
    const probe = P.renderProbeProfile(paths, bin);
    const control = probe.split('\n').filter((l) => !P.PROCESS_INFO_LINES.includes(l)).join('\n');
    expect(probe.split('\n').length - control.split('\n').length).toBe(2);
    const denied = await H.runLaunchProbe(bin, probe);
    expect(denied.reason).toBeNull();
    expect(denied.report).toMatchObject({ kinfo: { errno: 1, read: false }, procargs2: { errno: 1, read: false, marker: false } });
    const read = await H.runLaunchProbe(bin, control);
    expect(read.reason).toMatch(/not denied \(errno 0\)/);
    expect(read.report).toMatchObject({ kinfo: { errno: 0, read: true }, procargs2: { errno: 0, read: true, marker: true } });
    expect(read.report!.ppid).toBe(read.report!.target);
  });
});

describe.skipIf(!supported || !productProbeBuilt)('product locations (requires the built probe)', () => {
  it('resolves the package-relative probe, passes the launch proof and runs', async () => {
    expect(H.PRODUCT_LOCATIONS.nativeDir).toBe(path.join(coreDir, 'native/darwin-arm64'));
    const proof = await H.checkLaunchProof();
    expect(proof).toMatchObject({ ok: true, reason: null });
    const r = await runP({ code: 'return await parley.get_map({})', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', hostCalls: 1, outcome: { ok: true } });
  });
});

describe.skipIf(!supported)('source pin', () => {
  it('equals the tracked probe source', () => {
    expect(sha(readFileSync(path.join(coreDir, 'native/procinfo-probe.c')))).toBe(H.PROCINFO_SOURCE_SHA256);
  });
});

// ----- T4a r2 (s-292 m-4060/m-4063/m-4066, s-294 m-4067, lead m-4068/m-4069) -----

const groupMembers = (pgid: number): string => spawnSync('/bin/ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8', env: {} }).stdout.trim();
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!supported || !hasCc)('F1: the launch probe owns and cleans its process group', () => {
  const probeFor = (dir: string): { bin: string; profile: string } => {
    const bin = realpathSync(path.join(dir, 'procinfo-probe'));
    return { bin, profile: P.renderProbeProfile(H.resolveProfilePaths(H.PRODUCT_LOCATIONS), bin) };
  };

  it('a normal proof passes and leaves nothing in its group', async () => {
    const { bin, profile } = probeFor(fixtureNative);
    const r = await H.runLaunchProbe(bin, profile);
    expect(r).toMatchObject({ reason: null, transient: false });
    await settle(100);
    expect(groupMembers(r.pgid!)).toBe('');
  });

  it('a probe that never answers times out, its whole group is killed, and the timeout is not cached', async () => {
    const dir = fakeProbe('sleeps', '#include <stdio.h>\n#include <unistd.h>\nint main(void){puts("PARLEY_PROCINFO_PROBE_STARTED 1");fflush(stdout);sleep(120);return 0;}');
    const { bin, profile } = probeFor(dir);
    const r = await H.runLaunchProbe(bin, profile);
    expect(r).toMatchObject({ reason: 'native probe timed out', transient: true });
    await settle(200);
    expect(groupMembers(r.pgid!)).toBe('');
    // The owned group really held the probe: no process runs this test's unique fixture binary any more.
    const running = spawnSync('/bin/ps', ['-A', '-o', 'command='], { encoding: 'utf8', env: {} }).stdout.split('\n').filter((l) => l.includes(bin));
    expect(running).toEqual([]);
    // Through the run: unavailable, nothing spawned, and the second run tries the probe again (no cached timeout).
    const a = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: dir }, { code: 'return 1', methods: ['get_map'], host: echoHost });
    const b = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: dir }, { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(a).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0, reason: 'launch probe: native probe timed out' });
    expect(b.launch).not.toBe(a.launch);
    expect(b.launch!.costMs).toBeGreaterThanOrEqual(9000);
  }, 60_000);

  it('a probe that cannot start is refused and its group is gone', async () => {
    const dir = path.join(tmp, 'not-executable');
    cpSync(fixtureNative, dir, { recursive: true });
    chmodSync(path.join(dir, 'procinfo-probe'), 0o644);
    const { bin, profile } = probeFor(dir);
    const r = await H.runLaunchProbe(bin, profile);
    expect(r.reason).toMatch(/did not start|failed/);
    await settle(100);
    expect(groupMembers(r.pgid!)).toBe('');
  });
});

describe.skipIf(!supported || !hasCc)('F2: helper output is framed with a byte cap', () => {
  const MIB = 1024 * 1024;
  const go = (name: string, body: string) => runW(forged(name, body), { code: 'return 1', methods: ['get_map'], host: echoHost });

  it('2 MiB without a newline before the self-test is refused once the cap is crossed, never parsed', async () => {
    const r = await go('flood-early', `const big = Buffer.alloc(${2 * MIB}, 0x61); process.stdout.write(big); await hold();`);
    expect(r).toMatchObject({ status: 'unavailable', hostCalls: 0, reason: 'helper output line too long' });
    expect(r.maxPendingBytes).toBeGreaterThan(MIB);
    expect(r.maxPendingBytes).toBeLessThanOrEqual(MIB + 64 * 1024);
  });

  it('the same flood while running is a violation and the helper is killed', async () => {
    const r = await go('flood-running', `await next(); send({ t: 'probed', probes: DENIED }); await next(); process.stdout.write(Buffer.alloc(${2 * MIB}, 0x61)); await hold();`);
    expect(r).toMatchObject({ status: 'violation', hostCalls: 0, reason: 'helper output line too long', killedBy: 'violation' });
    expect(r.maxPendingBytes).toBeLessThanOrEqual(MIB + 64 * 1024);
  });

  it('one complete line over the cap is refused before JSON.parse', async () => {
    const r = await go('long-line', `process.stdout.write('{"t":"x","pad":"' + 'a'.repeat(${MIB}) + '"}\\n'); await hold();`);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'helper output line too long', hostCalls: 0 });
  });

  it('lines split across many small chunks are reassembled exactly', async () => {
    const body = `const p = await next(); const text = JSON.stringify({ t: 'probed', probes: DENIED }) + '\\n';
for (const ch of text) { process.stdout.write(ch); await new Promise((r) => setImmediate(r)); }
const run = await next(); send({ t: 'done', ok: true, value: '7', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`;
    const started = Date.now();
    const r = await go('dribble', body);
    expect(r).toMatchObject({ status: 'finished', outcome: { ok: true, value: '7' }, killedBy: 'post-done' });
    // A helper that lingers after `done` is killed after the 1 s grace, not at the 45 s wall.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe.skipIf(!supported || !hasCc)('F3: an abort at any point of the setup is observed', () => {
  /** A signal that turns aborted on its n-th read and never fires its event: an abort the listener could only miss. */
  const lateSignal = (n: number): AbortSignal => {
    let reads = 0;
    return { get aborted() { reads++; return reads >= n; }, addEventListener() { /* never fires */ }, removeEventListener() { /* nothing */ } } as unknown as AbortSignal;
  };
  it.each([
    ['right after the abort listener was registered (2nd read)', 2],
  ])('an abort that lands %s and never fires an event is still observed', async (_label, n) => {
    const r = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative }, { code: 'return await parley.get_map({})', methods: ['get_map'], host: echoHost, signal: lateSignal(n) });
    expect(r).toMatchObject({ status: 'cancelled', hostCalls: 0 });
  });

  it.each([0, 1, 5, 20, 60, 150])('abort after %i ms → cancelled with zero host calls', async (delay) => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), delay);
    const r = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative }, { code: 'return await parley.get_map({})', methods: ['get_map'], host: echoHost, signal: ctl.signal });
    expect(r.status).toBe('cancelled');
    expect(r.hostCalls).toBe(0);
  });
});

describe.skipIf(!supported || !hasCc)('F5: the RSS watchdog fails closed', () => {
  const psScript = (name: string, body: string): string => {
    const file = path.join(tmp, `ps-${name}.sh`);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const go = (ps: string, code = 'return 1', limits: NonNullable<HelperModule.HelperRequest['limits']> = {}) =>
    runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative, ps }, { code, methods: ['get_map'], host: echoHost, limits });

  it.each([
    ['fails', 'exit 1'],
    ['prints garbage', 'echo not-a-number'],
    ['prints nothing', 'exit 0'],
  ])('a sampler that %s makes the run unavailable before the script is sent', async (_label, body) => {
    const r = await go(psScript(_label.replace(/\W+/g, '-'), body));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'RSS watchdog unavailable', hostCalls: 0 });
    expect(r.outcome).toBeNull();
  });

  it('a sampler that stops working during the run stops the run', async () => {
    const counter = path.join(tmp, 'ps-count');
    writeFileSync(counter, '0');
    const ps = psScript('stops', `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'; [ "$n" -le 4 ] && { echo 1000; exit 0; }; exit 1`);
    const r = await go(ps, 'for (;;) {}');
    expect(r).toMatchObject({ status: 'violation', reason: 'RSS watchdog unavailable', killedBy: 'rss-sampler' });
  });
});

describe.skipIf(!supported || !hasCc)('F6: the 48 MiB / 128 KiB physical maxima cannot be raised', () => {
  const go = (limits: Record<string, unknown>) => runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative }, { code: 'return 1', methods: ['get_map'], host: echoHost, limits: limits as never });

  it.each([
    ['memory 64 MiB', { memoryBytes: 64 * 1024 * 1024 }, /memoryBytes above its maximum 50331648/],
    ['memory 2 GiB', { memoryBytes: 32768 * 65536 }, /memoryBytes above its maximum 50331648/],
    ['stack 256 KiB', { stackBytes: 256 * 1024 }, /stackBytes above its maximum 131072/],
    ['memory not whole pages', { memoryBytes: 20 * 1024 * 1024 + 1 }, /whole WASM pages/],
    ['memory below 16 MiB', { memoryBytes: 8 * 1024 * 1024 }, /at least 16 MiB/],
    ['fractional', { stackBytes: 1.5 }, /positive safe integer/],
    ['NaN', { activeMs: Number.NaN }, /limits are not plain JSON \(number\)/],
    ['negative', { maxRpcs: -1 }, /positive safe integer/],
    ['a string', { wallMs: '1000' }, /positive safe integer/],
    ['an unknown key', { extra: 1 }, /unknown limit extra/],
  ])('%s → unavailable before anything is spawned', async (_label, limits, why) => {
    const r = await go(limits);
    expect(r).toMatchObject({ status: 'unavailable', spawned: false, hostCalls: 0 });
    expect(r.reason).toMatch(why);
  });

  it('lower values within the maxima are accepted', async () => {
    const r = await go({ memoryBytes: 16 * 1024 * 1024, stackBytes: 64 * 1024 });
    expect(r).toMatchObject({ status: 'finished', outcome: { ok: true, value: '1' } });
  });

  it('the helper entry refuses over-maximum limits on its own, before allocating', async () => {
    // A parent stand-in that skips the parent's own check: real helper-entry, real profile, real sandbox.
    const paths = H.resolveProfilePaths(H.PRODUCT_LOCATIONS);
    const profile = P.renderHelperProfile(paths);
    const grants = [paths.helper, paths.probes, paths.qjsCore, paths.qjsSync, paths.qjsFfi, ...paths.links].map((p) => `--allow-fs-read=${p}`);
    const { spawn } = await import('node:child_process');
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, paths.node, '--permission', ...grants, '--allow-child-process', ...H.HELPER_NODE_FLAGS, paths.helper], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, cwd: '/' });
    const closed = new Promise((r) => child.on('close', r));
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const lines = async (n: number): Promise<string[]> => { while (out.split('\n').length <= n) await settle(20); return out.split('\n'); };
    child.stdin.write(`${JSON.stringify({ t: 'probe', tcpPort: 9, udpPort: 9, tcp6Port: 9, udp6Port: 9, unixPath: '/nonexistent', secretFile: '/nonexistent' })}\n`);
    await lines(1);
    const limits = { codeBytes: 32768, activeMs: 1000, wallMs: 30000, memoryBytes: 64 * 1024 * 1024, stackBytes: 128 * 1024, maxRpcs: 32, maxInFlight: 2, argBytes: 65536, responseBytes: 1 << 20, resultBytes: 16384 };
    child.stdin.write(`${JSON.stringify({ t: 'run', code: 'return 1', methods: ['get_map'], limits })}\n`);
    const all = await lines(2);
    await closed;
    expect(JSON.parse(all[1]!)).toEqual({ t: 'fatal', reason: 'malformed-ipc' });
  }, 20_000);
});

describe('W2: runWith and its locations seam are reachable from tests only', () => {
  it('no non-test source in the repository references runWith, HelperLocations or a non-product location set', () => {
    const repo = path.resolve(coreDir, '../..');
    const out = spawnSync('git', ['grep', '-l', '-E', '\\b(runWith|HelperLocations)\\b', '--', 'packages/*/src', 'packages/*/scripts', 'scripts'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages/*/src'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter((f) => /\b(runWith|HelperLocations)\b/.test(readFileSync(path.join(repo, f), 'utf8')));
    const offenders = [...new Set([...out, ...untracked])].filter((f) => !/\.test\.tsx?$/.test(f) && f !== 'packages/core/src/mcp/code-mode/helper.ts');
    expect(offenders).toEqual([]);
  });

  it('a scheduler other than the process one can only be injected from tests', () => {
    const repo = path.resolve(coreDir, '../..');
    const files = spawnSync('git', ['grep', '-l', '-E', 'new SessionScheduler\\(|SessionScheduler\\b', '--', 'packages/*/src'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages/*/src'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter((f) => /SessionScheduler\b/.test(readFileSync(path.join(repo, f), 'utf8')));
    const offenders = [...new Set([...files, ...untracked])].filter((f) => !/\.test\.tsx?$/.test(f) && !['packages/core/src/mcp/code-mode/scheduler.ts', 'packages/core/src/mcp/code-mode/helper.ts'].includes(f));
    expect(offenders).toEqual([]);
    const helperSrc = readFileSync(new URL('helper.ts', import.meta.url), 'utf8');
    expect(helperSrc.match(/new SessionScheduler\(/g) ?? []).toEqual([]);
  });

  it('inside helper.ts, runWith is called only by runHelper with PRODUCT_LOCATIONS', () => {
    const src = readFileSync(new URL('helper.ts', import.meta.url), 'utf8');
    const calls = src.match(/\brunWith\(/g) ?? [];
    expect(calls).toHaveLength(2); // the definition and the one call
    expect(src).toContain('return runWith(PRODUCT_LOCATIONS, request);');
  });
});

// ----- T4a r3 (s-292 m-4080 A1–A3, lead m-4083 A4) -----

const SLEEPER = '#include <stdio.h>\n#include <unistd.h>\nint main(void){puts("PARLEY_PROCINFO_PROBE_STARTED 1");fflush(stdout);sleep(120);return 0;}';

describe.skipIf(!supported || !hasCc)('A1: an abort during the launch probe', () => {
  it('kills the owned group promptly and reports cancelled', async () => {
    const dir = fakeProbe('sleeps-a1', SLEEPER);
    const bin = realpathSync(path.join(dir, 'procinfo-probe'));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const started = Date.now();
    const r = await H.runLaunchProbe(bin, P.renderProbeProfile(H.resolveProfilePaths(H.PRODUCT_LOCATIONS), bin), ctl.signal);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ reason: 'cancelled', cancelled: true, transient: true });
    await settle(200);
    expect(groupMembers(r.pgid!)).toBe('');
    expect(spawnSync('/bin/ps', ['-A', '-o', 'command='], { encoding: 'utf8', env: {} }).stdout.split('\n').filter((l) => l.includes(bin))).toEqual([]);
  });

  it('through the run: cancelled, not unavailable, and a cancellation is never cached as a verdict', async () => {
    const dir = fakeProbe('sleeps-a1-run', SLEEPER);
    const go = async (abortAfter: number) => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), abortAfter);
      const started = Date.now();
      const r = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: dir }, { code: 'return 1', methods: ['get_map'], host: echoHost, signal: ctl.signal });
      return { r, elapsed: Date.now() - started };
    };
    const a = await go(200);
    expect(a.r).toMatchObject({ status: 'cancelled', spawned: false, hostCalls: 0 });
    expect(a.elapsed).toBeLessThan(3000);
    // Had the first cancellation been cached, this run would return `unavailable` at once; instead the probe runs again.
    const b = await go(300);
    expect(b.r).toMatchObject({ status: 'cancelled', hostCalls: 0 });
    expect(b.elapsed).toBeGreaterThanOrEqual(250);
  });

  it('an already-aborted signal starts no probe at all', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await H.runLaunchProbe('/nonexistent', '(version 1)', ctl.signal);
    expect(r).toEqual({ reason: 'cancelled', report: null, transient: true, cancelled: true, pgid: null });
  });
});

describe.skipIf(!supported || !hasCc)('A2: a cleanup failure is never reported as a cancellation', () => {
  /** process.kill that really kills owned groups (nothing leaks) but then reports EPERM, as an undeletable group would. */
  const withFailingGroupKill = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0) {
        try { original(pid, signal); } catch { /* already gone */ }
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return original(pid, signal);
    }) as typeof process.kill;
    try { return await fn(); } finally { process.kill = original; }
  };

  it('an abort whose group kill fails ends the probe as "probe cleanup failed", not cancelled', async () => {
    const dir = fakeProbe('sleeps-a2', SLEEPER);
    const bin = realpathSync(path.join(dir, 'procinfo-probe'));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const r = await withFailingGroupKill(() => H.runLaunchProbe(bin, P.renderProbeProfile(H.resolveProfilePaths(H.PRODUCT_LOCATIONS), bin), ctl.signal));
    expect(r).toMatchObject({ reason: H.PROBE_CLEANUP_FAILED, cancelled: false, transient: false });
    await settle(200);
    expect(groupMembers(r.pgid!)).toBe('');
  });

  it('through the run: unavailable with the cleanup reason even though the signal is aborted', async () => {
    const dir = fakeProbe('sleeps-a2-run', SLEEPER);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const sched = new S.SessionScheduler();
    const r = await withFailingGroupKill(() => runW({ ...H.PRODUCT_LOCATIONS, nativeDir: dir }, { code: 'return 1', methods: ['get_map'], host: echoHost, signal: ctl.signal }, sched));
    expect(ctl.signal.aborted).toBe(true);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'launch probe: probe cleanup failed', spawned: false, hostCalls: 0 });
    expect(r.launch).toMatchObject({ ok: false, reason: H.PROBE_CLEANUP_FAILED });
    // T4b: a probe group whose cleanup is unknown never lets the session lease go.
    await settle(50);
    expect(r.ledger).toMatchObject({ cleanupUnknown: true, quiescent: false });
    expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run cleanup unknown/) });
  });
});

describe.skipIf(!supported)('A2: only ESRCH counts as a clean group', () => {
  it('classifies kill results: gone (ESRCH), killed, and failed for any other error', () => {
    const exited = spawnSync('/usr/bin/true').pid;
    expect(H.killOwnedGroup(exited)).toBe('gone');
    expect(H.killOwnedGroup(undefined)).toBe('gone');
    // Never a broadcast or a kill of launchd's group.
    expect(H.killOwnedGroup(1, 0)).toBe('gone');
    expect(H.killOwnedGroup(0, 0)).toBe('gone');
    expect(H.killOwnedGroup(-5, 0)).toBe('gone');
    // A live group we own: signal 0 succeeds (`killed`), then it is really killed and is `gone` afterwards.
    // Signal 0 to a root-owned group only checks permission: EPERM must be `failed`, never "nothing left".
    const rootGroup = spawnSync('/bin/ps', ['-axo', 'pgid=,user='], { encoding: 'utf8', env: {} }).stdout.split('\n').map((l) => l.trim().split(/\s+/)).find(([g, u]) => u === 'root' && Number(g) > 1);
    expect(rootGroup).toBeDefined();
    expect(H.killOwnedGroup(Number(rootGroup![0]), 0)).toBe('failed:EPERM');
  });

  it('a live owned group is killed, then gone', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    await settle(50);
    expect(H.killOwnedGroup(child.pid, 0)).toBe('killed');
    expect(H.killOwnedGroup(child.pid)).toBe('killed');
    await new Promise((r) => child.on('exit', r));
    expect(H.killOwnedGroup(child.pid)).toBe('gone');
  });
});

describe.skipIf(!supported || !hasCc)('A3: the RSS gate refuses a helper already over the soft limit', () => {
  it('a first valid sample above 256 MiB refuses the run before the script is sent', async () => {
    const ps = path.join(tmp, 'ps-over-limit.sh');
    writeFileSync(ps, '#!/bin/sh\necho 300000\n');
    chmodSync(ps, 0o755);
    const r = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative, ps }, { code: 'return await parley.get_map({})', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'unavailable', hostCalls: 0, outcome: null });
    expect(r.reason).toMatch(/soft RSS/);
  });
});

describe.skipIf(!supported || !hasCc)('A4: the run uses owned snapshots of the request', () => {
  it('changes to the caller code, methods and limits after the call do not reach the helper', async () => {
    const request = {
      code: 'const t = Date.now(); while (Date.now() - t < 150) {} return [typeof parley.report, Object.keys(parley)];',
      methods: ['get_map'],
      host: echoHost,
      limits: { activeMs: 900 } as Record<string, number>,
    };
    const pending = runW({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative }, request as unknown as HelperModule.HelperRequest);
    request.code = 'return "replaced"';
    request.methods.push('report');
    request.limits.activeMs = 1;
    request.limits.memoryBytes = 64 * 1024 * 1024;
    request.limits.stackBytes = 256 * 1024;
    const r = await pending;
    expect(r).toMatchObject({ status: 'finished', outcome: { ok: true, value: '["undefined",["get_map"]]' } });
  });
});


// ----- T4b: lease, ledger, total wall, typed settlement, budgets (lead m-4110/m-4111/m-4120/m-4121/m-4131/m-4136) -----

const SECRET_T4B = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';

/** A host whose calls stay pending until the test settles them; it records each call and its cancel signal. */
function controlledHost() {
  const calls: { call: SchedulerModule.HostCall; cancel: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const host: SchedulerModule.FixtureHost = (call, cancel) => new Promise((resolve, reject) => { calls.push({ call, cancel, resolve: resolve as (v: unknown) => void, reject }); });
  return { host, calls };
}
const until = async (cond: () => boolean, ms = 5000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };
const fixtureLoc = (): HelperModule.HelperLocations => ({ ...H.PRODUCT_LOCATIONS, nativeDir: fixtureNative });

describe.skipIf(!supported || !hasCc)('T4b: one run per session (lease)', () => {
  it('a concurrent second run is refused at once with busy, never queued', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const first = runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host }, sched);
    const started = Date.now();
    const second = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched);
    expect(Date.now() - started).toBeLessThan(200);
    expect(second).toMatchObject({ status: 'busy', spawned: false, hostCalls: 0 });
    expect(second.reason).toMatch(/^busy: a run is active \(run-/);
    await until(() => h.calls.length === 1);
    h.calls[0]!.resolve({ kind: 'ok', text: '{"n":1}' });
    expect(await first).toMatchObject({ status: 'finished', runStatus: 'completed' });
    await (await first).drained;
    expect(sched.holder).toBeNull();
  });

  it('a call the host never settles keeps the lease as draining after the wall; its late receipt releases it', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const r = await runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, limits: { wallMs: 2500 } }, sched);
    expect(r.status === 'wall-time' || r.status === 'finished').toBe(true);
    expect(r.runStatus).toBe('partial-or-unknown');
    expect(r.ledger).toMatchObject({ draining: 1, quiescent: false });
    expect(r.evidence).toMatchObject([{ ordinal: 1, method: 'get_map', dispatched: true, outcome: 'draining', incomplete: true }]);
    expect(h.calls[0]!.cancel.aborted).toBe(true);
    const busy = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched);
    expect(busy).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run (draining|cleanup pending) \(/) });
    // A late authoritative receipt settles it monotonically and the lease goes.
    h.calls[0]!.resolve({ kind: 'ok', text: '{}' });
    const final = await r.drained!;
    expect(final).toMatchObject({ quiescent: true, entries: [{ state: 'succeeded', delivered: false }] });
    expect(sched.holder).toBeNull();
  }, 20_000);

  it('a rejected host call is unknown: the lease stays (U2), busy names it, and drained never resolves', async () => {
    const sched = new S.SessionScheduler();
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => { throw new Error(SECRET_T4B); } }, sched);
    expect(r).toMatchObject({ status: 'finished', runStatus: 'partial-or-unknown', outcome: { ok: true, value: '"parley: call outcome unknown"' } });
    expect(r.ledger).toMatchObject({ unknown: 1, quiescent: false, entries: [{ state: 'unknown', unknownWhy: 'host-rejected' }] });
    expect(JSON.stringify({ ...r, drained: null })).not.toContain('SYNTHETIC');
    let drained = false;
    void r.drained!.then(() => { drained = true; });
    await settle(200);
    expect(drained).toBe(false);
    expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run has calls with unknown outcome/) });
  });

  it('a host that throws synchronously is unknown too', async () => {
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: () => { throw new Error('sync'); } });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown', unknownWhy: 'host-threw' });
    expect(r.outcome).toMatchObject({ ok: true, value: '"parley: call outcome unknown"' });
  });

  it('malformed, unrequested-cancel and explicit unknown receipts are unknown; a host error text never exists', async () => {
    for (const [settlement, why] of [[{ kind: 'error', message: SECRET_T4B }, 'malformed-settlement'], [{ kind: 'cancelled' }, 'unrequested-cancel'], [{ kind: 'unknown' }, 'host-unknown'], ['{"ok":1}', 'malformed-settlement']] as const) {
      const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => settlement as never });
      expect(r.ledger!.entries[0], why).toMatchObject({ state: 'unknown', unknownWhy: why });
      expect(JSON.stringify({ ...r, drained: null })).not.toContain('SYNTHETIC');
    }
  });
});

describe.skipIf(!supported || !hasCc)('T4b: fire-and-forget and the run wall', () => {
  it('a guest that returns without awaiting: the parent waits for the receipt inside the wall, then completed', async () => {
    const r = await runW(fixtureLoc(), { code: 'parley.get_map({}); return 1;', methods: ['get_map'], host: async () => { await settle(300); return { kind: 'ok', text: '{}' }; } });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 1, ledger: { receipts: 1, quiescent: true } });
  });

  it('a fire-and-forget call that never settles: partial-or-unknown at the wall, draining, cancel requested', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const started = Date.now();
    const r = await runW(fixtureLoc(), { code: 'parley.get_map({}); return 1;', methods: ['get_map'], host: h.host, limits: { wallMs: 2000 } }, sched);
    expect(Date.now() - started).toBeLessThan(3500);
    // The wait ends at the deadline, so the run is wall-time (X1); the guest's own result is still reported.
    expect(r).toMatchObject({ status: 'wall-time', runStatus: 'partial-or-unknown', outcome: { ok: true, value: '1' }, ledger: { draining: 1 } });
    expect(h.calls[0]!.cancel.aborted).toBe(true);
    h.calls[0]!.resolve({ kind: 'cancelled' });
    expect(await r.drained!).toMatchObject({ quiescent: true, entries: [{ state: 'cancelled', cancelRequested: true }] });
  }, 10_000);

  it('the total wall counts the preflight and the launch probe; there is no extra allowance', async () => {
    const dir = fakeProbe('sleeps-wall', SLEEPER);
    const started = Date.now();
    const r = await runW({ ...H.PRODUCT_LOCATIONS, nativeDir: dir }, { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 700 } });
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ status: 'wall-time', spawned: false, hostCalls: 0 });
    expect(elapsed).toBeGreaterThanOrEqual(650);
    expect(elapsed).toBeLessThan(2000);
  });

  it('the wall stops an awaited slow call: wall-time, the call drains and its later receipt is recorded', async () => {
    const h = controlledHost();
    const started = Date.now();
    const r = await runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, limits: { wallMs: 1500 } });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(['wall-time', 'finished']).toContain(r.status);
    expect(r).toMatchObject({ runStatus: 'partial-or-unknown', ledger: { draining: 1 } });
    h.calls[0]!.resolve({ kind: 'error' });
    expect(await r.drained!).toMatchObject({ entries: [{ state: 'failed' }] });
  }, 10_000);
});

describe.skipIf(!supported || !hasCc)('T4b: cancellation is acknowledged only by a typed receipt', () => {
  it('abort while a call is awaited: cancel is requested, a typed cancelled receipt records it and frees the lease', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const ctl = new AbortController();
    const pending = runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, signal: ctl.signal }, sched);
    await until(() => h.calls.length === 1);
    h.calls[0]!.cancel.addEventListener('abort', () => h.calls[0]!.resolve({ kind: 'cancelled' }));
    ctl.abort();
    const r = await pending;
    expect(r).toMatchObject({ status: 'cancelled', hostCalls: 1 });
    expect((await r.drained!).entries[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(sched.holder).toBeNull();
  });

  it('an AbortError rejection after the cancel is NOT an acknowledgement: unknown, lease kept', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const ctl = new AbortController();
    const pending = runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, signal: ctl.signal }, sched);
    await until(() => h.calls.length === 1);
    h.calls[0]!.cancel.addEventListener('abort', () => h.calls[0]!.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    ctl.abort();
    const r = await pending;
    await settle(50);
    expect(r.status).toBe('cancelled');
    expect(sched.holder).not.toBeNull();
    expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy' });
  });

  it('a host that resolves ok after the cancel request: the effect happened, succeeded', async () => {
    const h = controlledHost();
    const ctl = new AbortController();
    const pending = runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, signal: ctl.signal });
    await until(() => h.calls.length === 1);
    ctl.abort();
    const r = await pending;
    h.calls[0]!.resolve({ kind: 'ok', text: '{}' });
    expect((await r.drained!).entries[0]).toMatchObject({ state: 'succeeded', cancelRequested: true, delivered: false });
  });

  it('abort while calls are queued in the guest: only the two dispatched calls are ever seen by the host', async () => {
    const h = controlledHost();
    const ctl = new AbortController();
    const pending = runW(fixtureLoc(), { code: 'return await Promise.all([1,2,3,4].map(() => parley.get_map({})))', methods: ['get_map'], host: h.host, signal: ctl.signal });
    await until(() => h.calls.length === 2);
    await settle(100);
    for (const c of h.calls) c.cancel.addEventListener('abort', () => c.resolve({ kind: 'cancelled' }));
    ctl.abort();
    const r = await pending;
    expect(r).toMatchObject({ status: 'cancelled', hostCalls: 2 });
    expect(h.calls).toHaveLength(2);
    expect((await r.drained!).entries.map((e) => e.state)).toEqual(['cancelled', 'cancelled']);
  });
});

describe.skipIf(!supported || !hasCc)('T4b: admission and response budgets at the parent', () => {
  it('schema-invalid arguments are refused to the guest with a fixed message; the host never sees them', async () => {
    let seen = 0;
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({ maxBytes: 1 }); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => { seen++; return { kind: 'ok', text: '{}' }; } });
    expect(seen).toBe(0);
    expect(r).toMatchObject({ runStatus: 'completed', hostCalls: 0, outcome: { value: '"parley: call refused"' }, ledger: { refused: 1, entries: [{ refusal: 'invalid-arguments' }] } });
  });

  it('the host receives the exact validated arguments text, not the guest text', async () => {
    const texts: string[] = [];
    await runW(fixtureLoc(), { code: 'return await parley.read_room({ room: "r-1", limit: 2 })', methods: ['read_room'], host: async (c) => { texts.push(c.argsText); return { kind: 'ok', text: '{}' }; } });
    expect(texts).toEqual(['{"room":"r-1","limit":2}']);
  });

  it('non-JSON arguments from a forged helper are refused (no kill); a method outside the run allowlist kills', async () => {
    const RUNNING = `await next(); send({ t: 'probed', probes: DENIED }); await next();\n`;
    const a = await runW(forged('not-json-args', RUNNING + `send({ t: 'rpc', rid: 1, method: 'get_map', args: 'not json' }); const r = await next(); send({ t: 'done', ok: true, value: JSON.stringify(r.value), rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); process.exit(0);`), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(a).toMatchObject({ status: 'finished', hostCalls: 0, outcome: { value: '"parley: call refused"' }, ledger: { entries: [{ refusal: 'not-json' }] } });
    const b = await runW(forged('outside-run', RUNNING + `send({ t: 'rpc', rid: 1, method: 'read_room', args: '{"room":"r"}' }); await hold();`), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(b).toMatchObject({ status: 'violation', reason: 'method not allowed', hostCalls: 0, killedBy: 'violation' });
    expect(b.evidence).toEqual([]);
  });

  /** Bytes of one rpc-result IPC line, as the parent charges it. */
  const lineBytes = (rid: number, ok: boolean, value: string): number => Buffer.byteLength(`${JSON.stringify({ t: 'rpc-result', rid, ok, value })}\n`, 'utf8');
  const BIG = JSON.stringify('x'.repeat(200));

  it('every delivered line is charged: data, then the fixed fallback, then a refusal that no longer fits stops the run (quota)', async () => {
    let n = 0;
    const budget = lineBytes(1, true, BIG) + lineBytes(2, false, 'parley: call response not delivered');
    const r = await runW(fixtureLoc(), { code: 'const out = []; for (let i = 0; i < 3; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;', methods: ['get_map'], host: async () => { n++; return { kind: 'ok', text: BIG }; }, limits: { responseBytes: budget } });
    expect(n).toBe(2);
    expect(r).toMatchObject({ status: 'quota', reason: 'response budget exhausted', outcome: null, hostCalls: 2 });
    expect(r.ledger).toMatchObject({ hostBytes: 404, deliveredBytes: budget, entries: [
      { state: 'succeeded', deliveryFailure: null, delivered: true, deliveredBytes: lineBytes(1, true, BIG) },
      { state: 'succeeded', deliveryFailure: 'response-budget', delivered: true },
      { state: 'refused', refusal: 'response-budget-exhausted', delivered: false },
    ] });
    expect(r.evidence.map((e) => [e.outcome, e.incomplete])).toEqual([['succeeded', false], ['succeeded', true], ['refused', false]]);
  });

  it('exact and one-over: data line', async () => {
    const exact = await runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: async () => ({ kind: 'ok', text: BIG }), limits: { responseBytes: lineBytes(1, true, BIG) } });
    expect(exact).toMatchObject({ runStatus: 'completed', outcome: { ok: true, value: BIG }, ledger: { deliveredBytes: lineBytes(1, true, BIG) } });
    const over = await runW(fixtureLoc(), { code: 'try { return await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => ({ kind: 'ok', text: BIG }), limits: { responseBytes: lineBytes(1, true, BIG) - 1 } });
    expect(over).toMatchObject({ outcome: { ok: true, value: '"parley: call response not delivered"' }, ledger: { entries: [{ state: 'succeeded', deliveryFailure: 'response-budget' }] } });
  });

  it('exact and one-over: fixed error line (the error is charged; one byte short stops the run)', async () => {
    const e1 = lineBytes(1, false, 'parley: call failed');
    const code = 'try { await parley.get_map({}); } catch (e) { return e.message; }';
    const exact = await runW(fixtureLoc(), { code, methods: ['get_map'], host: async () => ({ kind: 'error' }), limits: { responseBytes: e1 } });
    expect(exact).toMatchObject({ runStatus: 'completed', outcome: { value: '"parley: call failed"' }, ledger: { deliveredBytes: e1 } });
    const over = await runW(fixtureLoc(), { code, methods: ['get_map'], host: async () => ({ kind: 'error' }), limits: { responseBytes: e1 - 1 } });
    expect(over).toMatchObject({ status: 'quota', outcome: null, hostCalls: 1, ledger: { deliveredBytes: 0, entries: [{ state: 'failed', delivered: false }] } });
  });

  it('exact and one-over: refusal line (never reaches the host either way)', async () => {
    const r1 = lineBytes(1, false, 'parley: call refused');
    const code = 'try { await parley.get_map({ maxBytes: 1 }); } catch (e) { return e.message; }';
    let n = 0;
    const host: SchedulerModule.FixtureHost = async () => { n++; return { kind: 'ok', text: '{}' }; };
    const exact = await runW(fixtureLoc(), { code, methods: ['get_map'], host, limits: { responseBytes: r1 } });
    expect(exact).toMatchObject({ runStatus: 'completed', outcome: { value: '"parley: call refused"' }, ledger: { deliveredBytes: r1 } });
    const over = await runW(fixtureLoc(), { code, methods: ['get_map'], host, limits: { responseBytes: r1 - 1 } });
    expect(over).toMatchObject({ status: 'quota', outcome: null, hostCalls: 0 });
    expect(n).toBe(0);
  });

  it('a non-JSON ok response is not delivered and carries no content into the ledger', async () => {
    const r = await runW(fixtureLoc(), { code: 'try { return await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => ({ kind: 'ok', text: `oops ${SECRET_T4B}` }) });
    expect(r.outcome).toMatchObject({ value: '"parley: call response not delivered"' });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded', deliveryFailure: 'response-not-json' });
    expect(JSON.stringify({ ...r, drained: null })).not.toContain('SYNTHETIC');
  });
});

describe.skipIf(!supported || !hasCc)('T4b: request snapshot and refusals before the lease', () => {
  it('raised limits, a stale revision, methods outside the handle and oversized code are refused before any lease', async () => {
    const sched = new S.SessionScheduler();
    const cases: [Req, RegExp][] = [
      [{ code: 'return 1', host: echoHost, limits: { wallMs: 30_001 } }, /invalid limits: wallMs above its maximum 30000/],
      [{ code: 'return 1', host: echoHost, limits: { maxRpcs: 33 } }, /invalid limits: maxRpcs above its maximum 32/],
      [{ code: 'return 1', host: echoHost, limits: { responseBytes: 2 * 1024 * 1024 } }, /invalid limits: responseBytes above/],
      [{ code: 'return 1', host: echoHost, apiRevision: `cm1.${'0'.repeat(64)}` }, /stale apiRevision/],
      [{ code: 'return 1', host: echoHost, methods: ['report'] }, /methods outside the catalogue handle/],
      [{ code: 'x'.repeat(32 * 1024 + 1), host: echoHost }, /code too large/],
    ];
    for (const [req, why] of cases) {
      const r = await runW(fixtureLoc(), req, sched);
      expect(r, String(why)).toMatchObject({ status: 'unavailable', spawned: false, runId: null });
      expect(r.reason).toMatch(why);
      expect(sched.holder).toBeNull();
    }
  });
});

describe.skipIf(!supported || !hasCc)('T4b: done, crash and final value, judged by the parent', () => {
  const RUNNING = `await next(); send({ t: 'probed', probes: DENIED }); await next();\n`;
  const doneLine = (value: string) => `send({ t: 'done', ok: true, value: ${JSON.stringify(value)}, rpcs: 99, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } });`;

  it('helper-reported counts are ignored: hostCalls and the ledger come from the parent', async () => {
    const r = await runW(forged('lying-counts', RUNNING + doneLine('1') + ' process.exit(0);'), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 0, ledger: { admitted: 0 } });
  });

  it('a second done is a violation', async () => {
    const r = await runW(forged('double-done', RUNNING + doneLine('1') + doneLine('2') + ' await hold();'), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'violation', reason: 'done in phase done' });
  });

  it('done while a call is in flight: the parent waits for the receipt, a never-settling one leaves partial-or-unknown', async () => {
    const h = controlledHost();
    const body = RUNNING + `send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); ${doneLine('1')} process.exit(0);`;
    const r = await runW(forged('done-in-flight', body), { code: 'return 1', methods: ['get_map'], host: h.host, limits: { wallMs: 2000 } });
    expect(r).toMatchObject({ status: 'wall-time', runStatus: 'partial-or-unknown', hostCalls: 1, ledger: { draining: 1 } });
    h.calls[0]!.resolve({ kind: 'ok', text: '{}' });
    await r.drained!;
  }, 10_000);

  it('a helper that dies with a call in flight: crashed, the call drains, its later receipt is recorded', async () => {
    const h = controlledHost();
    const r = await runW(forged('dies', RUNNING + `send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); setTimeout(() => process.exit(3), 100);`), { code: 'return 1', methods: ['get_map'], host: h.host });
    expect(r).toMatchObject({ status: 'crashed', runStatus: 'partial-or-unknown', hostCalls: 1, ledger: { draining: 1 } });
    h.calls[0]!.resolve({ kind: 'error' });
    expect((await r.drained!).entries[0]).toMatchObject({ state: 'failed', delivered: false });
  });

  it('a final value that is not bounded strict JSON makes the run an error', async () => {
    const r = await runW(forged('bad-final', RUNNING + doneLine('not json') + ' process.exit(0);'), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'error', reason: 'final value is not bounded strict JSON' });
    const big = await runW(forged('big-final', RUNNING + doneLine(JSON.stringify('x'.repeat(16 * 1024))) + ' process.exit(0);'), { code: 'return 1', methods: ['get_map'], host: echoHost });
    expect(big).toMatchObject({ runStatus: 'error' });
  });

  it('a guest error with every call settled is an error, not partial', async () => {
    const r = await runW(fixtureLoc(), { code: 'await parley.get_map({}); throw new Error("x")', methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'error', ledger: { receipts: 1 } });
  });
});

// ----- T4b repair (s-292 R1–R4, lead B1–B4) -----

describe.skipIf(!supported || !hasCc)('T4b repair: capacity, deadline edges, receipts, bounded cleanup', () => {
  it('B1/R1: an honest guest hitting capacity held by unknown calls gets a fixed refusal; the host sees only 2', async () => {
    let calls = 0;
    const sched = new S.SessionScheduler();
    const r = await runW(fixtureLoc(), { code: 'const out = []; for (let i = 0; i < 3; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;', methods: ['get_map'], host: async () => { calls++; throw new Error('transport lost'); } }, sched);
    expect(calls).toBe(2);
    expect(r.outcome).toMatchObject({ ok: true, value: JSON.stringify(['parley: call outcome unknown', 'parley: call outcome unknown', 'parley: capacity held by unresolved calls']) });
    expect(r.ledger).toMatchObject({ unknown: 2, entries: [{ state: 'unknown' }, { state: 'unknown' }, { refusal: 'unsettled-capacity', state: 'refused' }] });
    expect(r.status).toBe('finished');
  });

  /** A clock that reads real time until `flip()` is called, then reads far past any deadline. */
  const jumpClock = () => { let offset = 0; return { clock: () => performance.now() + offset, flip: () => { offset = 1e9; } }; };
  const RUN = `await next(); send({ t: 'probed', probes: DENIED }); await next(); await new Promise((r) => setTimeout(r, 2500));\n`;

  it('B2/R2: rpc lines that arrive past the deadline in one chunk dispatch nothing and the run is wall-time', async () => {
    const jc = jumpClock();
    let calls = 0;
    const body = RUN + `process.stdout.write(JSON.stringify({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }) + '\\n' + JSON.stringify({ t: 'rpc', rid: 2, method: 'get_map', args: '{}' }) + '\\n'); await hold();`;
    setTimeout(jc.flip, 1500);
    const r = await H.runWith(forged('late-rpcs', body), { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map'], host: async () => { calls++; return { kind: 'ok', text: '{}' }; } }, new S.SessionScheduler(), jc.clock);
    expect(calls).toBe(0);
    expect(r).toMatchObject({ status: 'wall-time', hostCalls: 0 });
    expect(r.runStatus).not.toBe('completed');
    expect(r.ledger!.entries[0]).toMatchObject({ refusal: 'run-ended', state: 'refused' });
  }, 15_000);

  it('B2/R2: a done that arrives past the deadline is not a finished run', async () => {
    const jc = jumpClock();
    const body = RUN + `send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); await hold();`;
    setTimeout(jc.flip, 1500);
    const r = await H.runWith(forged('late-done', body), { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map'], host: echoHost }, new S.SessionScheduler(), jc.clock);
    expect(r).toMatchObject({ status: 'wall-time', outcome: null });
    expect(r.runStatus).not.toBe('completed');
  }, 15_000);

  it('B2/R2: a host receipt past the deadline is recorded but never delivered', async () => {
    const jc = jumpClock();
    const h = controlledHost();
    const pending = H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: 'return await parley.get_map({})', methods: ['get_map'], host: h.host, limits: { wallMs: 4000 } }, new S.SessionScheduler(), jc.clock);
    await until(() => h.calls.length === 1);
    jc.flip();
    h.calls[0]!.resolve({ kind: 'ok', text: '{"late":true}' });
    const r = await pending;
    expect(r.ledger).toMatchObject({ deliveredBytes: 0, entries: [{ state: 'succeeded', delivered: false, deliveredBytes: 0 }] });
    expect(r.outcome?.value ?? null).not.toBe('{"late":true}');
    expect(r.runStatus).not.toBe('completed');
  }, 15_000);

  it('B3: a receipt whose traps throw is unknown with a fixed message, no unhandled rejection, no canary', async () => {
    const hostile = new Proxy({}, { get() { throw new Error(SECRET_T4B); }, ownKeys() { throw new Error(SECRET_T4B); }, getPrototypeOf() { throw new Error(SECRET_T4B); } });
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => hostile as never });
    expect(r.outcome).toMatchObject({ ok: true, value: '"parley: call outcome unknown"' });
    // An async host returning the proxy rejects at promise resolution (host-rejected); a direct value reaches readSettlement.
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown' });
    expect(['host-rejected', 'malformed-settlement']).toContain(r.ledger!.entries[0]!.unknownWhy);
    expect(JSON.stringify({ ...r, drained: null })).not.toContain('SYNTHETIC');
  });

  it('B4: logs are refused, not a no-op opt-in', async () => {
    const r = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { logBytes: 1 } });
    expect(r).toMatchObject({ status: 'unavailable', reason: 'invalid limits: logs are not supported (logBytes must be 0)', spawned: false });
  });

  /** A wrapper whose background process inherits the helper's stdout: after SIGKILL the pipe stays open, no close. */
  const lingeringWrapper = (marker: string): string => {
    const wrapper = path.join(tmp, `lingering-${marker}.sh`);
    writeFileSync(wrapper, `#!/bin/sh\n'${realpathSync(process.execPath)}' -e 'setTimeout(() => {}, 120000)' ${marker} &\nshift 2\nexec "$@"\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  };

  it('a response assembled before the wall has fired still asks a draining call to cancel: the pending timer goes first (no close)', async () => {
    const marker = `PARLEY_T7A_LINGER_${process.pid}`;
    const WALL = 20_000;
    let offset = 0;
    let t0: number | null = null;
    const clock = (): number => { const now = performance.now() + offset; t0 ??= now; return now; };
    const h = controlledHost();
    const authorize = (c: HelperModule.AuthorizeCall) => {
      if (c.method !== 'read_room') return { ok: true as const };
      // From here the clock reads 300 ms before the deadline, which arms the pending response for then; the wall stays far off.
      offset = (t0 as number) + WALL - 300 - performance.now();
      return { ok: false as const, reason: 'policy' as const, policy: 'revoked' as const, terminal: true };
    };
    const body = `await next(); send({ t: 'probed', probes: DENIED }); await next(); send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); send({ t: 'rpc', rid: 2, method: 'read_room', args: '{"room":"r-1"}' }); await hold();`;
    const loc = forged('drain-no-close', body, { wrapper: lingeringWrapper(marker) });
    const started = Date.now();
    try {
      const r = await H.runWith(loc, { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map', 'read_room'], host: h.host, authorize, limits: { wallMs: WALL } }, new S.SessionScheduler(), clock);
      expect(Date.now() - started).toBeLessThan(WALL / 2);
      expect(r).toMatchObject({ status: 'policy', cleanup: 'pending', runStatus: 'partial-or-unknown' });
      expect(r.ledger!.entries[0]).toMatchObject({ method: 'get_map', state: 'draining', cancelRequested: true });
      expect(h.calls[0]!.cancel.aborted).toBe(true);
    } finally {
      spawnSync('/usr/bin/pkill', ['-f', marker]);
    }
  }, 15_000);

  it('R4: no close by the deadline → the result returns at the deadline with cleanup pending; a late close releases the lease (all settled)', async () => {
    const marker = `PARLEY_T4B_LINGER_A_${process.pid}`;
    const sched = new S.SessionScheduler();
    // A forged helper that passes the self-test and then just waits; the 3 s wall kills it.
    const loc = forged('waits', `await next(); send({ t: 'probed', probes: DENIED }); await next(); await hold();`, { wrapper: lingeringWrapper(marker) });
    const started = Date.now();
    try {
      const r = await runW(loc, { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 3000 } }, sched);
      expect(Date.now() - started).toBeLessThan(3000 + 800);
      expect(r).toMatchObject({ status: 'wall-time', cleanup: 'pending', runStatus: 'partial-or-unknown', ledger: { ended: true, lifecycleClosed: false, quiescent: false } });
      expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run cleanup pending/) });
      // The stub finally exits: the owned observer records the close; nothing else is open, so the lease goes.
      spawnSync('/usr/bin/pkill', ['-f', marker]);
      const final = await r.drained!;
      expect(final).toMatchObject({ lifecycleClosed: true, quiescent: true });
      expect(sched.holder).toBeNull();
    } finally {
      spawnSync('/usr/bin/pkill', ['-f', marker]);
    }
  }, 20_000);

  it('R4: the same with an unknown call: the late close is recorded but the lease stays held (U2)', async () => {
    const marker = `PARLEY_T4B_LINGER_B_${process.pid}`;
    const sched = new S.SessionScheduler();
    const loc = forged('unknown-then-wait', `await next(); send({ t: 'probed', probes: DENIED }); await next(); send({ t: 'rpc', rid: 1, method: 'get_map', args: '{}' }); await hold();`, { wrapper: lingeringWrapper(marker) });
    try {
      const r = await runW(loc, { code: 'return 1', methods: ['get_map'], host: async () => { throw new Error('lost'); }, limits: { wallMs: 3000 } }, sched);
      expect(r).toMatchObject({ status: 'wall-time', cleanup: 'pending', ledger: { unknown: 1 } });
      spawnSync('/usr/bin/pkill', ['-f', marker]);
      await until(() => !(sched.acquire(() => { throw new Error('must stay busy'); }).ok) && true, 2000).catch(() => undefined);
      await settle(300);
      const busy = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched);
      expect(busy).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run has calls with unknown outcome/) });
    } finally {
      spawnSync('/usr/bin/pkill', ['-f', marker]);
    }
  }, 20_000);
});

// ----- T4b r3 (s-292 m-4173 X1–X3, lead m-4174/m-4175) -----

describe.skipIf(!supported || !hasCc)('T4b r3: completion by monotonic time, deadline result without close, raw host byte cap', () => {
  const jumpClock = () => { let offset = 0; return { clock: () => performance.now() + offset, flip: () => { offset = 1e9; } }; };
  const lineBytes = (rid: number, ok: boolean, value: string): number => Buffer.byteLength(`${JSON.stringify({ t: 'rpc-result', rid, ok, value })}\n`, 'utf8');

  it('X1: a receipt that lands past the deadline before the timer fires never yields completed (done arrived in time)', async () => {
    const jc = jumpClock();
    const h = controlledHost();
    const pending = H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: 'parley.get_map({}); return 1;', methods: ['get_map'], host: h.host }, new S.SessionScheduler(), jc.clock);
    await until(() => h.calls.length === 1);
    await settle(600); // the guest's done has arrived; the parent waits for the fire-and-forget receipt
    jc.flip();
    h.calls[0]!.resolve({ kind: 'ok', text: '{}' });
    const r = await pending;
    expect(r).toMatchObject({ status: 'wall-time', outcome: { ok: true, value: '1' } });
    expect(r.runStatus).not.toBe('completed');
    // The settled effect is kept as it happened.
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'succeeded' });
  }, 15_000);

  it('X2: exit observed but close withheld → the result comes at the deadline with cleanup pending; a late close releases', async () => {
    const marker = `PARLEY_T4B_LINGER_X2_${process.pid}`;
    const wrapper = path.join(tmp, 'lingering-x2.sh');
    writeFileSync(wrapper, `#!/bin/sh\n'${realpathSync(process.execPath)}' -e 'setTimeout(() => {}, 120000)' ${marker} &\nshift 2\nexec "$@"\n`);
    chmodSync(wrapper, 0o755);
    const sched = new S.SessionScheduler();
    // The helper finishes by itself (done, then exit 0); only its close is withheld by the lingering process.
    const loc = forged('exits-itself', `await next(); send({ t: 'probed', probes: DENIED }); await next(); send({ t: 'done', ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 0, disposed: true, refused: { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 } }); setTimeout(() => process.exit(0), 50);`, { wrapper });
    const started = Date.now();
    try {
      const r = await runW(loc, { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 3000 } }, sched);
      expect(Date.now() - started).toBeLessThan(3000 + 800);
      expect(r).toMatchObject({ cleanup: 'pending', runStatus: 'partial-or-unknown', ledger: { lifecycleClosed: false } });
      expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/cleanup pending/) });
      spawnSync('/usr/bin/pkill', ['-f', marker]);
      expect(await r.drained!).toMatchObject({ lifecycleClosed: true, quiescent: true });
    } finally {
      spawnSync('/usr/bin/pkill', ['-f', marker]);
    }
  }, 20_000);

  const TEXT = JSON.stringify('y'.repeat(4998)); // 5000 bytes

  it('X3: raw host bytes have their own cap: an oversized receipt falls back cheaply and the next admission is refused', async () => {
    let n = 0;
    const r = await runW(fixtureLoc(), { code: 'const out = []; for (let i = 0; i < 3; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;', methods: ['get_map'], host: async () => { n++; return { kind: 'ok', text: TEXT }; }, limits: { responseBytes: 1000 } });
    expect(n).toBe(1);
    expect(r.outcome).toMatchObject({ ok: true, value: JSON.stringify(['parley: call response not delivered', 'parley: call refused', 'parley: call refused']) });
    expect(r.ledger).toMatchObject({ hostBytes: 5000, entries: [{ state: 'succeeded', deliveryFailure: 'response-budget' }, { refusal: 'response-budget-exhausted' }, { refusal: 'response-budget-exhausted' }] });
    expect(r.ledger!.deliveredBytes).toBe(lineBytes(1, false, 'parley: call response not delivered') + lineBytes(2, false, 'parley: call refused') + lineBytes(3, false, 'parley: call refused'));
  });

  it('X3: several oversized receipts already in flight are all recorded (overshoot kept), each with the cheap fallback', async () => {
    let n = 0;
    const r = await runW(fixtureLoc(), { code: 'const r = await Promise.allSettled([parley.get_map({}), parley.get_map({})]); let third; try { await parley.get_map({}); third = "ok"; } catch (e) { third = e.message; } return [r.map((x) => x.status), third];', methods: ['get_map'], host: async () => { n++; await settle(50); return { kind: 'ok', text: TEXT }; }, limits: { responseBytes: 1000 } });
    expect(n).toBe(2);
    expect(r.ledger).toMatchObject({ hostBytes: 10_000, entries: [{ state: 'succeeded', deliveryFailure: 'response-budget' }, { state: 'succeeded', deliveryFailure: 'response-budget' }, { refusal: 'response-budget-exhausted' }] });
    expect(r.outcome).toMatchObject({ ok: true, value: JSON.stringify([['rejected', 'rejected'], 'parley: call refused']) });
  });

  it('X3: exact and one-under on the raw cap', async () => {
    const code = 'const out = []; for (let i = 0; i < 2; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;';
    let a = 0;
    const exact = await runW(fixtureLoc(), { code, methods: ['get_map'], host: async () => { a++; return { kind: 'ok', text: TEXT }; }, limits: { responseBytes: 5000 } });
    expect(a).toBe(1);
    expect(exact.ledger!.entries[1]).toMatchObject({ refusal: 'response-budget-exhausted' });
    let b = 0;
    const under = await runW(fixtureLoc(), { code, methods: ['get_map'], host: async () => { b++; return { kind: 'ok', text: TEXT }; }, limits: { responseBytes: 5001 } });
    expect(b).toBe(2);
    expect(under.ledger).toMatchObject({ hostBytes: 10_000, entries: [{ state: 'succeeded' }, { state: 'succeeded' }] });
  });

  it('X3: oversized text is never serialized just to be rejected', async () => {
    const original = JSON.stringify;
    let oversized = 0;
    JSON.stringify = ((v: unknown, ...rest: unknown[]) => {
      if (typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'rpc-result' && typeof (v as { value?: unknown }).value === 'string' && ((v as { value: string }).value).length > 1000) oversized++;
      return (original as (...a: unknown[]) => string)(v, ...rest);
    }) as typeof JSON.stringify;
    try {
      await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => ({ kind: 'ok', text: TEXT }), limits: { responseBytes: 1000 } });
    } finally {
      JSON.stringify = original;
    }
    expect(oversized).toBe(0);
  });
});


// ----- T5b2: dispatch edge, policy stop with drain, tool-error data, observed bytes, preflight lifecycle -----

describe.skipIf(!supported || !hasCc)('T5b2: the dispatch edge and native-policy refusals', () => {
  const POLICY = (policy: string, terminal: boolean) => ({ ok: false as const, reason: 'policy' as const, policy: policy as 'deny', terminal });

  it('authorize sees runId, ordinal and the admitted call; the host gets runId and the raw budget', async () => {
    const asked: unknown[] = [];
    const hosted: unknown[] = [];
    const r = await runW(fixtureLoc(), {
      code: 'return await parley.read_room({ room: "r-1" })', methods: ['read_room'],
      authorize: (c) => { asked.push(c); return { ok: true }; },
      host: async (call, _cancel, budget) => { hosted.push([call, budget.remainingRaw()]); return { kind: 'ok', text: '{"n":1}', observedBytes: 30 }; },
    });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 1 });
    expect(asked).toEqual([{ runId: r.runId, ordinal: 1, method: 'read_room', argsText: '{"room":"r-1"}', args: { room: 'r-1' } }]);
    expect(hosted).toEqual([[{ runId: r.runId, ordinal: 1, method: 'read_room', argsText: '{"room":"r-1"}' }, RUN_LIMITS_RESPONSE]]);
    expect(r.ledger).toMatchObject({ hostBytes: 30, entries: [{ state: 'succeeded', responseBytes: 30 }] });
  });

  it('a non-terminal refusal refuses only that call: the guest gets a fixed line and continues', async () => {
    let n = 0;
    let hosted = 0;
    const r = await runW(fixtureLoc(), {
      code: 'const out = []; for (let i = 0; i < 3; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;', methods: ['get_map'],
      authorize: () => (++n === 2 ? POLICY('deny', false) : n === 3 ? { ok: false, reason: 'transport-too-large' } : { ok: true }),
      host: async () => { hosted++; return { kind: 'ok', text: '{}', observedBytes: 2 }; },
    });
    expect(hosted).toBe(1);
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', outcome: { value: JSON.stringify(['ok', 'parley: not permitted by native policy', 'parley: call refused']) } });
    expect(r.ledger!.entries.map((e) => [e.state, e.refusal, e.policy])).toEqual([['succeeded', null, null], ['refused', 'policy', 'deny'], ['refused', 'transport-too-large', null]]);
  });

  it('a deadline crossed inside authorize: the post-callback check refuses, zero sends', async () => {
    let offset = 0;
    const clock = () => performance.now() + offset;
    let hosted = 0;
    const r = await H.runWith(fixtureLoc(), {
      validators: VAL, apiRevision: REV, code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'],
      authorize: () => { offset = 1e9; return { ok: true }; },
      host: async () => { hosted++; return { kind: 'ok', text: '{}' }; },
    }, new S.SessionScheduler(), clock);
    expect(hosted).toBe(0);
    expect(r).toMatchObject({ status: 'wall-time', hostCalls: 0 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended' });
  }, 15_000);

  it('r4: a verdict whose ok is a getter (that would advance the clock past the deadline) is never read; run-ended, zero sends', async () => {
    let offset = 0;
    let reads = 0;
    let hosted = 0;
    const r = await H.runWith(fixtureLoc(), {
      validators: VAL, apiRevision: REV, code: 'try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }', methods: ['get_map'],
      authorize: () => Object.defineProperty({}, 'ok', { get: () => { reads++; offset = 1e9; return true; }, enumerable: true }) as never,
      host: async () => { hosted++; return { kind: 'ok', text: '{}' }; },
    }, new S.SessionScheduler(), () => performance.now() + offset);
    expect(reads).toBe(0);
    expect(hosted).toBe(0);
    expect(r.hostCalls).toBe(0);
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended', policy: null });
    expect(r.outcome).toMatchObject({ value: '"parley: call refused"' });
  }, 15_000);

  it('r4: array, hidden-extra and symbol-extra verdicts from authorize refuse with zero sends', async () => {
    const shapes = [() => Object.assign([], { ok: true }), () => Object.defineProperty({ ok: true }, 'x', { value: 1, enumerable: false }), () => ({ ok: true, [Symbol('s')]: 1 })];
    for (const make of shapes) {
      let hosted = 0;
      const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }', methods: ['get_map'], authorize: (() => make()) as never, host: async () => { hosted++; return { kind: 'ok', text: '{}' }; } });
      expect(hosted).toBe(0);
      expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended' });
    }
  });

  it('r3 P3: a callback that crosses the deadline and returns revoked ends wall-time with zero dispatch (time decides first)', async () => {
    let offset = 0;
    let hosted = 0;
    const r = await H.runWith(fixtureLoc(), {
      validators: VAL, apiRevision: REV, code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'],
      authorize: () => { offset = 1e9; return { ok: false, reason: 'policy', policy: 'revoked', terminal: true }; },
      host: async () => { hosted++; return { kind: 'ok', text: '{}' }; },
    }, new S.SessionScheduler(), () => performance.now() + offset);
    expect(hosted).toBe(0);
    expect(r).toMatchObject({ status: 'wall-time', hostCalls: 0 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended', policy: null });
  }, 15_000);

  it('r3 P3: a callback that aborts the run and returns deny ends cancelled with zero dispatch', async () => {
    const ctl = new AbortController();
    let hosted = 0;
    const r = await runW(fixtureLoc(), {
      code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], signal: ctl.signal,
      authorize: () => { ctl.abort(); return POLICY('deny', false); },
      host: async () => { hosted++; return { kind: 'ok', text: '{}' }; },
    });
    expect(hosted).toBe(0);
    expect(r).toMatchObject({ status: 'cancelled', hostCalls: 0 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended', policy: null });
  }, 15_000);

  it('r3 P3: a timely revoked verdict still decides: status policy, the entry records it', async () => {
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], authorize: () => POLICY('revoked', true), host: async () => ({ kind: 'ok', text: '{}' }) });
    expect(r).toMatchObject({ status: 'policy', hostCalls: 0 });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'policy', policy: 'revoked' });
  }, 15_000);

  it('a throwing or malformed authorize fails closed (run-ended, zero sends)', async () => {
    for (const authorize of [() => { throw new Error('gate'); }, () => ({ ok: 'yes' }) as never, () => POLICY('allow', false)]) {
      let hosted = 0;
      const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); return "sent"; } catch (e) { return e.message; }', methods: ['get_map'], authorize, host: async () => { hosted++; return { kind: 'ok', text: '{}' }; } });
      expect(hosted).toBe(0);
      expect(r.ledger!.entries[0]).toMatchObject({ state: 'refused', refusal: 'run-ended' });
    }
  });
});

const RUN_LIMITS_RESPONSE = 1024 * 1024;

describe.skipIf(!supported || !hasCc)('T5b2: a terminal policy refusal stops admission and drains started calls', () => {
  // A is started and held by the host; B is refused as revoked; C would follow B if admission were still open.
  const CODE = 'const a = parley.get_map({}); let b; try { await parley.read_room({ room: "r-1" }); } catch (e) { b = e.message; } await parley.get_map({}); return [await a, b];';
  const policy = (state: 'revoked' | 'stale') => (c: HelperModule.AuthorizeCall) => (c.method === 'read_room' ? { ok: false as const, reason: 'policy' as const, policy: state, terminal: true } : { ok: true as const });

  /**
   * Three timers target the run's one deadline: the wall, the wait for receipts and the pending response. They expire within the same
   * millisecond, and either of the last two can go first (measured: 3 runs of 10), so a response can be assembled before the wall has
   * asked anything to cancel. This clock makes that order certain: from `jump()` on it reads `leftMs` before the deadline, so a timer
   * armed after that fires then, while one armed earlier on the true clock, the wall and here the pending response, is far off.
   */
  const orderClock = (wallMs: number, leftMs: number) => {
    let offset = 0;
    let t0: number | null = null;
    return {
      clock: (): number => { const now = performance.now() + offset; t0 ??= now; return now; },
      jump: (): void => { offset = (t0 as number) + wallMs - leftMs - performance.now(); },
    };
  };

  it('a response assembled before the wall has fired still asks a draining call to cancel: the wait timer goes first', async () => {
    const WALL = 20_000;
    const oc = orderClock(WALL, 300);
    const h = controlledHost();
    // After this edge returns, the stop runs and arms the pending response on the true clock; the wait is armed at the close, after the jump.
    const authorize = (c: HelperModule.AuthorizeCall) => { if (c.method === 'read_room') queueMicrotask(oc.jump); return policy('revoked')(c); };
    const started = Date.now();
    const r = await H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: CODE, methods: ['get_map', 'read_room'], host: h.host, authorize, limits: { wallMs: WALL } }, new S.SessionScheduler(), oc.clock);
    expect(Date.now() - started).toBeLessThan(WALL / 2);
    expect(r).toMatchObject({ status: 'policy', runStatus: 'partial-or-unknown', cleanup: 'confirmed' });
    expect(r.ledger!.entries[0]).toMatchObject({ method: 'get_map', state: 'draining', cancelRequested: true });
    expect(h.calls[0]!.cancel.aborted).toBe(true);
  }, 15_000);

  it.each(['revoked', 'stale'] as const)('%s: A is not cancelled and settles; C is never sent; status policy; the lease goes', async (state) => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const pending = runW(fixtureLoc(), { code: CODE, methods: ['get_map', 'read_room'], host: h.host, authorize: policy(state) }, sched);
    await until(() => h.calls.length === 1);
    await settle(300);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.cancel.aborted).toBe(false);
    h.calls[0]!.resolve({ kind: 'ok', text: '{"a":1}', observedBytes: 7 });
    const r = await pending;
    expect(r).toMatchObject({ status: 'policy', reason: `native policy ${state}`, runStatus: 'error', hostCalls: 1, killedBy: 'policy' });
    expect(r.ledger!.entries.map((e) => [e.method, e.state, e.refusal, e.policy])).toEqual([['get_map', 'succeeded', null, null], ['read_room', 'refused', 'policy', state]]);
    expect(h.calls).toHaveLength(1);
    await r.drained;
    expect(sched.holder).toBeNull();
  }, 20_000);

  it('r2 P2: a policy line that does not fit the delivered budget never turns the drain into a quota stop', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    // 50 bytes: far less than one rpc-result line, so the r1 order (deliver, then stop) hit quota and cancelled A.
    const pending = runW(fixtureLoc(), { code: CODE, methods: ['get_map', 'read_room'], host: h.host, authorize: policy('revoked'), limits: { responseBytes: 50 } }, sched);
    await until(() => h.calls.length === 1);
    await settle(300);
    expect(h.calls[0]!.cancel.aborted).toBe(false);
    h.calls[0]!.resolve({ kind: 'ok', text: '{"a":1}', observedBytes: 7 });
    const r = await pending;
    expect(r).toMatchObject({ status: 'policy', reason: 'native policy revoked', hostCalls: 1 });
    expect(r.ledger).toMatchObject({ deliveredBytes: 0, entries: [{ method: 'get_map', state: 'succeeded', cancelRequested: false }, { method: 'read_room', state: 'refused', policy: 'revoked', delivered: false }] });
    expect(h.calls).toHaveLength(1);
    await r.drained;
    expect(sched.holder).toBeNull();
  }, 20_000);

  it('a caller abort during the drain still cancels A (existing cancellation rules)', async () => {
    const h = controlledHost();
    const ctl = new AbortController();
    const pending = runW(fixtureLoc(), { code: CODE, methods: ['get_map', 'read_room'], host: h.host, authorize: policy('revoked'), signal: ctl.signal });
    await until(() => h.calls.length === 1);
    await settle(300);
    expect(h.calls[0]!.cancel.aborted).toBe(false);
    h.calls[0]!.cancel.addEventListener('abort', () => h.calls[0]!.resolve({ kind: 'cancelled' }));
    ctl.abort();
    const r = await pending;
    expect(h.calls[0]!.cancel.aborted).toBe(true);
    expect(r.status).toBe('policy');
    expect((await r.drained!).entries[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(h.calls).toHaveLength(1);
  }, 20_000);

  it('the wall during the drain cancels A; A unknown keeps the lease (U2)', async () => {
    const sched = new S.SessionScheduler();
    const h = controlledHost();
    const r = await runW(fixtureLoc(), { code: CODE, methods: ['get_map', 'read_room'], host: h.host, authorize: policy('revoked'), limits: { wallMs: 3000 } }, sched);
    expect(h.calls[0]!.cancel.aborted).toBe(true);
    expect(r).toMatchObject({ status: 'policy', runStatus: 'partial-or-unknown' });
    h.calls[0]!.reject(new Error('lost'));
    await settle(50);
    expect(sched.holder).not.toBeNull();
    expect(h.calls).toHaveLength(1);
  }, 20_000);
});

describe.skipIf(!supported || !hasCc)('T5b2: tool-error results and observed bytes', () => {
  const lineBytes = (rid: number, ok: boolean, value: string): number => Buffer.byteLength(`${JSON.stringify({ t: 'rpc-result', rid, ok, value })}\n`, 'utf8');
  const ERR = JSON.stringify({ content: [{ type: 'text', text: 'You are not a member of this room.' }], isError: true });

  it('the whole error result reaches the guest as data; the call stays failed; observed bytes are charged', async () => {
    const r = await runW(fixtureLoc(), { code: 'return await parley.read_room({ room: "r-x" })', methods: ['read_room'], host: async () => ({ kind: 'error', text: ERR, observedBytes: 777 }) });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', outcome: { ok: true, value: ERR } });
    expect(r.ledger).toMatchObject({ hostBytes: 777, entries: [{ state: 'failed', responseBytes: 777, deliveryFailure: null, delivered: true }] });
  });

  it('exact and one-over delivery: the result fits exactly; one byte less and the guest gets the fixed line while failed stays', async () => {
    const code = 'try { return await parley.read_room({ room: "r-x" }); } catch (e) { return e.message; }';
    const exact = lineBytes(1, true, ERR);
    const a = await runW(fixtureLoc(), { code, methods: ['read_room'], host: async () => ({ kind: 'error', text: ERR, observedBytes: 10 }), limits: { responseBytes: exact } });
    expect(a).toMatchObject({ outcome: { value: ERR }, ledger: { deliveredBytes: exact, entries: [{ state: 'failed', deliveryFailure: null }] } });
    const b = await runW(fixtureLoc(), { code, methods: ['read_room'], host: async () => ({ kind: 'error', text: ERR, observedBytes: 10 }), limits: { responseBytes: exact - 1 } });
    expect(b).toMatchObject({ outcome: { value: '"parley: call response not delivered"' }, ledger: { entries: [{ state: 'failed', deliveryFailure: 'response-budget' }] } });
  });

  it('exact and one-over raw budget: observed bytes of an error equal to the budget refuse the next call; one less does not', async () => {
    const code = 'const out = []; for (let i = 0; i < 2; i++) { try { await parley.get_map({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out;';
    let n = 0;
    const host = (observed: number): SchedulerModule.FixtureHost => async () => { n++; return { kind: 'error', text: '{"content":[],"isError":true}', observedBytes: observed }; };
    const full = await runW(fixtureLoc(), { code, methods: ['get_map'], host: host(4000), limits: { responseBytes: 4000 } });
    expect(n).toBe(1);
    expect(full.ledger!.entries.map((e) => [e.state, e.refusal])).toEqual([['failed', null], ['refused', 'response-budget-exhausted']]);
    n = 0;
    const under = await runW(fixtureLoc(), { code, methods: ['get_map'], host: host(3999), limits: { responseBytes: 4000 } });
    expect(n).toBe(2);
    expect(under.ledger!.entries.map((e) => e.state)).toEqual(['failed', 'failed']);
  });

  it('an unknown outcome with observed bytes charges them and keeps the lease', async () => {
    const sched = new S.SessionScheduler();
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => ({ kind: 'unknown', observedBytes: 1234 }) }, sched);
    expect(r.ledger).toMatchObject({ hostBytes: 1234, unknown: 1, entries: [{ state: 'unknown', unknownWhy: 'host-unknown', responseBytes: 1234 }] });
    expect(sched.holder).not.toBeNull();
  });

  it('an invalid observedBytes makes the receipt malformed (unknown), never a settled ok', async () => {
    const r = await runW(fixtureLoc(), { code: 'try { await parley.get_map({}); } catch (e) { return e.message; }', methods: ['get_map'], host: async () => ({ kind: 'ok', text: '{}', observedBytes: -1 }) as never });
    expect(r.ledger!.entries[0]).toMatchObject({ state: 'unknown', unknownWhy: 'malformed-settlement' });
  });
});

describe.skipIf(!supported || !hasCc)('T5b2: the preflight runs under the lease, inside the wall', () => {
  it('an ok preflight lets the run go on; its bytes are reported, never charged to a call', async () => {
    let signalSeen: AbortSignal | null = null;
    const r = await runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: async () => ({ kind: 'ok', text: '{}', observedBytes: 2 }), preflight: async (signal) => { signalSeen = signal; return { ok: true, bytes: 4321 }; } });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', preflight: { ok: true, bytes: 4321 }, ledger: { hostBytes: 2 } });
    expect(signalSeen).not.toBeNull();
  });

  it('a refusing, throwing or malformed preflight: unavailable, nothing spawned, zero calls, the lease goes', async () => {
    for (const preflight of [async () => ({ ok: false, bytes: 9 }), async () => { throw new Error('x'); }, async () => ({ ok: true }) as never, () => { throw new Error('sync'); }]) {
      const sched = new S.SessionScheduler();
      let hosted = 0;
      const r = await runW(fixtureLoc(), { code: 'return await parley.get_map({})', methods: ['get_map'], host: async () => { hosted++; return { kind: 'ok', text: '{}' }; }, preflight: preflight as never }, sched);
      expect(r).toMatchObject({ status: 'unavailable', reason: 'preflight refused the run', spawned: false, hostCalls: 0, cleanup: 'none' });
      expect(hosted).toBe(0);
      await r.drained;
      expect(sched.holder).toBeNull();
    }
  });

  it('a preflight that never settles: the deadline-triggered result is wall-time with cleanup pending; busy names it; a late settle releases', async () => {
    const sched = new S.SessionScheduler();
    let release!: (v: { ok: boolean; bytes: number }) => void;
    let signal: AbortSignal | null = null;
    const t = Date.now();
    const r = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 1500 }, preflight: (s) => { signal = s; return new Promise((res) => { release = res; }); } }, sched);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r).toMatchObject({ status: 'wall-time', cleanup: 'pending', spawned: false, hostCalls: 0, preflight: null, runStatus: null });
    expect(signal!.aborted).toBe(true);
    expect(await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost }, sched)).toMatchObject({ status: 'busy', reason: expect.stringMatching(/^busy: previous run preflight pending/) });
    let drained = false;
    void r.drained!.then(() => { drained = true; });
    await settle(200);
    expect(drained).toBe(false);
    release({ ok: true, bytes: 1 });
    await r.drained;
    expect(sched.holder).toBeNull();
  }, 15_000);

  it('a caller abort while the preflight is pending: cancelled with cleanup pending, the lease held until it settles', async () => {
    const sched = new S.SessionScheduler();
    const ctl = new AbortController();
    let release!: () => void;
    setTimeout(() => ctl.abort(), 200);
    const r = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost, signal: ctl.signal, preflight: () => new Promise((res) => { release = () => res({ ok: false, bytes: 0 }); }) }, sched);
    expect(r).toMatchObject({ status: 'cancelled', cleanup: 'pending', spawned: false });
    expect(sched.holder).not.toBeNull();
    release();
    await r.drained;
    expect(sched.holder).toBeNull();
  }, 15_000);

  /** Preflight answers that must be read as a failed preflight without throwing. */
  const hostileReports = (): unknown[] => [
    new Proxy({ ok: true, bytes: 1 }, { getPrototypeOf: () => { throw new Error('trap'); } }),
    new Proxy({ ok: true, bytes: 1 }, {}),
    Object.defineProperty({ bytes: 1 }, 'ok', { get: () => { throw new Error('getter'); }, enumerable: true }),
    Object.defineProperty({ bytes: 1 }, 'ok', { get: () => true, enumerable: true }),
    { ok: true, bytes: 1, extra: 1 },
    { ok: true, bytes: -1 },
    { ok: 1, bytes: 1 },
    { get then() { throw new Error('then'); } },
  ];

  it('a hostile or malformed report before the deadline is a failed preflight: unavailable, and the lease goes', async () => {
    for (const report of hostileReports()) {
      const sched = new S.SessionScheduler();
      const r = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost, preflight: () => Promise.resolve(report) as never }, sched);
      expect(r).toMatchObject({ status: 'unavailable', reason: 'preflight refused the run', spawned: false });
      await r.drained;
      expect(sched.holder).toBeNull();
    }
  });

  it('a hostile report that arrives after the deadline still releases the held lease (the late observer cannot be stranded)', async () => {
    for (const report of hostileReports()) {
      const sched = new S.SessionScheduler();
      let release!: (v: unknown) => void;
      const r = await runW(fixtureLoc(), { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 300 }, preflight: () => new Promise((res) => { release = res; }) as never }, sched);
      expect(r).toMatchObject({ status: 'wall-time', cleanup: 'pending' });
      expect(sched.holder).not.toBeNull();
      release(report);
      await r.drained;
      expect(sched.holder).toBeNull();
    }
  }, 20_000);

  describe('r2 P1: time is checked before the preflight verdict', () => {
    const at = (preflight: (signal: AbortSignal, jump: () => void) => Promise<unknown>, signal?: AbortSignal) => {
      let offset = 0;
      const jump = () => { offset = 1e9; };
      return H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map'], host: echoHost, ...(signal ? { signal } : {}), preflight: ((s: AbortSignal) => preflight(s, jump)) as never }, new S.SessionScheduler(), () => performance.now() + offset);
    };

    it('a refusal that settles after the monotonic deadline is wall-time, not unavailable; its report is kept', async () => {
      const r = await at(async (_s, jump) => { jump(); return { ok: false, bytes: 5 }; });
      expect(r).toMatchObject({ status: 'wall-time', reason: 'stopped after the preflight', spawned: false, preflight: { ok: false, bytes: 5 } });
    }, 15_000);

    it('a malformed report after the deadline is wall-time too', async () => {
      const r = await at(async (_s, jump) => { jump(); return { ok: 'no' }; });
      expect(r).toMatchObject({ status: 'wall-time', spawned: false, preflight: { ok: false, bytes: 0 } });
    }, 15_000);

    it('a refusal before the deadline is unavailable', async () => {
      const r = await at(async () => ({ ok: false, bytes: 5 }));
      expect(r).toMatchObject({ status: 'unavailable', reason: 'preflight refused the run', preflight: { ok: false, bytes: 5 } });
    }, 15_000);

    it('a preflight that aborts the run synchronously and refuses is cancelled, not unavailable; the lease still goes', async () => {
      const sched = new S.SessionScheduler();
      const ctl = new AbortController();
      const r = await H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map'], host: echoHost, signal: ctl.signal, preflight: () => { ctl.abort(); return Promise.resolve({ ok: false, bytes: 1 }); } }, sched);
      expect(r).toMatchObject({ status: 'cancelled', spawned: false });
      expect(r.status).not.toBe('unavailable');
      await r.drained;
      expect(sched.holder).toBeNull();
    }, 15_000);
  });

  it('the deadline crossed during the preflight is checked after it settles, before any spawn', async () => {
    let offset = 0;
    const r = await H.runWith(fixtureLoc(), { validators: VAL, apiRevision: REV, code: 'return 1', methods: ['get_map'], host: echoHost, preflight: async () => { offset = 1e9; return { ok: true, bytes: 3 }; } }, new S.SessionScheduler(), () => performance.now() + offset);
    expect(r).toMatchObject({ status: 'wall-time', reason: 'stopped after the preflight', spawned: false, preflight: { ok: true, bytes: 3 } });
  }, 15_000);
});

// ----- Helper exit (s-292 m-7569; cause: s-306 hf-diag) -----
// helper-entry wrote `done` with process.stdout.write and then called process.exit(0): a pipe write still queued at that moment was
// dropped, so the parent read only a prefix of the line (8 KiB on Node 22.16.0, 64 KiB on 22.23.3) and reported a crash.

describe.skipIf(!supported || !hasCc)('helper exit: the final line is written whole before the helper exits', () => {
  /** A guest whose final value is exactly `bytes` bytes of JSON text (a string of x). */
  const sized = (bytes: number): string => `return ${JSON.stringify('x')}.repeat(${bytes - 2})`;

  it.each([8000, 12000, 16384])('the real helper delivers a %i-byte final value whole', async (bytes) => {
    const r = await runW(fixtureLoc(), { code: sized(bytes), methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed', hostCalls: 0 });
    expect(Buffer.byteLength(r.outcome!.value!, 'utf8')).toBe(bytes);
  }, 20_000);

  it('the largest done line the parent allows (a 16384-byte value of backslashes, about 32 KiB once escaped) arrives whole', async () => {
    // The parent caps resultBytes at 16384 (lower-only overrides), so escaping is the only way the done line grows past it.
    const r = await runW(fixtureLoc(), { code: `return ${JSON.stringify('\\')}.repeat(8191)`, methods: ['get_map'], host: echoHost });
    expect(r).toMatchObject({ status: 'finished', runStatus: 'completed' });
    expect(r.outcome!.value).toBe(JSON.stringify('\\'.repeat(8191)));
    expect(Buffer.byteLength(r.outcome!.value!, 'utf8')).toBe(16_384);
  }, 20_000);

  it('while nobody reads its stdout, the real helper waits with the line instead of exiting without it, then delivers all of it', async () => {
    // The built entry under plain Node (no sandbox: this checks only the write path). After `probed` the reader stops.
    const G = (await import(distUrl('mcp/code-mode/guest.js'))) as { GUEST_LIMITS: Record<string, number> };
    const secret = path.join(tmp, 'exit-secret');
    writeFileSync(secret, 's');
    const child = spawn(process.execPath, [path.join(coreDir, 'dist/mcp/code-mode/helper-entry.js')], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    const chunks: Buffer[] = [];
    const probed = new Promise<void>((resolve) => {
      child.stdout.on('data', (d: Buffer) => { chunks.push(d); if (Buffer.concat(chunks).includes(0x0a)) resolve(); });
    });
    const closed = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    child.stdin.write(`${JSON.stringify({ t: 'probe', tcpPort: 9, udpPort: 9, tcp6Port: 9, udp6Port: 9, unixPath: path.join(tmp, 'no-such-socket'), secretFile: secret })}\n`);
    await probed;
    child.stdout.pause();
    const bytes = 300_000;
    child.stdin.write(`${JSON.stringify({ t: 'run', code: sized(bytes), methods: [], limits: { ...G.GUEST_LIMITS, resultBytes: bytes } })}\n`);
    await settle(4000);
    // Exiting here would drop most of the line: the helper must still be there, blocked on its write.
    expect([child.exitCode, child.signalCode]).toEqual([null, null]);
    child.stdout.resume();
    expect(await closed).toBe(0);
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    const done = JSON.parse(lines.at(-2)!) as { t: string; ok: boolean; value: string };
    expect([done.t, done.ok, Buffer.byteLength(done.value, 'utf8')]).toEqual(['done', true, bytes]);
  }, 30_000);

  it('handed a non-blocking stdout, the real helper still blocks on its write and delivers the whole line before it exits', async () => {
    // A FIFO opened O_NONBLOCK as the child's stdout. The spawn makes the child's stdio blocking again; the helper relies on that
    // (an EAGAIN would end it without `done`), so this pins it: still alive with the line pending, then all of it, exit 0.
    const G = (await import(distUrl('mcp/code-mode/guest.js'))) as { GUEST_LIMITS: Record<string, number> };
    const secret = path.join(tmp, 'exit-secret-nb');
    writeFileSync(secret, 's');
    const fifo = path.join(tmp, 'exit-fifo');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const rd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const wr = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    const child = spawn(process.execPath, [path.join(coreDir, 'dist/mcp/code-mode/helper-entry.js')], { stdio: ['pipe', wr, 'ignore'], env: {} });
    closeSync(wr);
    const closed = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(65536);
    /** Reads what is there; true at end of file (every writer closed). */
    const drain = (): boolean => {
      for (;;) {
        let n: number;
        try { n = readSync(rd, buf, 0, buf.length, null); } catch (e) { if ((e as { code?: string }).code === 'EAGAIN') return false; throw e; }
        if (n === 0) return true;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
    };
    try {
      child.stdin.write(`${JSON.stringify({ t: 'probe', tcpPort: 9, udpPort: 9, tcp6Port: 9, udp6Port: 9, unixPath: path.join(tmp, 'no-such-socket'), secretFile: secret })}\n`);
      while (!Buffer.concat(chunks).includes(0x0a)) { drain(); await settle(20); }
      const bytes = 300_000;
      child.stdin.write(`${JSON.stringify({ t: 'run', code: sized(bytes), methods: [], limits: { ...G.GUEST_LIMITS, resultBytes: bytes } })}\n`);
      await settle(4000);
      expect([child.exitCode, child.signalCode]).toEqual([null, null]);
      while (!drain()) await settle(5);
      expect(await closed).toBe(0);
      const lines = Buffer.concat(chunks).toString('utf8').split('\n');
      expect(lines.at(-1)).toBe('');
      const done = JSON.parse(lines.at(-2)!) as { t: string; ok: boolean; value: string };
      expect([done.t, done.ok, Buffer.byteLength(done.value, 'utf8')]).toEqual(['done', true, bytes]);
    } finally {
      child.kill('SIGKILL');
      closeSync(rd);
    }
  }, 30_000);

  it('a helper stuck in a blocking write never holds the run: the run wall deadline ends it', async () => {
    // A synchronous wait that never returns stands for a write the parent never drains: no event loop, no signal handler.
    const body = `await next(); send({ t: 'probed', probes: DENIED }); await next(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`;
    const started = Date.now();
    const r = await runW(forged('blocked-write', body), { code: 'return 1', methods: ['get_map'], host: echoHost, limits: { wallMs: 1500 } });
    expect(r).toMatchObject({ status: 'wall-time', hostCalls: 0, outcome: null });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);
});
