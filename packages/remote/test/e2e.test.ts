/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
// A17: сквозной тест на Node. Стаб хоста ← мост (настоящий процесс) ↔ relay ↔ настоящий `remote-client` с `Platform` для Node.
// Сценарий §15 в десяти шагах; внешний relay — `PARLEY_E2E_RELAY_URL=<узел>` (без переменной режим пропускается).
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pushRequestSchema, remoteWorksSnapshotSchema } from '@parley/protocol/remote';
import { createRelay, type Relay } from '@parley/relay/dist/server.js';
import { BUCKETS, DAY, Limiter } from '@parley/relay/dist/limits.js';
import { Store } from '@parley/relay/dist/store.js';
import {
  HostStore,
  Supervisor,
  createRemoteClient,
  pair,
  resolvePushTarget,
  selectInbox,
  selectNeedsYouCount,
  type Clock,
  type HostRecord,
  type RemoteClient,
  type SessionRef,
} from '@parley/remote-client';
// Тестовая `Platform` лежит в пакете клиента (план A17); относительный путь — тест вне его `src`.
import { nodePlatform, type NodePlatform } from '../../remote-client/test/node-platform.js';
import { startBridgeProcess, permissionCard, routeFor, until, sleep, type BridgeProcess } from './harness.js';

const ref = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-1', sessionId });
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as never),
};

