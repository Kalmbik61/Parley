// A replacement launch whose client went (plan T8h §4, C1): the real server.js, its real stdio transport, real helper, ledger and run record. Only two things
// are patched in, at load, by a preload written here: a broker for the live backend (T12a brings the real one; the fixture policy says allow) and, for 4c, shorter
// limits. Everything is measured from a real process's stdin closing, which is what a client's end looks like to it.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { type AgentHost, type Script, okEnvelope, startAgentHost } from '../../../../tests/fixtures/code-mode/agent-host.js';
import { launchDecisionPath, newLaunchNonce, selectExposure, writeLaunchDecision } from './code-mode/launch-decision.js';
import { inspectRunRecord, runRecordPath } from './code-mode/run-record.js';
import { TOOLS } from './tools.js';

const coreDir = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(coreDir, 'dist/mcp/server.js');
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec') && existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));
if (!supported) console.warn('code-mode-client-gone.test: NOT RUN — needs darwin/arm64 sandbox-exec and the built product probe');

beforeAll(() => { if (supported) execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir }); }, 120_000);

let root: string;
let workDir: string;
let sessionId: string;
const was = process.env['PARLEY_HOME'];
const hosts: AgentHost[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'parley-t8h-gone-'));
  const project = path.join(root, 'project');
  mkdirSync(project);
  process.env['PARLEY_HOME'] = path.join(root, 'home');
  const workId = (await createWork(project, { title: 'T8h' })).work.id;
  await updateMap(project, workId, (map) => { const s = addSession(map, { provider: 'claude', label: 'lead', task: 'Check' }); transitionSession(map, s.id, 'active'); sessionId = s.id; });
  workDir = workPaths(project, workId).dir;
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  if (was === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = was;
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => { for (const c of children) c.kill('SIGKILL'); });

/**
 * The broker T12a will bring, over the fixture's allow, and optional shorter limits; the registry proves the five, since only a proven method has a
 * guest stub (T11 B0). Anchors are checked: a moved line fails the test, not the point of it.
 */
function preload(limits: { attemptMs?: number; wallMs?: number } = {}): string {
  const file = path.join(root, `preload-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, `import { registerHooks } from 'node:module';
const patch = (source, from, to) => { if (!source.includes(from)) throw new Error('anchor: ' + from); return source.replace(from, to); };
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/mcp/code-mode/migration-registry.js')) return { ...result, source: patch(String(result.source), 'proven: Object.freeze([])', "proven: Object.freeze(['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room'])") };
  if (url.endsWith('/mcp/code-mode-tools.js')) {
    let s = patch(String(result.source), 'broker: null })', 'broker: FIXTURE_BROKER(catalog, launchId) })');
    ${limits.wallMs === undefined ? '' : `s = patch(s, 'broker.run(request.code, request.apiRevision, signal)', 'broker.run(request.code, request.apiRevision, signal, { wallMs: ${limits.wallMs} })');`}
    s = \`import { createBroker as CB_ } from './code-mode/broker.js'; import { claimFixtureSourceMint as M_ } from './code-mode/native-policy.js'; const MINT_ = M_();
const FIXTURE_BROKER = (catalog, launchId) => CB_({ source: MINT_('fixture', { revision: () => 'r', decide: () => 'allow' }), catalog, launchId, agent: { url: process.env.PARLEY_AGENT_URL, token: process.env.PARLEY_AGENT_TOKEN }, launch: {}, hold: { workDir: process.env.PARLEY_WORK_DIR, sessionId: process.env.PARLEY_SESSION_ID } });\\n\` + s;
    return { ...result, source: s };
  }
  ${limits.attemptMs === undefined ? '' : `if (url.endsWith('/mcp/remote-tools.js')) return { ...result, source: patch(String(result.source), 'const CALL_TIMEOUT_MS = 120_000;', 'const CALL_TIMEOUT_MS = ${limits.attemptMs};') };`}
  return result;
} });
`);
  return file;
}

const READ_RESULT = okEnvelope({ content: [{ type: 'text', text: '{"map":1}' }] });
type Reply = Awaited<ReturnType<Script>>;
/** `list` answers with the real tools, so the real catalogue is built from it; each call request gets `call(n, body)`. */
const script = (call: (n: number, body: Record<string, unknown>) => Reply | Promise<Reply>): Script => {
  let n = 0;
  return (r) => {
    const body = JSON.parse(r.raw) as Record<string, unknown>;
    return body['op'] === 'list' ? { body: okEnvelope({ tools: TOOLS }) } : call(++n, body);
  };
};
const startHost = async (s: Script): Promise<AgentHost> => { const h = await startAgentHost(s); hosts.push(h); return h; };
const callsOf = (h: AgentHost): Record<string, unknown>[] => h.log.map((x) => JSON.parse(x.raw) as Record<string, unknown>).filter((b) => b['op'] === 'call');
const gate = (): { wait: Promise<void>; open: () => void } => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 20_000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };

