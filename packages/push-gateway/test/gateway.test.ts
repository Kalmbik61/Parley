import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApnsClient } from '../src/apns.js';
import { createJwtProvider, JWT_MIN_REFRESH_MS, JWT_TTL_MS } from '../src/jwt.js';
import { Limiter } from '../src/limits.js';
import { loadConfig } from '../src/main.js';
import { createGatewayServer, MAX_BODY_BYTES } from '../src/server.js';

const TOKEN = 'ab'.repeat(32);
const ROUTE_A = 'A'.repeat(22);
// Канонический b64url: последний знак 22-значной строки оставляет 4 младших бита нулевыми.
const ROUTE_B = 'B'.repeat(21) + 'A';
const TOPIC = 'app.parley.test';
const KEY_ID = 'KEY1234567';
const TEAM_ID = 'TEAM123456';

interface Seen {
  headers: http2.IncomingHttpHeaders;
  body: string;
  path: string;
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let apnsServer: http2.Http2Server;
let seen: Seen[];
let apnsStatus: number;
let apnsReason: string;
/** Ответы APNs по очереди; пустая очередь — `apnsStatus` / `apnsReason`. */
let apnsQueue: Array<[number, string]>;
let apnsHost: string;
let gateway: http.Server;
let base: string;
let apns: ReturnType<typeof createApnsClient>;
let logged: string[];

const listen = (s: { listen: (...a: never[]) => unknown }): Promise<number> =>
  new Promise((resolve) => {
    (s as unknown as http.Server).listen(0, '127.0.0.1', () =>
      resolve(((s as unknown as http.Server).address() as AddressInfo).port),
    );
  });

async function start(
  limiter = new Limiter(),
  extra: { monotonic?: () => number; log?: (l: string) => void; trustProxy?: boolean } = {},
): Promise<void> {
  const jwt = createJwtProvider({
    keyPem,
    keyId: KEY_ID,
    teamId: TEAM_ID,
    ...(extra.monotonic ? { monotonic: extra.monotonic } : {}),
  });
  apns = createApnsClient({
    topic: TOPIC,
    jwt,
    origins: { sandbox: apnsHost, production: apnsHost },
  });
  gateway = createGatewayServer({
    apns,
    limiter,
    ...(extra.log ? { log: extra.log } : {}),
    ...(extra.trustProxy ? { trustProxy: true } : {}),
  });
  base = `http://127.0.0.1:${await listen(gateway)}`;
}

const post = (body: unknown, raw?: string) =>
  fetch(`${base}/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

const valid = { v: 1, token: TOKEN, env: 'sandbox', count: 3, route: ROUTE_A };

beforeEach(async () => {
  seen = [];
  apnsStatus = 200;
  apnsReason = 'x';
  apnsQueue = [];
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));
  }
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    logged.push(String(c));
    return true;
  });
  apnsServer = http2.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
        path: req.url ?? '',
      });
      const [status, reason] = apnsQueue.shift() ?? [apnsStatus, apnsReason];
      res.writeHead(status);
      res.end(status === 200 ? '' : JSON.stringify({ reason }));
    });
  });
  apnsHost = `http://127.0.0.1:${await listen(apnsServer)}`;
});

