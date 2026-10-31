import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '@parley/protocol/remote';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Limiter } from '../src/limits.js';
import { createLogger } from '../src/log.js';
import { lanAddress, loadConfig } from '../src/main.js';
import { hashMatches, sha256OfB64 } from '../src/routes.js';
import { createRelay, MAX_FRAME_BYTES, type Relay, type RelayOptions } from '../src/server.js';
import { Store } from '../src/store.js';

const id = (n: number): string => b64urlEncode(randomBytes(n));
const sha = (b64: string): string => b64urlEncode(createHash('sha256').update(Buffer.from(b64, 'base64url')).digest());
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Клиент с очередью сообщений. */
class Client {
  readonly ws: WebSocket;
  private queue: { data: Buffer; binary: boolean }[] = [];
  private waiters: ((m: { data: Buffer; binary: boolean }) => void)[] = [];
  closed: Promise<number>;
  constructor(url: string, opts?: ConstructorParameters<typeof WebSocket>[2]) {
    this.ws = new WebSocket(url, opts);
    this.ws.on('message', (data, binary) => {
      const m = { data: data as Buffer, binary };
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.ws.on('error', () => {});
    this.closed = new Promise((r) => this.ws.on('close', (c) => r(c)));
  }
  opened(): Promise<this> {
    return new Promise((res, rej) => {
      this.ws.once('open', () => res(this));
      this.ws.once('error', rej);
    });
  }
  next(timeout = 2000): Promise<{ data: Buffer; binary: boolean }> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for a message')), timeout);
      this.waiters.push((m) => {
        clearTimeout(t);
        res(m);
      });
    });
  }
  async json(): Promise<Record<string, unknown>> {
    return JSON.parse((await this.next()).data.toString('utf8'));
  }
  send(v: unknown): void {
    this.ws.send(typeof v === 'string' ? v : JSON.stringify(v));
  }
}

interface Env {
  relay: Relay;
  base: string;
  logs: string[];
  dir: string;
  store: Store;
}

let dir: string;
let relays: Relay[] = [];
let clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
});
afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  for (const r of relays) await r.close();
  relays = [];
  rmSync(dir, { recursive: true, force: true });
});

async function start(extra: Partial<RelayOptions> = {}, file: string | null = join(dir, 'relay.json')): Promise<Env> {
  const logs: string[] = [];
  const store = extra.store ?? new Store(file);
  const relay = createRelay({ store, log: createLogger((l) => logs.push(l)), ...extra });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', r));
  relays.push(relay);
  const port = (relay.server.address() as AddressInfo).port;
  return { relay, base: `ws://127.0.0.1:${port}`, logs, dir, store };
}

async function connectTo(base: string, path: string, opts?: ConstructorParameters<typeof WebSocket>[2]): Promise<Client> {
  const c = new Client(`${base}${path}`, opts);
  clients.push(c);
  return c.opened();
}

interface Bridge {
  host: Client;
  route: string;
  secret: string;
}

async function bridge(env: Env, route = id(16), secret = id(32)): Promise<Bridge> {
  const host = await connectTo(env.base, '/v1/host');
  host.send({ v: 1, t: 'hello', route, secret });
  expect(await host.json()).toEqual({ v: 1, t: 'ok' });
  return { host, route, secret };
}

async function setDevices(env: Env, b: Bridge, list: { device: string; token: string }[]): Promise<void> {
  b.host.send({ v: 1, t: 'devices', list: list.map((d) => ({ device: d.device, tokenHash: sha(d.token) })) });
  for (let i = 0; i < 100 && env.store.devicesOf(b.route).length !== list.length; i++) await sleep(5);
  expect(env.store.devicesOf(b.route)).toHaveLength(list.length);
}

