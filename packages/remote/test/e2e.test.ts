/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
// A17: сквозной тест на Node. Стаб хоста ← мост (настоящий процесс) ↔ relay ↔ настоящий `remote-client` с `Platform` для Node.
// Сценарий §15 в десяти шагах; внешний relay — `PARLEY_E2E_RELAY_URL=<узел>` (без переменной режим пропускается).
import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pushRequestSchema } from '@parley/protocol/remote';
import { createRelay, type Relay } from '@parley/relay/dist/server.js';
import { Store } from '@parley/relay/dist/store.js';
import {
  HostStore,
  Supervisor,
  createRemoteClient,
  pair,
  selectInbox,
  selectNeedsYouCount,
  type Clock,
  type HostRecord,
  type RemoteClient,
  type SessionRef,
} from '@parley/remote-client';
// Тестовая `Platform` лежит в пакете клиента (план A17); относительный путь — тест вне его `src`.
import { nodePlatform, type NodePlatform } from '../../remote-client/test/node-platform.js';
import { startBridgeProcess, permissionCard, until, sleep, type BridgeProcess } from './harness.js';

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

  const bridge = async (): Promise<BridgeProcess> => {
    const b = await startBridgeProcess({ relay: mode.relayHost(), pushGatewayUrl: gateway.url, loopback: mode.loopback });
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
    await until(() => client.store.getState().cards[`/p\u0000w-1\u0000s-1`]?.cards.map((c) => c.cardId).join() === 'c-3', 5000);
    expect(Date.now() - started).toBeLessThanOrEqual(4000);
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

  it('9. a second host on the same client: its push carries its route and opens it, not the first', async () => {
    const records = new Map<string, HostRecord>();
    const platform = platformFor(records);
    const first = await bridge();
    const second = await bridge();
    const a = await pairPhone(first, platform, 'Phone');
    const c = await pairPhone(second, platform, 'Phone');
    expect(a.record.routeId).not.toBe(c.record.routeId);
    expect(a.record.hostId).not.toBe(c.record.hostId);
    for (const p of [a, c]) await p.sup.call('push.register', { apnsToken: 'CD'.repeat(32), env: 'sandbox' });
    second.host.addSessions('s-1');
    second.host.publish();
    await until(() => c.client.store.getState().snapshot?.works[0]?.sessions.length === 1);
    second.host.block('s-1');
    const push = await until(() => gateway.posts[0], 8000);
    expect(push.body.route).toBe(c.record.routeId);
    expect([...records.values()].find((r) => r.routeId === push.body.route)?.hostId).toBe(c.record.hostId);
    await sleep(500);
    expect(gateway.posts.every((p) => p.body.route === c.record.routeId)).toBe(true);
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
    await sleep(4200);
    client.refresher.setScreen({ kind: 'other' });

    const reads = b.host.callsOf('feed.snapshot');
    const t0 = reads[0]!.at;
    const within = (id: string, ms: number): number => reads.filter((r) => r.params.ref.sessionId === id && r.at - t0 <= ms).length;
    // Every one of the 21 invisible sessions is read within 30 virtual seconds (3 s real); visible ones every 10 s.
    for (const id of ids.slice(9)) expect(within(id, 3500), id).toBeGreaterThanOrEqual(1);
    for (const id of visible) expect(within(id, 3500), id).toBeGreaterThanOrEqual(3);
    // No tick asks for more than 20 reads, and none of them was refused for being too many (bridge: 16 in flight).
    const ticks: number[][] = [];
    for (const r of reads) {
      const last = ticks.at(-1);
      if (last !== undefined && r.at - last[last.length - 1]! < 300) last.push(r.at);
      else ticks.push([r.at]);
    }
    for (const tick of ticks) expect(tick.length).toBeLessThanOrEqual(20);
    expect(Object.values(client.store.getState().cards).filter((c) => c.error)).toEqual([]);
  }, 120_000);
}

// ---- локальный relay ----
describe('e2e, local relay', () => {
  let relay: Relay;
  let relayHost = '';
  beforeAll(async () => {
    relay = createRelay({ store: new Store(null), log: () => {}, timing: { acceptWaitMs: 1500 } });
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

// ---- внешний relay: тот же сценарий против развёрнутого узла, без переменной пропускается ----
const external = process.env.PARLEY_E2E_RELAY_URL;
describe.skipIf(!external)('e2e, external relay (PARLEY_E2E_RELAY_URL)', () => {
  scenarios({
    name: 'external',
    relayHost: () => (external ?? '').replace(/^wss?:\/\//, '').replace(/\/.*$/, ''),
    loopback: false,
    local: false,
  });
});