afterEach(async () => {
  apns?.close();
  gateway?.close();
  apnsServer.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('push → APNs', () => {
  it('sends exactly the expected body and headers; routes get different collapse ids', async () => {
    await start();
    expect((await post(valid)).status).toBe(200);
    expect((await post({ ...valid, route: ROUTE_B, token: 'cd'.repeat(32) })).status).toBe(200);
    const [a, b] = seen as [Seen, Seen];
    expect(a.path).toBe(`/3/device/${TOKEN}`);
    expect(JSON.parse(a.body)).toEqual({
      aps: {
        alert: { title: 'Parley', body: '3 waiting' },
        badge: 3,
        'thread-id': ROUTE_A,
      },
      v: 1,
      kind: 'needs-you',
      count: 3,
      route: ROUTE_A,
    });
    expect(a.headers['apns-push-type']).toBe('alert');
    expect(a.headers['apns-topic']).toBe(TOPIC);
    expect(a.headers['apns-collapse-id']).toBe(ROUTE_A);
    expect(b.headers['apns-collapse-id']).toBe(ROUTE_B);
    expect(a.headers['apns-collapse-id']).not.toBe(b.headers['apns-collapse-id']);
    expect(String(a.headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('uses different hosts for sandbox and production', async () => {
    const origins = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };
    const { APNS_ORIGINS } = await import('../src/apns.js');
    expect(APNS_ORIGINS).toEqual(origins);
  });

  it.each([
    ['extra field', { ...valid, text: 'hi' }],
    ['string count', { ...valid, count: '3' }],
    ['bad env', { ...valid, env: 'dev' }],
    ['bad token', { ...valid, token: 'zz' }],
    ['bad route', { ...valid, route: 'short' }],
    ['wrong v', { ...valid, v: 2 }],
  ])('%s → 400, nothing sent to APNs', async (_n, body) => {
    await start();
    expect((await post(body)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('invalid JSON and oversized body → 400', async () => {
    await start();
    expect((await post(null, '{nope')).status).toBe(400);
    const big = JSON.stringify({ ...valid, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await post(null, big)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('APNs 410 → 410 out; 429 → 429; APNs outage → 502', async () => {
    await start();
    apnsStatus = 410;
    expect((await post(valid)).status).toBe(410);
    apnsStatus = 429;
    expect((await post({ ...valid, token: 'cd'.repeat(32) })).status).toBe(429);
    apnsStatus = 403;
    expect((await post({ ...valid, token: 'ef'.repeat(32) })).status).toBe(502);
  });

  it('GET /v1/health → 200; unknown path → 404', async () => {
    await start();
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/push`)).status).toBe(405);
  });
});

describe('limits', () => {
  it('second push to the same token after 1 s → 429', async () => {
    let t = 1_000_000;
    await start(new Limiter({ now: () => t }));
    expect((await post(valid)).status).toBe(200);
    t += 1000;
    expect((await post(valid)).status).toBe(429);
    expect(seen).toHaveLength(1);
    t += 3000;
    expect((await post(valid)).status).toBe(200);
  });

  it('per token ≤ 60 per hour; window resets', () => {
    let t = 0;
    const l = new Limiter({ now: () => t });
    let ok = 0;
    for (let i = 0; i < 70; i++) {
      t += 3000;
      if (l.allowToken('x')) ok++;
    }
    expect(ok).toBe(60);
    t += 3_600_000;
    expect(l.allowToken('x')).toBe(true);
  });

  it('per IP ≤ 600 per hour', () => {
    const l = new Limiter({ now: () => 0 });
    let ok = 0;
    for (let i = 0; i < 700; i++) if (l.allowIp('1.2.3.4')) ok++;
    expect(ok).toBe(600);
    expect(l.allowIp('5.6.7.8')).toBe(true);
  });

  it('maps stay bounded', () => {
    const l = new Limiter({ maxEntries: 100, now: () => 0 });
    for (let i = 0; i < 1000; i++) {
      l.allowIp(`ip${i}`);
      l.allowToken(`t${i}`);
    }
    expect(l.size().ips).toBeLessThanOrEqual(100);
    expect(l.size().tokens).toBeLessThanOrEqual(100);
  });

  it('IP limit → 429 through the server', async () => {
    await start(new Limiter({ ipPerHour: 2 }));
    await post({ nope: 1 });
    await post({ nope: 1 });
    expect((await post(valid)).status).toBe(429);
  });
});

describe('jwt', () => {
  it('verifies with the public key, reused for 50 min, refreshed after', () => {
    let t = 1_700_000_000_000;
    const get = createJwtProvider({ keyPem, keyId: KEY_ID, teamId: TEAM_ID, now: () => t, monotonic: () => t });
    const first = get();
    const [h, p, s] = first.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: TEAM_ID,
      iat: Math.floor(t / 1000),
    });
    const pub: KeyObject = publicKey;
    const sig = Buffer.from(s, 'base64url');
    expect(sig.length).toBe(64);
    expect(
      verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, sig),
    ).toBe(true);
    t += JWT_TTL_MS - 1;
    expect(get()).toBe(first);
    t += 1;
    const second = get();
    expect(second).not.toBe(first);
    expect(JSON.parse(Buffer.from(second.split('.')[1]!, 'base64url').toString()).iat).toBe(
      Math.floor(t / 1000),
    );
  });

  it('rejects a non-P-256 key without echoing it', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => createJwtProvider({ keyPem: rsa, keyId: 'k', teamId: 't' })).toThrow(/P-256/);
    try {
      createJwtProvider({ keyPem: 'garbage-secret', keyId: 'k', teamId: 't' });
    } catch (e) {
      expect(String(e)).not.toContain('garbage-secret');
    }
  });
});

describe('review fixes (A5 M3, M4, m1, m2)', () => {
  const closeGateway = () => new Promise<void>((r) => gateway.close(() => r()));

  it('M3: the token age is monotonic: the wall clock stepping back does not keep an old token', () => {
    let wall = 1_700_000_000_000;
    let mono = 0;
    const get = createJwtProvider({ keyPem, keyId: KEY_ID, teamId: TEAM_ID, now: () => wall, monotonic: () => mono });
    const first = get();
    wall -= 2 * 3_600_000;
    mono += JWT_TTL_MS;
    expect(get()).not.toBe(first);
  });

  it('M3: refresh() drops a token only when it is at least 20 min old', () => {
    let mono = 0;
    const get = createJwtProvider({ keyPem, keyId: KEY_ID, teamId: TEAM_ID, monotonic: () => mono });
    const first = get();
    mono += JWT_MIN_REFRESH_MS - 1;
    expect(get.refresh()).toBe(false);
    expect(get()).toBe(first);
    mono += 1;
    expect(get.refresh()).toBe(true);
    expect(get()).not.toBe(first);
  });

  it('M3: 403 ExpiredProviderToken → new JWT and one retry; the log has status and reason, never the token', async () => {
    let mono = 0;
    const lines: string[] = [];
    await start(new Limiter(), { monotonic: () => mono, log: (l) => lines.push(l) });
    expect((await post(valid)).status).toBe(200);
    mono += JWT_MIN_REFRESH_MS;
    apnsQueue = [[403, 'ExpiredProviderToken']];
    expect((await post({ ...valid, token: 'cd'.repeat(32) })).status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.headers.authorization).not.toBe(seen[1]!.headers.authorization);
    expect(seen[1]!.headers.authorization).toBe(seen[0]!.headers.authorization);

    // Токен свежий (моложе 20 мин) — без повтора: 502.
    apnsQueue = [[403, 'InvalidProviderToken']];
    expect((await post({ ...valid, token: 'ef'.repeat(32) })).status).toBe(502);
    expect(seen).toHaveLength(4);

    await closeGateway();
    const out = lines.join('\n');
    expect(out).toContain('403 ExpiredProviderToken x1');
    expect(out).toContain('403 InvalidProviderToken x1');
    expect(out).toContain('200 - x2');
    for (const needle of [TOKEN, 'cd'.repeat(32), ROUTE_A, 'bearer', '127.0.0.1']) expect(out).not.toContain(needle);
  });

  it('M4: the token is lowercased before the limiter and APNs', async () => {
    await start();
    expect((await post({ ...valid, token: TOKEN.toUpperCase() })).status).toBe(200);
    expect((await post(valid)).status).toBe(429);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe(`/3/device/${TOKEN}`);
  });

  it('m2: token reasons → 410, gateway configuration reasons → 502, other 400 → 400', async () => {
    await start();
    apnsQueue = [
      [400, 'BadDeviceToken'],
      [400, 'DeviceTokenNotForTopic'],
      [400, 'BadTopic'],
      [400, 'TopicDisallowed'],
      [400, 'PayloadEmpty'],
    ];
    const codes: number[] = [];
    for (const t of ['01', '02', '03', '04', '05']) codes.push((await post({ ...valid, token: t.repeat(32) })).status);
    expect(codes).toEqual([410, 410, 502, 502, 400]);
  });

  it('m1: behind a proxy the IP limit counts an IPv6 /64 as one client', async () => {
    await start(new Limiter({ ipPerHour: 2 }), { trustProxy: true });
    const from = (ip: string) =>
      fetch(`${base}/v1/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ nope: 1 }),
      });
    expect((await from('2001:db8:7:8::1')).status).toBe(400);
    expect((await from('2001:db8:7:8::2')).status).toBe(400);
    expect((await from('2001:db8:7:8:ffff::3')).status).toBe(429);
    expect((await from('2001:db8:7:9::1')).status).toBe(400);
  });
});

describe('config', () => {
  const base = { APNS_KEY: keyPem, APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_TOPIC: 'x' };
  it('starts with a full environment', () => {
    expect(loadConfig(base).topic).toBe('x');
  });
  it.each(['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC'])('fails without %s', (k) => {
    const env: Record<string, string> = { ...base };
    delete env[k];
    expect(() => loadConfig(env)).toThrow();
  });
});

describe('no leaks', () => {
  it('run log has no tokens, bodies, IPs or key', async () => {
    await start();
    await post(valid);
    await post({ ...valid, extra: 1 });
    apnsStatus = 410;
    await post({ ...valid, token: 'cd'.repeat(32) });
    const out = logged.join('\n');
    const body = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().split('\n')[1]!;
    for (const needle of [TOKEN, 'cd'.repeat(32), ROUTE_A, '127.0.0.1', body, 'Parley', 'waiting']) {
      expect(out).not.toContain(needle);
    }
  });
});