describe('routes (acceptance 1)', () => {
  it('first hello creates the route; another secret is refused; the route survives a restart', async () => {
    const env = await start();
    const b = await bridge(env);
    const other = await connectTo(env.base, '/v1/host');
    other.send({ v: 1, t: 'hello', route: b.route, secret: id(32) });
    expect(await other.json()).toEqual({ v: 1, t: 'error', code: 'unknown_route' });
    await other.closed;
    // the owner can reconnect, and the new socket replaces the old one
    const again = await connectTo(env.base, '/v1/host');
    again.send({ v: 1, t: 'hello', route: b.route, secret: b.secret });
    expect(await again.json()).toEqual({ v: 1, t: 'ok' });
    expect(await b.host.closed).toBe(4000);

    expect(statSync(join(dir, 'relay.json')).mode & 0o777).toBe(0o600);
    await env.relay.close();
    relays = [];

    const env2 = await start({}, join(dir, 'relay.json'));
    const bad = await connectTo(env2.base, '/v1/host');
    bad.send({ v: 1, t: 'hello', route: b.route, secret: id(32) });
    expect(await bad.json()).toMatchObject({ code: 'unknown_route' });
    const good = await connectTo(env2.base, '/v1/host');
    good.send({ v: 1, t: 'hello', route: b.route, secret: b.secret });
    expect(await good.json()).toEqual({ v: 1, t: 'ok' });
  });

  it('stores only hashes, never the secret or the token', async () => {
    const env = await start();
    const b = await bridge(env);
    const token = id(32);
    await setDevices(env, b, [{ device: id(16), token }]);
    const raw = (await import('node:fs')).readFileSync(join(dir, 'relay.json'), 'utf8');
    expect(raw).not.toContain(b.secret);
    expect(raw).not.toContain(token);
    expect(raw).toContain(sha(b.secret));
  });

  it('rejects frames before hello and malformed frames', async () => {
    const env = await start();
    const c = await connectTo(env.base, '/v1/host');
    c.send({ v: 1, t: 'devices', list: [] });
    expect(await c.json()).toMatchObject({ code: 'bad_request' });
    const d = await connectTo(env.base, '/v1/host');
    d.send('not json');
    expect(await d.json()).toMatchObject({ code: 'bad_request' });
  });
});

describe('devices and connect (acceptance 2)', () => {
  it('devices replaces the list; a right token gets incoming, then ready after accept', async () => {
    const env = await start();
    const b = await bridge(env);
    const [d1, d2] = [{ device: id(16), token: id(32) }, { device: id(16), token: id(32) }];
    await setDevices(env, b, [d1, d2]);
    await setDevices(env, b, [d2]);

    const old = await connectTo(env.base, '/v1/connect');
    old.send({ v: 1, t: 'connect', route: b.route, device: d1.device, token: d1.token });
    expect(await old.json()).toEqual({ v: 1, t: 'error', code: 'unknown_device' });

    const phone = await connectTo(env.base, '/v1/connect');
    phone.send({ v: 1, t: 'connect', route: b.route, device: d2.device, token: d2.token });
    const inc = await b.host.json();
    expect(inc).toMatchObject({ v: 1, t: 'incoming', kind: 'connect', device: d2.device });
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: inc.stream });
    expect(await phone.json()).toEqual({ v: 1, t: 'ready' });
  });

  it('a wrong token → unknown_device, a wrong route → unknown_route, host not connected → host_offline', async () => {
    const env = await start();
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);

    const wrong = await connectTo(env.base, '/v1/connect');
    wrong.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: id(32) });
    expect(await wrong.json()).toMatchObject({ code: 'unknown_device' });

    const noRoute = await connectTo(env.base, '/v1/connect');
    noRoute.send({ v: 1, t: 'connect', route: id(16), device: d.device, token: d.token });
    expect(await noRoute.json()).toMatchObject({ code: 'unknown_route' });

    b.host.ws.close();
    await b.host.closed;
    await sleep(20);
    const off = await connectTo(env.base, '/v1/connect');
    off.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    expect(await off.json()).toEqual({ v: 1, t: 'error', code: 'host_offline' });
  });

  it('accept with a wrong secret or an unknown stream does not splice', async () => {
    const env = await start();
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const phone = await connectTo(env.base, '/v1/connect');
    phone.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    const inc = await b.host.json();
    const evil = await connectTo(env.base, '/v1/accept');
    evil.send({ v: 1, t: 'accept', route: b.route, secret: id(32), stream: inc.stream });
    expect(await evil.json()).toMatchObject({ code: 'unknown_route' });
    const nostream = await connectTo(env.base, '/v1/accept');
    nostream.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: 'nope' });
    expect(await nostream.json()).toMatchObject({ code: 'bad_request' });
    // the right accept still works afterwards
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: inc.stream });
    expect(await phone.json()).toEqual({ v: 1, t: 'ready' });
  });
});

