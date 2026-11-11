// T9a harness, slice H2b: the host the arms talk to. The REAL `createToolsEndpoint` and token registry answer from the arm's host store; this module
// wraps the HTTP server around them to keep the raw log, to hold receipts (`holdReceipts`) and to put a goal's `host` fault on the reply. It starts no
// child process and fires no timer: every fault fires on a request count or a receipt (R5).
//
// What a fault does to the REAL handler, decided here and pinned by the tests:
//   404, 401, 503 (the first of `503-then-ok`)  the request is answered by the wrapper and never reaches the real handler: no handler starts
//   hang, drop-before-headers, drop-mid-body,   the real handler runs to its answer; the answer is withheld, cut off, or replaced: a handler started
//   malformed                                   and its reply was lost, which is what a retry of the same callId has to survive
// `handlerStarted` is true only when the real tool runner's `call` began (see `withHandlerProbe`), never because a request arrived.
//
// The store is the process's `PARLEY_HOME`, one shared variable: `startReplayHost` points it at the arm's host store and `close` puts it back, so nothing
// else may switch the home while a host is up (restore the arm's data BEFORE starting the host).

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { closeWorkDb } from '../packages/core/dist/work/db.js';
import { createBrowserEndpoint } from '../packages/host/src/agent/browser-endpoint.js';
import { hostToolContext } from '../packages/host/src/agent/tool-context.js';
import { createToolsEndpoint } from '../packages/host/src/agent/tools-endpoint.js';
import type { Log } from '../packages/host/src/log.js';
import type { BuiltData } from './parley-token-benchmark-replay-data.js';
import type { FaultKey, HostEntry } from './parley-token-benchmark-replay-judge.js';
import { onHandlerStart } from './parley-token-benchmark-replay-probe.js';
import type { Obj } from './parley-token-benchmark-replay-schema.js';

// ---------- the host ----------

export type HostReply = 'ok' | '404' | '401' | '503-then-ok' | 'hang' | 'drop-before-headers' | 'drop-mid-body' | 'malformed';

export interface ReplayHost {
  /** What the child gets as `PARLEY_AGENT_URL` and `PARLEY_AGENT_TOKEN`. */
  readonly agent: { readonly url: string; readonly token: string };
  /** The raw log, in arrival order, as the judge reads it; a fresh copy each time (`handlerStarted` can change after the entry was made). */
  log(): readonly HostEntry[];
  /** `seq` of the request a fault fired at; absent when it never fired. */
  readonly firedAtSeq: Readonly<Partial<Record<FaultKey, number>>>;
  /** The most calls received and not yet answered at one moment (held or running); null unless the goal holds receipts. */
  maxPending(): number | null;
  /** Called synchronously for the nth call received, after it is logged and before it is served: how `abort`, `kill-helper` and a mid-run policy fire. */
  onCall(listener: (n: number, entry: HostEntry) => void): void;
  /** Replaces the `host` fault from now on (a reply that is lost once and then not). */
  setHostFault(fault: Obj): void;
  /** Records that a fault the runner acts on has fired, at the last request logged so far. */
  markFired(key: FaultKey): void;
  /** Holds the nth call received until the returned function is called (a call that is already held is released at once if it was released before). */
  holdCall(n: number): () => void;
  /** Releases anything held, closes the server, forgets the store, and gives `PARLEY_HOME` back. */
  close(): Promise<void>;
}

interface Row { seq: number; op: 'call' | 'list'; callId: string | null; method: string | null; forwarded: boolean; handlerStarted: boolean }

const SILENT: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MALFORMED = '<<not json>>';

