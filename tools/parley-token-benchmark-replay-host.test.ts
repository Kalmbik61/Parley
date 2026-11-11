// T9a harness, slice H2b: the host and its faults, against the REAL tools endpoint and a real built store. No child process: the client is a plain HTTP client.
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BuiltData, buildGoalData, restoreForArm } from './parley-token-benchmark-replay-data.js';
import { type ReplayHost, startReplayHost } from './parley-token-benchmark-replay-host.js';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';

// The endpoint under test reaches the core through the package name, which is the built core: wrap its tool runner so a real `call` is reported.
vi.mock('../packages/core/dist/index.js', async (orig) => (await import('./parley-token-benchmark-replay-probe.js')).withHandlerProbe(await orig()));

let root = '';
let built: BuiltData;
let host: ReplayHost | null = null;
const home = process.env['PARLEY_HOME'];

const DATA = {
  self: 'caller',
  sessions: [{ key: 'caller', label: 'Synthetic caller', provider: 'codex', lifecycle: 'active', task: 'Inspect', summary: 'CALLER-SUMMARY' }, { key: 'peer', label: 'Amber peer', provider: 'claude', lifecycle: 'active', task: 'Review amber', summary: 'AMBER-SUMMARY' }],
  rooms: [{ key: 'amber', title: 'Amber room', lead: 'caller', members: ['caller', 'peer'], messages: [{ from: 'peer', kind: 'note', text: 'AMBER-FIRST' }] }],
};
function goal(): Goal {
  const r = checkGoalFile({ version: 1, goals: [{ id: 'g', class: 'read-dto', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, answer: { value: 'v' }, criteria: [{ answer: { path: 'value', present: true } }] }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.goals[0]!;
}
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'parley-replay-host-'));
  built = await buildGoalData(goal(), path.join(root, 'g'));
  await restoreForArm(built, null);
});
afterEach(async () => {
  if (host !== null) await host.close();
  host = null;
  rmSync(root, { recursive: true, force: true });
});
const start = async (faults: Record<string, unknown> = {}): Promise<ReplayHost> => { host = await startReplayHost(built, faults); return host; };

interface Reply { readonly status: number; readonly text: string }
/** One POST to /agent/tools; an error is a socket that ended before a whole answer. */
function post(h: ReplayHost, body: unknown, options: { token?: string; abortAfterMs?: number } = {}): Promise<Reply | { readonly error: string; readonly partial: string }> {
  return new Promise((resolve) => {
    const url = new URL('/agent/tools', h.agent.url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${options.token ?? h.agent.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      const partial = (): string => Buffer.concat(chunks).toString('utf8');
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: partial() }));
      res.on('error', (e) => resolve({ error: e.message, partial: partial() }));
      res.on('aborted', () => resolve({ error: 'aborted', partial: partial() }));
    });
    req.on('error', (e) => resolve({ error: e.message, partial: '' }));
    if (options.abortAfterMs !== undefined) setTimeout(() => { req.destroy(); resolve({ error: 'client gave up', partial: '' }); }, options.abortAfterMs);
    req.end(payload);
  });
}
const call = (callId: string, name = 'get_map', args: object = {}) => ({ op: 'call', launch: {}, name, args, callId });
const LIST = { op: 'list', launch: {} };
const entries = (h: ReplayHost) => h.log().map((e) => [e.seq, e.op, e.callId, e.method, e.handlerStarted]);
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('the real endpoint behind the wrapper', () => {
  it('answers a list and a call from the host store, and logs both raw: a list has no call id and starts no handler', async () => {
    const h = await start();
    const list = await post(h, LIST) as Reply;
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text)).toMatchObject({ ok: true, result: { tools: expect.any(Array) } });
    const got = await post(h, call('c-1')) as Reply;
    expect(got.status).toBe(200);
    expect(got.text).toContain('Amber peer');
    expect(entries(h)).toEqual([[1, 'list', null, null, false], [2, 'call', 'c-1', 'get_map', true]]);
  });

  it('a retry of a callId the endpoint already answered is absorbed by its replay memory: two log entries, one handler start', async () => {
    const h = await start();
    const first = await post(h, call('c-1')) as Reply;
    const retry = await post(h, call('c-1')) as Reply;
    expect(retry.text).toBe(first.text);
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true], [2, 'call', 'c-1', 'get_map', false]]);
  });

  it('a request the REAL endpoint refuses (a wrong token) arrives and is logged, but no handler starts: arriving is not starting', async () => {
    const h = await start();
    const r = await post(h, call('c-1'), { token: 'not-the-token' }) as Reply;
    expect(r.status).toBe(401);
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', false]]);
  });

  it('the store it answers from is the host copy, not the local one: a canary written locally is not served', async () => {
    await restoreForArm(built, 'LOCAL-ONLY-CANARY');
    const h = await start();
    const got = await post(h, call('c-1')) as Reply;
    expect(got.text).toContain('CALLER-SUMMARY');
    expect(got.text).not.toContain('LOCAL-ONLY-CANARY');
  });

  it('a body that is not JSON is a logged call with no call id, so the judge\'s every-call-has-an-id invariant can see it', async () => {
    const h = await start();
    await post(h, 'not json at all');
    expect(entries(h)).toEqual([[1, 'call', null, null, false]]);
  });
});