describe('pair (acceptance 3)', () => {
  it('open offer → incoming pair; closed, never opened and expired offers → offer_closed', async () => {
    let t = 1_000_000;
    const env = await start({ now: () => t });
    const b = await bridge(env);
    const lookup = id(16);
    b.host.send({ v: 1, t: 'offer', lookup, exp: t + 120_000 });
    for (let i = 0; i < 100 && env.relay.registry.offerCount() === 0; i++) await sleep(5);

    const p = await connectTo(env.base, '/v1/connect');
    p.send({ v: 1, t: 'pair', lookup });
    expect(await b.host.json()).toMatchObject({ t: 'incoming', kind: 'pair' });
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: (await Promise.resolve(env.relay.registry.host(b.route)!.pending.keys().next().value) as string) });
    expect(await p.json()).toEqual({ v: 1, t: 'ready' });

    b.host.send({ v: 1, t: 'offer', lookup: null });
    for (let i = 0; i < 100 && env.relay.registry.offerCount() !== 0; i++) await sleep(5);
    const closed = await connectTo(env.base, '/v1/connect');
    closed.send({ v: 1, t: 'pair', lookup });
    expect(await closed.json()).toEqual({ v: 1, t: 'error', code: 'offer_closed' });

    const unknown = await connectTo(env.base, '/v1/connect');
    unknown.send({ v: 1, t: 'pair', lookup: id(16) });
    expect(await unknown.json()).toMatchObject({ code: 'offer_closed' });

    const l2 = id(16);
    b.host.send({ v: 1, t: 'offer', lookup: l2, exp: t + 1000 });
    for (let i = 0; i < 100 && env.relay.registry.offerCount() === 0; i++) await sleep(5);
    t += 2000;
    const late = await connectTo(env.base, '/v1/connect');
    late.send({ v: 1, t: 'pair', lookup: l2 });
    expect(await late.json()).toMatchObject({ code: 'offer_closed' });
    expect(env.relay.registry.offerCount()).toBe(0);
  });

  it('an offer without exp, with a past exp or a far exp is refused; offers do not hop between routes', async () => {
    const t = 5_000_000;
    const env = await start({ now: () => t });
    const b = await bridge(env);
    for (const frame of [
      { v: 1, t: 'offer', lookup: id(16) },
      { v: 1, t: 'offer', lookup: id(16), exp: t - 1 },
      { v: 1, t: 'offer', lookup: id(16), exp: t + 3_600_000 },
    ]) {
      const h = await bridge(env);
      h.host.send(frame);
      expect(await h.host.json()).toMatchObject({ code: 'bad_request' });
    }
    const lookup = id(16);
    b.host.send({ v: 1, t: 'offer', lookup, exp: t + 1000 });
    for (let i = 0; i < 100 && env.relay.registry.offerCount() === 0; i++) await sleep(5);
    const other = await bridge(env);
    other.host.send({ v: 1, t: 'offer', lookup, exp: t + 1000 });
    expect(await other.host.json()).toMatchObject({ code: 'bad_request' });
  });
});

