/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
// A22: мост как настоящий процесс (`node dist/main.js`), стаб хоста, локальный relay A4 и настоящий клиент A11.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LineDecoder } from '@parley/protocol';
import { REMOTE_METHODS } from '@parley/protocol/remote';
import { createRelay, type Relay } from '@parley/relay/dist/server.js';
import { Store } from '@parley/relay/dist/store.js';
import { HostStore, Supervisor, pair, type HostRecord, type Platform, type WebSocketLike } from '@parley/remote-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '..', 'dist', 'main.js');
const SPY = pathToFileURL(path.join(here, 'listen-spy.mjs')).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | Promise<T | undefined | null | false> | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

// ---- стаб хоста: `<home>/host/host.sock` и `host.token`, hello с признаком политики, works.list ----
const snapshot = {
  revision: 1,
  branches: {},
  entries: [
    {
      projectPath: '/p',
      map: {
        work: { id: 'w-1', title: 'Integration', status: 'active', updatedAt: 'x' },
        sessions: [{ id: 's-1', provider: 'claude', label: 'one', task: 'SECRET TASK', parent: null, lifecycle: 'active', history: [] }],
        rooms: [],
        messages: [],
        plans: [{ secret: 1 }],
      },
    },
  ],
};

class HostStub {
  readonly conns = new Set<net.Socket>();
  readonly received: string[] = [];
  #server!: net.Server;
  async start(socketPath: string, tokenPath: string): Promise<void> {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    writeFileSync(tokenPath, 'host-token-test\n');
    this.#server = net.createServer((c) => {
      this.conns.add(c);
      c.on('close', () => this.conns.delete(c));
      c.on('error', () => {});
      const dec = new LineDecoder();
      c.on('data', (chunk) => {
        for (const m of dec.push(chunk) as { id: number; method: string }[]) {
          this.received.push(m.method);
          const result =
            m.method === 'hello'
              ? { features: ['remote-policy-1', 'compact-works', 'rooms-mail'], methods: [...REMOTE_METHODS] }
              : m.method === 'works.list'
                ? snapshot
                : { ok: true };
          c.write(`${JSON.stringify({ id: m.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((r) => this.#server.listen(socketPath, r));
  }
  broadcast(msg: unknown): void {
    for (const c of this.conns) c.write(`${JSON.stringify(msg)}\n`);
  }
  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}

// ---- клиент сокета управления окна ----
class Control {
  #sock!: net.Socket;
  #id = 0;
  readonly events: { event: string; data: any }[] = [];
  readonly #waiting = new Map<number, (m: any) => void>();
  static async open(home: string): Promise<Control> {
    const c = new Control();
    const dir = path.join(home, 'remote');
    const token = readFileSync(path.join(dir, 'control.token'), 'utf8');
    c.#sock = net.connect(path.join(dir, 'control.sock'));
    const dec = new LineDecoder();
    c.#sock.on('data', (chunk) => {
      for (const m of dec.push(chunk) as any[]) {
        if (typeof m.id === 'number') c.#waiting.get(m.id)?.(m);
        else c.events.push(m);
      }
    });
    c.#sock.on('error', () => {});
    await new Promise<void>((r) => c.#sock.once('connect', () => r()));
    await c.call('hello', { token });
    return c;
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : resolve(m.result)));
      this.#sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  close(): void {
    this.#sock.destroy();
  }
}

// ---- телефон: настоящий клиент A11 на платформе Node ----
function phonePlatform(): Platform {
  const records = new Map<string, HostRecord>();
  const still = <T>(value: T) => ({ get: () => value, subscribe: () => () => {} });
  return {
    keyStore: {
      list: async () => [...records.values()],
      put: async (r) => void records.set(r.hostId, r),
      remove: async (id) => void records.delete(id),
    },
    // relay на петле: клиент строит `wss://` (адрес не частный), тесту нужен `ws://`
    openSocket: (url) => new WebSocket(url.replace(/^wss:\/\/127\.0\.0\.1/, 'ws://127.0.0.1')) as unknown as WebSocketLike,
    random: (n) => new Uint8Array(randomBytes(n)),
    appState: still('active' as const),
    network: still({ online: true, kind: 'wifi' }),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as never),
    allowLocalRelay: true,
  };
}

let home: string;
let relay: Relay;
let relayHost: string;
let host: HostStub;
let child: ChildProcess | null;
let exit: Promise<number | null>;
let controls: Control[];
let supervisors: Supervisor[];
let spyFile: string;
let stderr: string;

beforeEach(async () => {
  if (!existsSync(MAIN)) throw new Error('packages/remote/dist/main.js is missing: run `pnpm --filter @parley/remote build` first');
  home = mkdtempSync(path.join(os.tmpdir(), 'br-'));
  spyFile = path.join(home, 'listen-spy.log');
  writeFileSync(spyFile, '');
  relay = createRelay({ store: new Store(null), log: () => {}, timing: { acceptWaitMs: 1500 } });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  relayHost = `127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  host = new HostStub();
  await host.start(path.join(home, 'host', 'host.sock'), path.join(home, 'host', 'host.token'));
  mkdirSync(path.join(home, 'remote'), { recursive: true });
  writeFileSync(path.join(home, 'remote', 'remote.json'), JSON.stringify({ v: 1, relay: relayHost }));
  child = null;
  controls = [];
  supervisors = [];
  stderr = '';
});

afterEach(async () => {
  for (const s of supervisors) s.stop();
  for (const c of controls) c.close();
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await exit;
  }
  await host.close();
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});

function startBridge(): void {
  const env = { ...process.env, PARLEY_HOME: home, PARLEY_REMOTE_DEV_LOOPBACK: '1', LISTEN_SPY_FILE: spyFile };
  child = spawn(process.execPath, ['--import', SPY, MAIN], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  exit = new Promise((resolve) => child!.once('exit', (code) => resolve(code)));
}

async function control(): Promise<Control> {
  await until(() => existsSync(path.join(home, 'remote', 'control.sock')) && existsSync(path.join(home, 'remote', 'control.token')));
  const c = await until(async () => Control.open(home).catch(() => null));
  controls.push(c);
  return c;
}

async function running(): Promise<Control> {
  startBridge();
  const c = await control();
  await until(async () => {
    const s = await c.call('status');
    return s.host === 'online' && s.relay === 'connected';
  });
  return c;
}

/** Паринг настоящим клиентом: окно получает `pair.request` и отвечает «Allow». */
async function pairPhone(c: Control, name = 'Test iPhone'): Promise<{ platform: Platform; store: HostStore; record: HostRecord; sup: Supervisor }> {
  const { qr } = await c.call('pair.start');
  const platform = phonePlatform();
  const store = new HostStore(platform.keyStore);
  const pairing = pair(platform, store, qr, { deviceName: name, platformName: 'ios', app: 'parley-mobile/1.0.0', onSas: () => {} });
  const request = await until(() => c.events.find((e) => e.event === 'pair.request')?.data);
  await c.call('pair.answer', { requestId: request.requestId, allow: true });
  const record = await pairing;
  const sup = new Supervisor(platform, store, { hostId: record.hostId, client: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' } });
  supervisors.push(sup);
  // «Phone connected ✓»: устройство активно, следующий паринг можно начинать.
  await until(() => c.events.some((e) => e.event === 'pair.done'));
  c.events.length = 0;
  return { platform, store, record, sup };
}

const ready = (sup: Supervisor) => until(() => sup.status.state === 'ready');

describe('A22: the bridge as one process', () => {
  it('1. status over the control socket: running, host online, relay connected', async () => {
    const c = await running();
    const status = await c.call('status');
    expect(status).toMatchObject({ running: true, host: 'online', relay: 'connected', relayUrl: relayHost, devices: 0 });
    expect(existsSync(path.join(home, 'remote', 'bridge.pid'))).toBe(true);
    expect(readFileSync(path.join(home, 'remote', 'bridge.pid'), 'utf8')).toBe(String(child!.pid));
  }, 30_000);

  it('2. pairing by a test client and works.list through the relay (projection, no host call)', async () => {
    const c = await running();
    const { sup } = await pairPhone(c);
    sup.start();
    await ready(sup);
    expect(sup.status.hello).toMatchObject({ host: 'online', stage: 'A' });
    expect(sup.status.hello?.methods).toEqual(expect.arrayContaining(['works.list', 'sessions.create', 'ping']));
    const result = (await sup.call('works.list')) as any;
    expect(result.revision).toBe(1);
    expect(result.works[0]).toMatchObject({ id: 'w-1', title: 'Integration' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(host.received.filter((m) => m === 'works.list')).toHaveLength(1); // только загрузка эпохи самим мостом
    expect((await c.call('devices.list')).devices).toHaveLength(1);
  }, 40_000);

  it('3. devices.revoke ends the session with `revoked`: the client is blocked', async () => {
    const c = await running();
    const { sup, record } = await pairPhone(c);
    sup.start();
    await ready(sup);
    const { devices } = await c.call('devices.list');
    await c.call('devices.revoke', { deviceId: devices[0].deviceId });
    await until(() => sup.status.blocked === 'revoked');
    expect(sup.status.state).not.toBe('ready');
    expect((await c.call('devices.list')).devices).toEqual([]);
    expect(record.hostId).toBeTruthy();
  }, 40_000);

  it('4. SIGTERM: the client leaves ready, exit code 0, bridge.pid and the control socket are removed', async () => {
    const c = await running();
    const { sup } = await pairPhone(c);
    sup.start();
    await ready(sup);
    child!.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(existsSync(path.join(home, 'remote', 'bridge.pid'))).toBe(false);
    expect(existsSync(path.join(home, 'remote', 'control.sock'))).toBe(false);
    await until(() => sup.status.state !== 'ready');
    // Предупреждение Node про node:sqlite (корень @parley/core) не в счёт: ошибок на stderr быть не должно.
    expect(stderr).not.toMatch(/Error|ECONN|EADDR|Unhandled/);
  }, 40_000);

  it('4. the `stop` control method stops the process the same way', async () => {
    const c = await running();
    await c.call('stop');
    expect(await exit).toBe(0);
    expect(existsSync(path.join(home, 'remote', 'bridge.pid'))).toBe(false);
  }, 30_000);

  it('5. restart: devices are kept, the revoked one stays revoked', async () => {
    const c = await running();
    const first = await pairPhone(c, 'Phone A');
    const second = await pairPhone(c, 'Phone B');
    const devices = (await until(async () => {
      const list = (await c.call('devices.list')).devices;
      return list.length === 2 && list;
    })) as any[];
    expect(devices.map((d: any) => d.name).sort()).toEqual(['Phone A', 'Phone B']);
    await c.call('devices.revoke', { deviceId: devices.find((d: any) => d.name === 'Phone A').deviceId });
    c.close();
    child!.kill('SIGTERM');
    expect(await exit).toBe(0);

    startBridge();
    const c2 = await control();
    await until(async () => (await c2.call('status')).relay === 'connected');
    expect((await c2.call('devices.list')).devices.map((d: any) => d.name)).toEqual(['Phone B']);
    second.sup.start();
    await ready(second.sup);
    first.sup.start();
    await until(() => first.sup.status.state !== 'ready' && first.sup.status.state !== 'idle');
    await sleep(500);
    expect(first.sup.status.state).not.toBe('ready');
  }, 60_000);

  it('6. net.Server.prototype.listen is called with a unix path only', async () => {
    const c = await running();
    const { sup } = await pairPhone(c);
    sup.start();
    await ready(sup);
    const calls = readFileSync(spyFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toEqual({ type: 'string', path: path.join(home, 'remote', 'control.sock') });
  }, 40_000);

  it('configure applies a new relay address without a restart and writes remote.json', async () => {
    const c = await running();
    const other = createRelay({ store: new Store(null), log: () => {}, timing: { acceptWaitMs: 1500 } });
    await new Promise<void>((r) => other.server.listen(0, '127.0.0.1', () => r()));
    const otherHost = `127.0.0.1:${(other.server.address() as AddressInfo).port}`;
    try {
      const pidBefore = child!.pid;
      await c.call('configure', { relayUrl: otherHost });
      await until(async () => {
        const s = await c.call('status');
        return s.relayUrl === otherHost && s.relay === 'connected';
      });
      expect(child!.pid).toBe(pidBefore);
      expect(JSON.parse(readFileSync(path.join(home, 'remote', 'remote.json'), 'utf8'))).toMatchObject({ v: 1, relay: otherHost });
    } finally {
      await other.close();
    }
  }, 30_000);

  it('A9 wiring: a new waiting session sends a push through remote.json.pushGatewayUrl; no window means presence null', async () => {
    const posts: { url: string; body: any }[] = [];
    const gateway = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', body: JSON.parse(raw) });
        res.statusCode = 200;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
    const { port } = gateway.address() as AddressInfo;
    writeFileSync(path.join(home, 'remote', 'remote.json'), JSON.stringify({ v: 1, relay: relayHost, pushGatewayUrl: `http://127.0.0.1:${port}` }));
    try {
      const c = await running();
      const { sup } = await pairPhone(c);
      sup.start();
      await ready(sup);
      await sup.call('push.register', { apnsToken: 'AB'.repeat(32), env: 'sandbox' });
      // Первая картина эпохи — база; новый пункт после неё — повод.
      host.broadcast({ event: 'activity.changed', data: { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-1' }, activity: { activity: 'blocked', need: null }, metrics: null } });
      const post = await until(() => posts[0]);
      expect(post.url).toBe('/v1/push');
      expect(post.body).toMatchObject({ v: 1, token: 'ab'.repeat(32), env: 'sandbox', count: 1 });
      expect(Object.keys(post.body).sort()).toEqual(['count', 'env', 'route', 'token', 'v']);
    } finally {
      await new Promise<void>((r) => gateway.close(() => r()));
    }
  }, 40_000);

  it('SIGTERM while the bridge is still starting: the handler is already there, the bridge stops cleanly (exit 0, no leftovers)', async () => {
    startBridge();
    // bridge.pid появляется внутри startBridge: сигнал приходит посреди запуска, а не до обработчиков.
    await until(() => existsSync(path.join(home, 'remote', 'bridge.pid')), 5000);
    child!.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(existsSync(path.join(home, 'remote', 'bridge.pid'))).toBe(false);
    expect(existsSync(path.join(home, 'remote', 'control.sock'))).toBe(false);
  }, 30_000);

  it('a second bridge on the same home refuses to start and does not touch the first', async () => {
    const c = await running();
    const second = spawn(process.execPath, [MAIN], { env: { ...process.env, PARLEY_HOME: home, PARLEY_REMOTE_DEV_LOOPBACK: '1' }, stdio: 'ignore' });
    const code = await new Promise<number | null>((r) => second.once('exit', r));
    expect(code).toBe(1);
    expect((await c.call('status')).running).toBe(true);
  }, 30_000);
});