interface Server {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  isAlive(): boolean;
  request(method: string, params?: unknown): Promise<{ result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }>;
  execute(code: string): Promise<{ result?: { content?: { text: string }[]; isError?: boolean } }>;
  /** What a client's end looks like: stdin closes; with `stdout`, the pipe it read from goes as well. */
  closeClient(options?: { stdout?: boolean }): void;
}

async function launch(h: AgentHost, options: { nonce?: string; preload?: string } = {}): Promise<Server> {
  const env: Record<string, string> = { PATH: process.env['PATH']!, HOME: process.env['HOME']!, PARLEY_HOME: process.env['PARLEY_HOME']!, PARLEY_WORK_DIR: workDir, PARLEY_SESSION_ID: sessionId, PARLEY_AGENT_URL: `${h.agent.url}/agent/browser`, PARLEY_AGENT_TOKEN: h.agent.token, ...(options.nonce === undefined ? {} : { PARLEY_CODE_MODE_LAUNCH: options.nonce }) };
  const child = spawn(process.execPath, [...(options.preload === undefined ? [] : ['--import', options.preload]), entry], { stdio: ['pipe', 'pipe', 'ignore'], env });
  children.push(child);
  child.stdout!.on('error', () => undefined);
  child.stdin!.on('error', () => undefined);
  let alive = true;
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => { alive = false; resolve(code); }); });
  let id = 0;
  const waiting = new Map<number, (v: never) => void>();
  let buffered = '';
  child.stdout!.on('data', (d: Buffer) => {
    buffered += d.toString();
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const m = JSON.parse(buffered.slice(0, at)) as { id?: number };
      buffered = buffered.slice(at + 1);
      if (m.id !== undefined) waiting.get(m.id)?.(m as never);
    }
  });
  const request: Server['request'] = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve as never); child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child, exited, request, isAlive: () => alive,
    async execute(code) {
      const found = await request('tools/call', { name: 'code_search', arguments: { query: 'get_map' } });
      const apiRevision = (JSON.parse(found.result!.content![0]!.text) as { apiRevision: string }).apiRevision;
      return request('tools/call', { name: 'code_execute', arguments: { code, apiRevision } });
    },
    closeClient(o = {}) { child.stdin!.end(); if (o.stdout === true) child.stdout!.destroy(); },
  };
}
const decided = (): string => { const nonce = newLaunchNonce(); expect(writeLaunchDecision(workDir, sessionId, { v: 1, nonce, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: new Date().toISOString() })).toBe(true); return nonce; };
const lines = (): Record<string, unknown>[] => readFileSync(runRecordPath(workDir, sessionId), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const pidsUnder = (pid: number): number[] => {
  try { return execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
};
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const LOOP = 'for (let i = 0; i < 20; i++) { try { await parley.get_map({}); } catch {} } return 1;';
const T = 60_000;

describe.skipIf(!supported)('a replacement launch whose client went', () => {
  it.each([[false], [true]])('4a, a script in a read loop, stdout closed too: %s. No further call reaches the host, alive until the started read lands, then exit 0', async (stdout) => {
    const held = gate();
    const h = await startHost(script(async (n) => { if (n === 3) await held.wait; return { body: READ_RESULT }; }));
    const server = await launch(h, { nonce: decided(), preload: preload() });
    void server.execute(LOOP);
    await until(() => callsOf(h).length === 3);
    const helpers = pidsUnder(server.child.pid!);
    const closed = performance.now();
    server.closeClient({ stdout });
    await settle(1500);
    expect(server.isAlive()).toBe(true);
    expect(callsOf(h)).toHaveLength(3);
    expect(lines().filter((l) => l['o'] === 3)).toEqual([expect.objectContaining({ m: 'get_map' })]);
    const released = performance.now();
    held.open();
    expect(await server.exited).toBe(0);
    const out = performance.now();
    console.log(`[T8h time to 0] 4a stdout closed ${stdout}: closed to exit ${Math.round(out - closed)} ms, receipt released to exit ${Math.round(out - released)} ms`);
    expect(callsOf(h)).toHaveLength(3);
    expect(lines().filter((l) => l['o'] === 3 && 's' in l)).toEqual([{ o: 3, s: 'succeeded' }]);
    // The record says what happened: everything accounted, the holder gone. The next launch may run.
    expect(inspectRunRecord(workDir, sessionId)).toEqual({ kind: 'free' });
    // The helper does not outlive its parent.
    await until(() => helpers.every((p) => !running(p)));
  }, T);

  it('4b, stdin closed after a run that ended unknown (a reset after the body left, then a 404), now idle: exits at once, the record keeps its unknown, and the next launch is classic', async () => {
    // A 404 alone is no longer unknown (spec §5.2); after a reset it is, because the first attempt may have run (s-296 m-7463).
    const h = await startHost(script((n) => (n === 1 ? { drop: 'before-headers' } : { status: 404 })));
    const server = await launch(h, { nonce: decided(), preload: preload() });
    const answer = await server.execute('try { await parley.get_map({}); } catch {} return 1;');
    expect(JSON.parse(answer.result!.content![0]!.text)).toMatchObject({ status: 'partial-or-unknown', operations: [{ outcome: 'unknown' }] });
    const before = readFileSync(runRecordPath(workDir, sessionId), 'utf8');
    const closed = performance.now();
    server.closeClient({ stdout: true });
    expect(await server.exited).toBe(0);
    console.log(`[T8h time to 0] 4b: closed to exit ${Math.round(performance.now() - closed)} ms`);
    expect(readFileSync(runRecordPath(workDir, sessionId), 'utf8')).toBe(before);
    expect(lines()).toContainEqual({ o: 1, s: 'unknown' });
    const view = inspectRunRecord(workDir, sessionId);
    expect(view).toEqual({ kind: 'unaccounted', methods: ['get_map'] });
    expect(selectExposure({ requested: true, refused: null, record: view })).toEqual({ effective: 'classic', reason: 'held-run', held: 'unaccounted' });
    expect(callsOf(h)).toHaveLength(2);
  }, T);

  it('4b-404, a host without the tools route answers the only attempt with 404: unavailable, nothing dispatched, the record settles and the next launch is not held', async () => {
    const h = await startHost(script(() => ({ status: 404 })));
    const server = await launch(h, { nonce: decided(), preload: preload() });
    const answer = JSON.parse((await server.execute('return await parley.get_map({});')).result!.content![0]!.text) as Record<string, unknown>;
    expect(answer).toMatchObject({ status: 'error', error: { kind: 'unavailable' }, operations: [{ ordinal: 1, method: 'get_map', dispatched: false, outcome: 'refused' }] });
    expect(JSON.stringify(answer)).not.toContain('Check');
    expect(callsOf(h)).toHaveLength(1);
    // Settled: the refusal is an accounting line and the record is released, so the next launch is not held.
    const view = inspectRunRecord(workDir, sessionId);
    expect(view).toEqual({ kind: 'free' });
    expect(selectExposure({ requested: true, refused: null, record: view })).toMatchObject({ effective: 'replacement' });
    server.closeClient({ stdout: true });
    expect(await server.exited).toBe(0);
  }, T);

  it('4c, a hanging call and shorter limits, both pipes closed: alive through the attempts, exits only when the call ends unknown', async () => {
    const h = await startHost(script(() => ({ hang: true })));
    const WALL = 6000;
    const server = await launch(h, { nonce: decided(), preload: preload({ attemptMs: 1500, wallMs: WALL }) });
    void server.execute('await parley.get_map({}); return 1;');
    await until(() => callsOf(h).length === 1);
    const called = performance.now();
    server.closeClient({ stdout: true });
    await settle(3000);
    expect(server.isAlive()).toBe(true);
    expect(lines().filter((l) => l['o'] === 1 && 's' in l)).toEqual([]);
    expect(await server.exited).toBe(0);
    const took = performance.now() - called;
    console.log(`[T8h time to 0] 4c, attempt 1500 ms, wall ${WALL} ms: call to exit ${Math.round(took)} ms, ${callsOf(h).length} attempts`);
    expect(took).toBeGreaterThanOrEqual(WALL - 1000);
    expect(lines()).toContainEqual({ o: 1, s: 'unknown' });
    expect(inspectRunRecord(workDir, sessionId)).toEqual({ kind: 'unaccounted', methods: ['get_map'] });
    // Retries carry one call id: one call, however many attempts.
    expect(new Set(callsOf(h).map((c) => c['callId'])).size).toBe(1);
  }, T);

  it('4d, a live holder and a new launch: classic, the holder is untouched, its later terminal line lands, and nothing was cancelled', async () => {
    const held = gate();
    const h = await startHost(script(async () => { await held.wait; return { body: READ_RESULT }; }));
    const nonce = decided();
    const holder = await launch(h, { nonce, preload: preload() });
    const answered = holder.execute('await parley.get_map({}); return 1;');
    await until(() => callsOf(h).length === 1);
    const file = runRecordPath(workDir, sessionId);
    const before = { text: readFileSync(file, 'utf8'), st: lstatSync(file).ino };

    const view = inspectRunRecord(workDir, sessionId);
    expect(view).toEqual({ kind: 'held-live', methods: ['get_map'] });
    const chosen = selectExposure({ requested: true, refused: null, record: view });
    expect(chosen).toEqual({ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' });
    expect({ text: readFileSync(file, 'utf8'), st: lstatSync(file).ino }).toEqual(before);

    // The launcher's classic launch: a new decision with no nonce, a server with no Code Mode variable at all.
    expect(writeLaunchDecision(workDir, sessionId, { v: 1, nonce: null, effective: 'classic', requested: true, reason: 'held-run', provider: 'claude', at: new Date().toISOString() })).toBe(true);
    const classic = await launch(h);
    const listed = await classic.request('tools/list');
    expect(listed.result!.tools!.map((t) => t.name)).toContain('get_map');
    expect(listed.result!.tools!.map((t) => t.name)).not.toContain('code_execute');
    expect(holder.isAlive()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before.text);

    held.open();
    const answer = await answered;
    expect(JSON.parse(answer.result!.content![0]!.text)).toMatchObject({ status: 'completed', operations: [{ outcome: 'succeeded' }] });
    // Its quiescence removes its own record, so a later launch can differ.
    await until(() => !existsSync(file));
    expect(inspectRunRecord(workDir, sessionId)).toEqual({ kind: 'free' });
    expect(holder.isAlive()).toBe(true);
    holder.closeClient();
    expect(await holder.exited).toBe(0);
    classic.closeClient();
    expect(await classic.exited).toBe(0);
  }, T);

  it('a replacement launch with nothing running exits at once, a pending direct call included: its client is gone, and it has no ledger entry', async () => {
    const h = await startHost(script(() => ({ hang: true })));
    const server = await launch(h, { nonce: decided(), preload: preload() });
    void server.request('tools/call', { name: 'report', arguments: { status: 'progress', summary: 'x' } });
    await until(() => callsOf(h).length === 1);
    const closed = performance.now();
    server.closeClient();
    expect(await server.exited).toBe(0);
    expect(performance.now() - closed).toBeLessThan(1500);
    expect(existsSync(runRecordPath(workDir, sessionId))).toBe(false);
  }, T);
});

describe('4e, a classic launch: stdin close behaves as it did', () => {
  it('idle: the process ends by itself', async () => {
    const h = await startHost(script(() => ({ body: READ_RESULT })));
    const server = await launch(h);
    await server.request('tools/list');
    server.closeClient();
    expect(await server.exited).toBe(0);
  }, T);
  it('a direct call in flight: it lingers while the socket keeps it alive, and ends when the call does. Nothing here exits it', async () => {
    const held = gate();
    const h = await startHost(script(async () => { await held.wait; return { body: READ_RESULT }; }));
    const server = await launch(h);
    void server.request('tools/call', { name: 'report', arguments: { status: 'progress', summary: 'x' } });
    await until(() => callsOf(h).length === 1);
    server.closeClient();
    await settle(1000);
    expect(server.isAlive()).toBe(true);
    held.open();
    expect(await server.exited).toBe(0);
  }, T);
  it('no nonce, old decision file: classic, with the same lingering: the watcher belongs to replacement only', async () => {
    const held = gate();
    const h = await startHost(script(async () => { await held.wait; return { body: READ_RESULT }; }));
    decided();
    const server = await launch(h);
    expect((await server.request('tools/list')).result!.tools!.map((t) => t.name)).not.toContain('code_execute');
    void server.request('tools/call', { name: 'report', arguments: { status: 'progress', summary: 'x' } });
    await until(() => callsOf(h).length === 1);
    server.closeClient();
    await settle(800);
    expect(server.isAlive()).toBe(true);
    held.open();
    expect(await server.exited).toBe(0);
    expect(existsSync(launchDecisionPath(workDir, sessionId))).toBe(true);
  }, T);
});