describe('pipe (acceptance 4)', () => {
  async function piped(env: Env) {
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const phone = await connectTo(env.base, '/v1/connect');
    phone.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    const inc = await b.host.json();
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: inc.stream });
    expect(await phone.json()).toEqual({ v: 1, t: 'ready' });
    return { b, phone, acc, d };
  }

  it('bytes flow both ways unchanged', async () => {
    const env = await start();
    const { phone, acc } = await piped(env);
    const up = randomBytes(1000);
    const down = randomBytes(MAX_FRAME_BYTES);
    phone.ws.send(up);
    const gotUp = await acc.next();
    expect(gotUp.binary).toBe(true);
    expect(Buffer.compare(gotUp.data, up)).toBe(0);
    acc.ws.send(down);
    const gotDown = await phone.next();
    expect(Buffer.compare(gotDown.data, down)).toBe(0);
  });

  it('closing one side closes the other, from either side', async () => {
    const env = await start();
    const a = await piped(env);
    a.phone.ws.close(1000);
    await a.acc.closed;
    const b = await piped(env);
    b.acc.ws.close(1000);
    await b.phone.closed;
    for (let i = 0; i < 100 && env.relay.registry.streams(a.b.route) !== 0; i++) await sleep(5);
    expect(env.relay.registry.streams(a.b.route)).toBe(0);
  });

  it('a text frame inside the pipe closes it', async () => {
    const env = await start();
    const { phone, acc } = await piped(env);
    phone.ws.send('text');
    expect(await acc.closed).toBeGreaterThan(0);
  });

  it('a pipe longer than the cap is closed', async () => {
    const env = await start({ timing: { pipeMaxMs: 150 } });
    const { phone, acc } = await piped(env);
    await Promise.all([phone.closed, acc.closed]);
  });

  it('a silent side (no pong) is dropped after the idle time', async () => {
    const env = await start({ timing: { pingMs: 20, idleMs: 80 } });
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const phone = await connectTo(env.base, '/v1/connect', { autoPong: false });
    phone.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    const inc = await b.host.json();
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: inc.stream });
    await phone.next();
    await Promise.all([phone.closed, acc.closed]);
  });
});