describe('the host fault on a reply', () => {
  it('404 and 401 answer without the real handler; a list is its own fault; callMethod and afterCalls narrow it', async () => {
    const h = await start({ host: { call: '404' } });
    expect((await post(h, LIST) as Reply).status).toBe(200);
    expect((await post(h, call('c-1')) as Reply).status).toBe(404);
    expect(entries(h).map((e) => e[4])).toEqual([false, false]);
    expect(h.firedAtSeq.host).toBe(2);
    await h.close(); host = null;
    const lists = await start({ host: { list: '401' } });
    expect((await post(lists, LIST) as Reply).status).toBe(401);
    expect((await post(lists, call('c-1')) as Reply).status).toBe(200);
    await lists.close(); host = null;
    const narrowed = await start({ host: { call: '404', callMethod: 'get_map', afterCalls: 1 } });
    expect((await post(narrowed, call('c-1')) as Reply).status).toBe(200);
    expect((await post(narrowed, call('c-2', 'list_roles')) as Reply).status).toBe(200);
    expect((await post(narrowed, call('c-3')) as Reply).status).toBe(404);
    expect(narrowed.firedAtSeq.host).toBe(3);
  });

  it('503-then-ok: the first request of the kind is 503 and never reaches the handler, the retry is served and starts one', async () => {
    const h = await start({ host: { call: '503-then-ok' } });
    expect((await post(h, call('c-1')) as Reply).status).toBe(503);
    expect((await post(h, call('c-1')) as Reply).status).toBe(200);
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', false], [2, 'call', 'c-1', 'get_map', true]]);
  });

  it('hang: the real handler runs and the answer never comes; the client gives up and the host is no longer holding it', async () => {
    const h = await start({ host: { call: 'hang' } });
    const r = await post(h, call('c-1'), { abortAfterMs: 300 });
    expect(r).toEqual({ error: 'client gave up', partial: '' });
    await settle();
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true]]);
  });

  it('drop-before-headers: the handler ran, the client sees a dead socket; the retry gets the saved result with no second handler start', async () => {
    const h = await start({ host: { call: 'drop-before-headers' } });
    expect('error' in (await post(h, call('c-1')))).toBe(true);
    await settle();
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true]]);
  });

  it('drop-mid-body: the client receives a strict prefix of the answer and then a dead socket; the retry gets the whole answer', async () => {
    const h = await start({ host: { call: 'drop-mid-body' } });
    const cut = await post(h, call('c-1'));
    expect('error' in cut).toBe(true);
    await settle();
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true]]);
    h.setHostFault({});
    const whole = await post(h, call('c-1')) as Reply;
    const partial = (cut as { partial: string }).partial;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(whole.text.length);
    expect(whole.text.startsWith(partial)).toBe(true);
    expect(() => JSON.parse(partial)).toThrow();
  });

  it('malformed: a 200 whose body is not JSON, after the handler ran', async () => {
    const h = await start({ host: { call: 'malformed' } });
    const r = await post(h, call('c-1')) as Reply;
    expect(r.status).toBe(200);
    expect(() => JSON.parse(r.text)).toThrow();
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true]]);
  });

  it('a lost reply is survived by the same callId: once the fault is gone the retry is served from the endpoint\'s memory, one handler start for two attempts', async () => {
    const h = await start({ host: { call: 'drop-before-headers' } });
    expect('error' in (await post(h, call('c-1')))).toBe(true);
    await settle();
    h.setHostFault({});
    const retry = await post(h, call('c-1')) as Reply;
    expect(retry.status).toBe(200);
    expect(retry.text).toContain('Amber peer');
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', true], [2, 'call', 'c-1', 'get_map', false]]);
  });
});