// ---- мок push-шлюза по схеме A1 (без настоящего шлюза A5) ----
interface Gateway {
  url: string;
  posts: Array<{ url: string; body: any }>;
  close(): Promise<void>;
}
async function startGateway(): Promise<Gateway> {
  const posts: Gateway['posts'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      posts.push({ url: req.url ?? '', body });
      res.statusCode = pushRequestSchema.safeParse(body).success ? 200 : 400;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface Mode {
  name: string;
  /** `host[:port]` relay для remote.json. */
  relayHost(): string;
  loopback: boolean;
  rewrite?: (url: string) => string;
  local: boolean;
  /** Фиксированный маршрут по месту (внешний relay: лимит новых маршрутов в сутки). */
  route?: (slot: number) => { routeId: string; routeSecret: string };
}

interface Phone {
  platform: NodePlatform;
  record: HostRecord;
  sup: Supervisor;
  client: RemoteClient;
}

function scenarios(mode: Mode): void {
  const live: BridgeProcess[] = [];
  const supervisors: Supervisor[] = [];
  const clients: RemoteClient[] = [];
  let gateway: Gateway;

  beforeAll(async () => {
    gateway = await startGateway();
  });
  afterAll(async () => {
    await gateway.close();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.dispose();
    for (const s of supervisors.splice(0)) s.stop();
    for (const b of live.splice(0)) {
      await b.stop();
      rmSync(b.home, { recursive: true, force: true });
    }
    gateway.posts.length = 0;
  });

  const bridge = async (slot = 0): Promise<BridgeProcess> => {
    const b = await startBridgeProcess({
      relay: mode.relayHost(),
      pushGatewayUrl: gateway.url,
      loopback: mode.loopback,
      ...(mode.route ? { route: mode.route(slot) } : {}),
    });
    live.push(b);
    return b;
  };

  /** Паринг настоящим клиентом, подключение и сборка стора клиента. */
  async function pairPhone(b: BridgeProcess, platform: NodePlatform, name: string, clock: Clock = realClock): Promise<Phone> {
    const { qr } = await b.control.call('pair.start');
    const store = new HostStore(platform.keyStore);
    b.control.events.length = 0;
    const pairing = pair(platform, store, qr, { deviceName: name, platformName: 'ios', app: 'parley-mobile/1.0.0', onSas: () => {} });
    const request = await until(() => b.control.events.find((e) => e.event === 'pair.request')?.data);
    await b.control.call('pair.answer', { requestId: request.requestId, allow: true });
    const record = await pairing;
    await until(() => b.control.events.some((e) => e.event === 'pair.done'));
    const sup = new Supervisor(platform, store, { hostId: record.hostId, client: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' } });
    supervisors.push(sup);
    const client = createRemoteClient({ rpc: { call: (m, p) => sup.call(m, p) }, clock });
    clients.push(client);
    sup.onEvent((event, data) => client.handleEvent(event, data));
    sup.subscribe((s) => {
      client.setBridgeMethods(s.state === 'ready' ? (s.hello?.methods ?? null) : null);
      client.refresher.setConnected(s.state === 'ready');
    });
    sup.start();
    await until(() => sup.status.state === 'ready');
    return { platform, record, sup, client };
  }

  const platformFor = (records?: Map<string, HostRecord>): NodePlatform =>
    nodePlatform({ WebSocket: WebSocket as never, ...(mode.rewrite ? { rewriteUrl: mode.rewrite } : {}), ...(records ? { records } : {}) });

  it('the ten steps of §15', async () => {
    const b = await bridge();
    b.host.addSessions('s-1', 's-2');
    b.host.publish();

    // 1–3. Pairing, connection, snapshot.
    const phone = await pairPhone(b, platformFor(), 'E2E iPhone');
    const { client, sup, record } = phone;
    await until(() => client.store.getState().snapshot?.works[0]?.sessions.length === 2);
    expect(JSON.stringify(client.store.getState().snapshot)).not.toContain('SECRET');
    // The raw answer of the bridge (before any parsing of ours): the projection only, nothing of the host snapshot.
    const raw = await sup.call('works.list');
    expect(remoteWorksSnapshotSchema.safeParse(raw).success).toBe(true);
    for (const leaked of ['SECRET', '"plans"', '"task"', '"history"', '"branches"', '"secret"']) expect(JSON.stringify(raw), leaked).not.toContain(leaked);
    expect(sup.status.hello?.methods).toEqual(expect.arrayContaining(['works.list', 'feed.decide', 'rooms.resolveProposal']));
    await sup.call('push.register', { apnsToken: 'AB'.repeat(32), env: 'sandbox' });

    // 4. A session of the host stub becomes blocked: the phone sees it in its Inbox.
    b.host.block('s-1', [permissionCard('c-1', 'pnpm lint')]);
    await until(() => client.store.getState().activity[`/p\u0000w-1\u0000s-1`]?.activity.activity === 'blocked');
    expect(selectInbox(client.store.getState()).map((i) => i.kind)).toEqual(['need']);
    expect(selectNeedsYouCount(client.store.getState())).toBe(1);

    // 5. The push goes to the gateway mock, with the host's route and only the schema fields.
    const push = await until(() => gateway.posts[0], 8000);
    expect(push.url).toBe('/v1/push');
    expect(push.body).toEqual({ v: 1, token: 'ab'.repeat(32), env: 'sandbox', count: 1, route: record.routeId });

    // 6. feed.decide: the card is applied at the host stub.
    expect((await client.readCards(ref('s-1'))).ok).toBe(true);
    expect(selectInbox(client.store.getState())[0]).toMatchObject({ kind: 'card' });
    expect(await client.decide(ref('s-1'), 'c-1', { kind: 'permission', behavior: 'allow' })).toEqual({ outcome: 'applied' });
    expect(b.host.cards.get('s-1')).toEqual([]);
    const audit = (await b.control.call('audit.tail', { limit: 50 })).records.filter((r: any) => r.method === 'feed.decide');
    expect(audit).toEqual([expect.objectContaining({ kind: 'call', target: 's-1', outcome: 'ok' })]);

    // 7. Answered at the Mac, then a new request of the same session: seen within 3 s + RTT, without a reconnect (§10.3).
    b.host.replaceCards('s-1', [permissionCard('c-2', 'ls')]);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await until(() => client.store.getState().cards[`/p\u0000w-1\u0000s-1`]?.cards.some((c) => c.cardId === 'c-2'));
    const sockets = phone.platform.opened();
    b.host.replaceCards('s-1', [permissionCard('c-3', 'pwd')]);
    const started = Date.now();
    await until(() => client.store.getState().cards[`/p\u0000w-1\u0000s-1`]?.cards.map((c) => c.cardId).join() === 'c-3', 8000);
    // The tick is 3 s; the rest is the margin of a loaded CI machine.
    expect(Date.now() - started).toBeLessThanOrEqual(5000);
    expect(Object.values(client.store.getState().gone).map((g) => g.cardId)).toContain('c-2');
    expect(phone.platform.opened()).toBe(sockets);
    expect(sup.status.state).toBe('ready');
    client.refresher.setScreen({ kind: 'other' });

    // 8. A stale rev → conflict, and the new decision text comes from the snapshot.
    b.host.setProposal('r-1', { id: 'p-1', rev: 1 });
    await until(() => client.store.getState().snapshot?.works[0]?.rooms[0]?.proposal?.rev === 1);
    b.host.setProposal('r-1', { id: 'p-1', rev: 2 });
    await until(() => client.store.getState().snapshot?.works[0]?.rooms[0]?.proposal?.rev === 2);
    const params = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', proposalId: 'p-1', action: 'accept' as const };
    const conflict = await client.resolveProposal({ ...params, rev: 1 });
    expect(conflict).toMatchObject({ outcome: 'conflict', proposal: { rev: 2 } });
    expect(await client.resolveProposal({ ...params, rev: 2 })).toEqual({ outcome: 'applied' });

    // 10. Revoke: `session.closing revoked` blocks the client; the node answers unknown_device on the next connect.
    const { devices } = await b.control.call('devices.list');
    await b.control.call('devices.revoke', { deviceId: devices[0].deviceId });
    await until(() => sup.status.blocked === 'revoked');
    const again = new Supervisor(phone.platform, new HostStore(phone.platform.keyStore), { hostId: record.hostId, client: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' } });
    supervisors.push(again);
    again.start();
    await until(() => again.status.relayError === 'unknown_device', 10_000);
  }, 120_000);

  it('9. a second host on the same client: each push carries its own route and opens that host, not the other', async () => {
    const records = new Map<string, HostRecord>();
    const platform = platformFor(records);
    const first = await bridge(0);
    const second = await bridge(1);
    const a = await pairPhone(first, platform, 'Phone');
    const c = await pairPhone(second, platform, 'Phone');
    expect(a.record.routeId).not.toBe(c.record.routeId);
    expect(a.record.hostId).not.toBe(c.record.hostId);
    for (const p of [a, c]) await p.sup.call('push.register', { apnsToken: 'CD'.repeat(32), env: 'sandbox' });
    for (const [b, p] of [[first, a], [second, c]] as const) {
      b.host.addSessions('s-1');
      b.host.publish();
      await until(() => p.client.store.getState().snapshot?.works[0]?.sessions.length === 1);
    }
    // The second host blocks first: its push must open it, not the first.
    second.host.block('s-1');
    const pushSecond = await until(() => gateway.posts.find((p) => p.body.route === c.record.routeId), 8000);
    const hosts = [...records.values()];
    const target = (body: any) => resolvePushTarget({ v: 1, kind: 'needs-you', count: body.count, route: body.route }, hosts);
    expect(target(pushSecond.body)).toMatchObject({ kind: 'host', host: { hostId: c.record.hostId } });
    expect(gateway.posts.some((p) => p.body.route === a.record.routeId)).toBe(false);
    // Then the first host blocks: its own push opens the first one.
    first.host.block('s-1');
    const pushFirst = await until(() => gateway.posts.find((p) => p.body.route === a.record.routeId), 8000);
    expect(target(pushFirst.body)).toMatchObject({ kind: 'host', host: { hostId: a.record.hostId } });
    // A route of a Mac that is not paired (any more) opens nothing.
    expect(resolvePushTarget({ v: 1, kind: 'needs-you', count: 1, route: 'AAAAAAAAAAAAAAAAAAAAAA' }, hosts)).toEqual({ kind: 'unknown' });
  }, 120_000);

  (mode.local ? it : it.skip)('Inbox scheduler against the real bridge: 30 waiting, 9 always visible (time ×10)', async () => {
    const b = await bridge();
    const ids = Array.from({ length: 30 }, (_, i) => `s-${String(i + 1).padStart(2, '0')}`);
    b.host.addSessions(...ids);
    b.host.publish();
    const start = Date.now();
    // A clock ten times faster: a 10 s tick is 1 s of real time, the whole 30 s round is 3 s.
    const fast: Clock = {
      now: () => start + (Date.now() - start) * 10,
      setTimeout: (f, ms) => setTimeout(f, ms / 10),
      clearTimeout: (h) => clearTimeout(h as never),
      setInterval: (f, ms) => setInterval(f, ms / 10),
      clearInterval: (h) => clearInterval(h as never),
    };
    const { client } = await pairPhone(b, platformFor(), 'Scheduler phone', fast);
    for (const id of ids) b.host.block(id, [permissionCard(`c-${id}`, 'ls')]);
    await until(() => Object.values(client.store.getState().activity).length === 30);
    b.host.calls.length = 0;
    client.refresher.setConnected(true);
    const visible = ids.slice(0, 9);
    client.refresher.setScreen({ kind: 'inbox', visible: visible.map(ref) });
    await sleep(3700);
    client.refresher.setScreen({ kind: 'other' });

    const reads = b.host.callsOf('feed.snapshot');
    const t0 = reads[0]!.at;
    const within = (id: string, ms: number): number => reads.filter((r) => r.params.ref.sessionId === id && r.at - t0 <= ms).length;
    // Every one of the 21 invisible sessions is read within 30 virtual seconds (3 s real); visible ones every 10 s.
    for (const id of ids.slice(9)) expect(within(id, 3500), id).toBeGreaterThanOrEqual(1);
    for (const id of visible) expect(within(id, 3500), id).toBeGreaterThanOrEqual(3);
    // At most 20 reads per tick (the per-tick budget is also a unit test); the ticks that fired are counted from the clock,
    // not guessed from pauses between calls, so a loaded machine cannot merge two of them into one.
    const ticks = Math.floor((Date.now() - t0) / 1000) + 1;
    expect(reads.length).toBeLessThanOrEqual(20 * ticks);
    expect(Object.values(client.store.getState().cards).filter((c) => c.error)).toEqual([]);
  }, 120_000);
}

// ---- локальный relay ----
describe('e2e, local relay', () => {
  let relay: Relay;
  let relayHost = '';
  beforeAll(async () => {
    // Test relay: no daily limit on new routes, or a CI retry of one test would hit `rate_limited` on its sixth route.
    const limiter = new Limiter({ buckets: { ...BUCKETS, newRoute: { limit: 1_000, windowMs: DAY } } });
    relay = createRelay({ store: new Store(null), limiter, log: () => {}, timing: { acceptWaitMs: 1500 } });
    await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
    relayHost = `127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await relay.close();
  });
  scenarios({
    name: 'local',
    relayHost: () => relayHost,
    loopback: true,
    // relay на петле: клиент строит `wss://` (адрес не частный), тесту нужен `ws://`
    rewrite: (url) => url.replace(/^wss:\/\/127\.0\.0\.1/, 'ws://127.0.0.1'),
    local: true,
  });
});

/** `https://relay.example.com[:port]` или `wss://…` → `host[:port]`; всё остальное — сразу понятная ошибка. */
export function externalRelayHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PARLEY_E2E_RELAY_URL must be an https:// or wss:// address, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') throw new Error(`PARLEY_E2E_RELAY_URL must be https:// or wss://, got ${url.protocol}//`);
  return url.host;
}

// ---- relay, который не пускает новые маршруты: понятная ошибка и никаких сирот ----
describe('e2e harness: a relay that refuses new routes', () => {
  it('fails fast with "relay: rate_limited" in the message and leaves no process, stub or home behind', async () => {
    const strict = createRelay({ store: new Store(null), limiter: new Limiter({ buckets: { ...BUCKETS, newRoute: { limit: 0, windowMs: DAY } } }), log: () => {}, timing: { acceptWaitMs: 1500 } });
    await new Promise<void>((r) => strict.server.listen(0, '127.0.0.1', () => r()));
    const homes = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('e2e-'));
    const before = homes();
    try {
      await expect(
        startBridgeProcess({ relay: `127.0.0.1:${(strict.server.address() as AddressInfo).port}`, loopback: true }),
      ).rejects.toThrow(/relay: rate_limited[\s\S]*bridge\.log/);
      expect(homes()).toEqual(before);
    } finally {
      await strict.close();
    }
  }, 30_000);
});

// ---- внешний relay: тот же сценарий против развёрнутого узла, без переменной пропускается ----
const external = process.env.PARLEY_E2E_RELAY_URL;
// Разбор сразу, при сборе тестов: неверный адрес — понятная ошибка, а не десять секунд ожидания.
const externalHost = external ? externalRelayHost(external) : '';
describe.skipIf(!external)('e2e, external relay (PARLEY_E2E_RELAY_URL)', () => {
  scenarios({
    name: 'external',
    relayHost: () => externalHost,
    loopback: false,
    local: false,
    route: routeFor,
  });
});