describe('limits (acceptance 5)', () => {
  it('the 31st connect from one IP in a minute is rate_limited', async () => {
    const env = await start();
    const codes: unknown[] = [];
    for (let i = 0; i < 31; i++) {
      const c = await connectTo(env.base, '/v1/connect');
      c.send({ v: 1, t: 'connect', route: id(16), device: id(16), token: id(32) });
      codes.push((await c.json()).code);
    }
    expect(codes.slice(0, 30).every((c) => c === 'unknown_route')).toBe(true);
    expect(codes[30]).toBe('rate_limited');
  });

  it('the 11th pair and the 6th new route are rate_limited', async () => {
    const env = await start();
    const codes: unknown[] = [];
    for (let i = 0; i < 11; i++) {
      const c = await connectTo(env.base, '/v1/connect');
      c.send({ v: 1, t: 'pair', lookup: id(16) });
      codes.push((await c.json()).code);
    }
    expect(codes[9]).toBe('offer_closed');
    expect(codes[10]).toBe('rate_limited');
    for (let i = 0; i < 5; i++) await bridge(env);
    const h = await connectTo(env.base, '/v1/host');
    h.send({ v: 1, t: 'hello', route: id(16), secret: id(32) });
    expect(await h.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('a frame larger than 65 599 bytes closes the connection', async () => {
    const env = await start();
    const b = await bridge(env);
    const big = await connectTo(env.base, '/v1/connect');
    big.ws.send(Buffer.alloc(MAX_FRAME_BYTES + 1));
    expect(await big.closed).toBe(1009);
    b.host.ws.send(Buffer.alloc(MAX_FRAME_BYTES + 1));
    expect(await b.host.closed).toBe(1009);
  });

  it('at most 10 streams per route; an unanswered accept ends after the wait', async () => {
    const env = await start({ timing: { acceptWaitMs: 150 }, limiter: new Limiter({ buckets: { connect: { limit: 1000, windowMs: 60000 }, pair: { limit: 10, windowMs: 60000 }, newRoute: { limit: 5, windowMs: 60000 } } }) });
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const phones: Client[] = [];
    for (let i = 0; i < 11; i++) {
      const p = await connectTo(env.base, '/v1/connect');
      p.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
      phones.push(p);
    }
    expect(await phones[10]!.json()).toEqual({ v: 1, t: 'error', code: 'rate_limited' });
    // nobody accepts: the other ten get host_offline after the wait
    expect(await phones[0]!.json()).toEqual({ v: 1, t: 'error', code: 'host_offline' });
    expect(env.relay.registry.streams(b.route)).toBeLessThanOrEqual(10);
  });

  it('a stray frame from a waiting phone drops it; the host going away fails the waiting phones', async () => {
    const env = await start();
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const chatty = await connectTo(env.base, '/v1/connect');
    chatty.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    await b.host.json();
    chatty.ws.send(Buffer.from([1, 2, 3]));
    await chatty.closed;

    const waiting = await connectTo(env.base, '/v1/connect');
    waiting.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    await b.host.json();
    b.host.ws.close();
    expect(await waiting.json()).toEqual({ v: 1, t: 'error', code: 'host_offline' });
  });

  it('limiter maps stay bounded', () => {
    let t = 0;
    const l = new Limiter({ maxEntries: 100, now: () => t });
    for (let i = 0; i < 10_000; i++) l.hit('connect', `ip${i}`);
    expect(l.size('connect')).toBeLessThanOrEqual(100);
    t += 61_000;
    expect(l.hit('connect', 'ip0')).toBe(true);
  });

  it('connections beyond the cap are refused with 503', async () => {
    const env = await start({ maxConnections: 2 });
    await connectTo(env.base, '/v1/connect');
    await connectTo(env.base, '/v1/connect');
    const c = new Client(`${env.base}/v1/connect`);
    clients.push(c);
    await expect(c.opened()).rejects.toThrow(/503/);
  });
});

describe('log (acceptance 6)', () => {
  it('holds no tokens, secrets, hashes, ids or IPs', async () => {
    const env = await start();
    const b = await bridge(env);
    const d = { device: id(16), token: id(32) };
    await setDevices(env, b, [d]);
    const lookup = id(16);
    b.host.send({ v: 1, t: 'offer', lookup, exp: Date.now() + 100_000 });
    const phone = await connectTo(env.base, '/v1/connect');
    phone.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: d.token });
    const inc = await b.host.json();
    const acc = await connectTo(env.base, '/v1/accept');
    acc.send({ v: 1, t: 'accept', route: b.route, secret: b.secret, stream: inc.stream });
    await phone.json();
    const bad = await connectTo(env.base, '/v1/connect');
    bad.send({ v: 1, t: 'connect', route: b.route, device: d.device, token: id(32) });
    await bad.json();
    b.host.ws.close();
    await sleep(50);
    const log = env.logs.join('\n');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [b.route, b.secret, sha(b.secret), d.device, d.token, sha(d.token), lookup, String(inc.stream), '127.0.0.1']) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('health and binding (acceptance 7)', () => {
  const get = (url: string): Promise<{ status: number; body: string }> =>
    new Promise((res, rej) =>
      http.get(url, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => res({ status: r.statusCode ?? 0, body }));
      }).on('error', rej),
    );

  it('GET /v1/health → 200, other paths → 404, an unknown upgrade path → 404', async () => {
    const env = await start();
    const url = env.base.replace('ws:', 'http:');
    expect(await get(`${url}/v1/health`)).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await get(`${url}/nope`)).status).toBe(404);
    const c = new Client(`${env.base}/nope`);
    clients.push(c);
    await expect(c.opened()).rejects.toThrow(/404/);
  });

  it('without dev the default host is 127.0.0.1; with dev it is the LAN address', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en1: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      utun: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
    } as unknown as ReturnType<typeof import('node:os').networkInterfaces>;
    const prod = loadConfig({}, [], ifaces);
    expect(prod).toMatchObject({ host: '127.0.0.1', dev: false, dataFile: './data/relay.json' });
    const dev = loadConfig({}, ['--dev'], ifaces);
    expect(dev).toMatchObject({ host: '192.168.1.20', dev: true, dataFile: null });
    expect(lanAddress(ifaces)).toBe('192.168.1.20');
    expect(() => loadConfig({}, ['--dev'], {})).toThrow(/LAN/);
    expect(loadConfig({ HOST: '0.0.0.0', PORT: '9' }, [], ifaces)).toMatchObject({ host: '0.0.0.0', port: 9 });
  });

  it('the server really listens on the 127.0.0.1 it was given', async () => {
    const env = await start();
    expect((env.relay.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });
});

describe('hash compare', () => {
  it('matches equal hashes and nothing else', () => {
    const tok = id(32);
    expect(hashMatches(sha(tok), sha256OfB64(tok))).toBe(true);
    expect(hashMatches(sha(tok), sha256OfB64(id(32)))).toBe(false);
    expect(hashMatches(undefined, sha256OfB64(tok))).toBe(false);
    expect(hashMatches(sha(tok), null)).toBe(false);
  });
});