describe('holdReceipts: no call is answered until n are pending', () => {
  it('two concurrent calls are held until both have arrived, then released together; the peak is the limit; the fired seq is the releasing call', async () => {
    const h = await start({ holdReceipts: { untilPending: 2 } });
    const first = post(h, call('c-1'));
    await settle();
    expect(entries(h)).toEqual([[1, 'call', 'c-1', 'get_map', false]]);
    expect(h.firedAtSeq.holdReceipts).toBeUndefined();
    const second = post(h, call('c-2'));
    const both = await Promise.all([first, second]) as Reply[];
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(h.firedAtSeq.holdReceipts).toBe(2);
    expect(h.maxPending()).toBe(2);
    expect(entries(h).map((e) => e[4])).toEqual([true, true]);
  });

  it('a call after the release passes straight through and the peak stays the limit when it arrives alone', async () => {
    const h = await start({ holdReceipts: { untilPending: 2 } });
    await Promise.all([post(h, call('c-1')), post(h, call('c-2'))]);
    await post(h, call('c-3'));
    expect(h.maxPending()).toBe(2);
    expect(entries(h)).toHaveLength(3);
  });

  it('a list is never held, and without the fault there is no peak to report', async () => {
    const held = await start({ holdReceipts: { untilPending: 2 } });
    expect((await post(held, LIST) as Reply).status).toBe(200);
    await held.close(); host = null;
    const plain = await start();
    await post(plain, call('c-1'));
    expect(plain.maxPending()).toBeNull();
  });
});

describe('holdCall: the nth call waits until the runner lets it go', () => {
  it('a held call is not served until released; the calls before and after it are', async () => {
    const h = await start();
    const release = h.holdCall(2);
    const first = await post(h, call('c-1')) as Reply;
    expect(first.status).toBe(200);
    const second = post(h, call('c-2'));
    const third = await post(h, call('c-3')) as Reply;
    expect(third.status).toBe(200);
    let done = false;
    void second.then(() => { done = true; });
    await settle();
    expect(done).toBe(false);
    expect(h.log().filter((e) => e.op === 'call').map((e) => [e.callId, e.handlerStarted])).toEqual([['c-1', true], ['c-2', false], ['c-3', true]]);
    release();
    release();
    expect((await second as Reply).status).toBe(200);
    expect(h.log().find((e) => e.callId === 'c-2')!.handlerStarted).toBe(true);
  });
  it('a call released before it arrives is not held, and the hold does not move the peak count of an ordinary host', async () => {
    const h = await start();
    h.holdCall(1)();
    expect((await post(h, call('c-1')) as Reply).status).toBe(200);
    expect(h.maxPending()).toBeNull();
  });
});

describe('the hooks the runner fires faults from', () => {
  it('onCall sees the nth call after it is logged and before it is served; markFired records the last logged request', async () => {
    const h = await start();
    const seen: [number, number, boolean][] = [];
    h.onCall((n, entry) => { seen.push([n, entry.seq, h.log().length === entry.seq]); if (n === 2) h.markFired('abort'); });
    await post(h, LIST);
    await post(h, call('c-1'));
    await post(h, call('c-2'));
    expect(seen).toEqual([[1, 2, true], [2, 3, true]]);
    expect(h.firedAtSeq.abort).toBe(3);
  });

  it('close gives PARLEY_HOME back, refuses new connections, and releases what was held', async () => {
    const h = await start({ holdReceipts: { untilPending: 3 } });
    expect(process.env['PARLEY_HOME']).toBe(built.hostHome);
    const held = post(h, call('c-1'));
    await settle();
    await h.close(); host = null;
    expect(process.env['PARLEY_HOME']).toBe(home);
    expect('error' in await held).toBe(true);
    expect('error' in await post(h, LIST)).toBe(true);
  });
});