/** Starts the host for one arm: the real endpoint over `built.hostHome`, the caller being `built.selfId`. */
export async function startReplayHost(built: BuiltData, faults: Obj): Promise<ReplayHost> {
  const was = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = built.hostHome;
  closeWorkDb();
  const registry = createBrowserEndpoint({ log: SILENT, clients: () => [], roomsOf: () => [] });
  const ref = { projectPath: built.project, workId: built.workId, sessionId: built.selfId };
  const token = registry.register(ref);
  const endpoint = createToolsEndpoint({
    authenticate: (req) => registry.authenticate(req),
    contextFor: (target, launch) => hostToolContext(target, launch, { providerRows: async () => [], onWorksChange: () => () => undefined }),
    log: SILENT,
  });

  const rows: Row[] = [];
  const fired: Partial<Record<FaultKey, number>> = {};
  const listeners: ((n: number, entry: HostEntry) => void)[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let hostFault = (faults['host'] as Obj | undefined) ?? {};
  const holdN = typeof (faults['holdReceipts'] as Obj | undefined)?.['untilPending'] === 'number' ? ((faults['holdReceipts'] as Obj)['untilPending'] as number) : null;
  let calls = 0;
  let active = 0;
  let peak = 0;
  let holding = holdN !== null;
  let held: (() => void)[] = [];
  const served503 = new Set<string>();
  const gates = new Map<number, { released: boolean; go: (() => void) | null }>();

  // The real handler started for `method`: the oldest forwarded call of that method that has not been matched yet.
  const off = onHandlerStart((method) => {
    const row = rows.find((r) => r.forwarded && !r.handlerStarted && r.method === method);
    if (row !== undefined) row.handlerStarted = true;
  });

  const entryOf = (r: Row): HostEntry => ({ seq: r.seq, op: r.op, callId: r.callId, method: r.method, handlerStarted: r.handlerStarted });
  const markFired = (key: FaultKey): void => { if (fired[key] === undefined) fired[key] = rows.length; };

  /** Which reply the goal's `host` fault puts on this request, `ok` when none. */
  const replyFor = (row: Row, n: number): HostReply => {
    const wanted = (row.op === 'list' ? hostFault['list'] : hostFault['call']) as HostReply | undefined;
    if (wanted === undefined || wanted === 'ok') return 'ok';
    if (row.op === 'call' && typeof hostFault['callMethod'] === 'string' && row.method !== hostFault['callMethod']) return 'ok';
    if (typeof hostFault['afterCalls'] === 'number' && n <= hostFault['afterCalls']) return 'ok';
    if (wanted === '503-then-ok') {
      const key = `${row.op}`;
      if (served503.has(key)) return 'ok';
      served503.add(key);
    }
    return wanted;
  };

  const serve = (req: IncomingMessage, res: ServerResponse, body: Buffer, row: Row, reply: HostReply): void => {
    if (reply !== 'ok') { fired['host'] ??= row.seq; }
    if (reply === '404' || reply === '401') { res.writeHead(Number(reply)); res.end(); return; }
    if (reply === '503-then-ok') { res.writeHead(503); res.end(); return; }
    // the real handler runs with a replay of the body: the wrapper has already read the stream
    const fake = Object.assign(Readable.from([body]), { headers: req.headers, method: req.method, url: req.url, socket: req.socket }) as unknown as IncomingMessage;
    row.forwarded = true;
    if (reply === 'hang') { res.writeHead = (() => res) as never; res.end = (() => res) as never; }
    else if (reply === 'drop-before-headers') { res.writeHead = (() => { req.socket.destroy(); return res; }) as never; res.end = (() => res) as never; }
    else if (reply === 'drop-mid-body') {
      res.end = ((chunk?: unknown) => { const text = String(chunk ?? ''); res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2)))); setImmediate(() => req.socket.destroy()); return res; }) as never;
    } else if (reply === 'malformed') {
      const end = res.end.bind(res) as (c?: unknown) => ServerResponse;
      res.end = (() => end(MALFORMED)) as never;
    }
    endpoint.handle(fake, res);
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let parsed: Obj = {};
      try { parsed = JSON.parse(body.toString('utf8')) as Obj; } catch { /* a body that is not JSON is still a logged request */ }
      const op = parsed['op'] === 'list' ? 'list' : 'call';
      const row: Row = { seq: rows.length + 1, op, callId: op === 'call' && typeof parsed['callId'] === 'string' ? parsed['callId'] : null, method: op === 'call' && typeof parsed['name'] === 'string' ? parsed['name'] : null, forwarded: false, handlerStarted: false };
      rows.push(row);
      if (op === 'list') { serve(req, res, body, row, replyFor(row, calls)); return; }
      const n = ++calls;
      active++;
      peak = Math.max(peak, active);
      res.on('close', () => { active--; });
      for (const l of listeners) l(n, entryOf(row));
      const go = (): void => serve(req, res, body, row, replyFor(row, n));
      const gate = gates.get(n);
      if (gate !== undefined && !gate.released) { gate.go = go; return; }
      if (holding) {
        held.push(go);
        if (held.length >= holdN!) { holding = false; fired['holdReceipts'] ??= row.seq; const release = held; held = []; for (const f of release) f(); }
        return;
      }
      go();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    agent: Object.freeze({ url: `http://127.0.0.1:${port}/agent/browser`, token }),
    log: () => rows.map(entryOf),
    firedAtSeq: fired,
    maxPending: () => (holdN === null ? null : peak),
    onCall: (listener) => { listeners.push(listener); },
    markFired,
    holdCall: (n) => {
      const gate: { released: boolean; go: (() => void) | null } = { released: false, go: null };
      gates.set(n, gate);
      return () => { if (gate.released) return; gate.released = true; const go = gate.go; gate.go = null; go?.(); };
    },
    setHostFault: (fault) => { hostFault = fault; },
    close: async () => {
      off();
      held = [];
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      endpoint.forget(ref);
      closeWorkDb();
      if (was === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = was;
    },
  };
}
