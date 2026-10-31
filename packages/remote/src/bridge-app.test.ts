/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorksSnapshot } from '@parley/protocol';
import { bridgeHelloSchema, remoteWorksSnapshotSchema } from '@parley/protocol/remote';
import type { AuditInput, AuditLog } from './audit.js';
import { createSessionHandler } from './dispatch.js';
import { HostCallError, refKey } from './host-link.js';
import type { ActivityEntry, HostLink, HostLinkEvent, HostLinkStatus } from './host-link.js';
import type { SessionHandler, PhoneSessions, DevicePush, SessionClosingReason } from './session-contract.js';
import type { BridgeLog } from './log.js';

type Frame = Record<string, any>;
const enc = new TextEncoder();
const dec = new TextDecoder();

const session = (id: string) => ({
  id, provider: 'claude', label: 'l', task: 'SECRET TASK', parent: null, contextFrom: [], lifecycle: 'active', result: null,
  resultAt: null, closedAt: null, history: [{ event: 'active', at: 'a' }], startedAt: 's', endedAt: null, pid: null,
  startedAtProcess: null, launchedBy: null, providerSessionId: null, metrics: {}, summary: 'SECRET SUMMARY', summarySource: null,
  artifacts: [], worktree: null, role: null, model: null,
});
const snap = (revision: number): WorksSnapshot =>
  ({
    revision,
    branches: {},
    entries: [
      {
        projectPath: '/p',
        map: {
          work: { id: 'w-1', title: 'W', status: 'active', updatedAt: 'x' },
          sessions: [session('s-1')],
          rooms: [],
          plans: [{ secret: 1 }],
          planEffects: [],
          resources: {},
          messages: [],
        },
      },
    ],
  }) as unknown as WorksSnapshot;

const ref = (sessionId: string) => ({ projectPath: '/p', workId: 'w-1', sessionId });
const act = (sessionId: string, activity: string) => ({ ref: ref(sessionId), activity, metrics: null });

class FakeHost implements HostLink {
  status: HostLinkStatus = 'offline';
  epoch: string | null = null;
  snapshot: WorksSnapshot | null = null;
  activity = new Map<string, ActivityEntry>();
  calls: { method: string; params: unknown }[] = [];
  handler: (method: string, params: unknown) => Promise<unknown> = async () => ({ ok: true });
  listeners = new Set<(e: HostLinkEvent) => void>();
  start() {}
  async stop() {}
  async call(method: string, params?: unknown) {
    if (this.status !== 'online') throw new HostCallError('host_offline');
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
  subscribe(l: (e: HostLinkEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(e: HostLinkEvent) {
    for (const l of this.listeners) l(e);
  }
  /** Подключение к хосту: новая эпоха, загрузка. */
  connect(epoch: string) {
    this.epoch = epoch;
    this.snapshot = null;
    this.activity = new Map();
    this.emit({ type: 'status', status: this.status, epoch });
    this.status = 'starting';
    this.emit({ type: 'status', status: 'starting', epoch });
  }
  load(revision: number, activities: ReturnType<typeof act>[] = []) {
    this.snapshot = snap(revision);
    for (const a of activities) this.activity.set(refKey(a.ref), a);
    this.status = 'online';
    this.emit({ type: 'status', status: 'online', epoch: this.epoch });
  }
  drop(status: HostLinkStatus = 'offline') {
    this.status = status;
    this.snapshot = null;
    this.activity = new Map();
    this.emit({ type: 'status', status, epoch: this.epoch });
  }
  works(revision: number) {
    this.snapshot = snap(revision);
    this.emit({ type: 'host', event: 'works.changed', data: snap(revision) });
  }
  activityChanged(a: ReturnType<typeof act>) {
    this.activity.set(refKey(a.ref), a);
    this.emit({ type: 'host', event: 'activity.changed', data: a });
  }
  event(event: string, data: unknown) {
    this.emit({ type: 'host', event, data });
  }
}

class FakeSessions implements PhoneSessions {
  frames = new Map<string, Frame[]>();
  closed: { deviceId: string; reason: SessionClosingReason }[] = [];
  queued = 0;
  pushes: Record<string, DevicePush | null> = {};
  async setPush(deviceId: string, value: DevicePush | null) {
    this.pushes[deviceId] = value;
  }
  send(deviceId: string, frame: Uint8Array) {
    const list = this.frames.get(deviceId) ?? [];
    list.push(JSON.parse(dec.decode(frame)));
    this.frames.set(deviceId, list);
    return true;
  }
  close(deviceId: string, reason: SessionClosingReason) {
    this.closed.push({ deviceId, reason });
  }
  bufferedBytes() {
    return this.queued;
  }
  of(deviceId: string): Frame[] {
    return this.frames.get(deviceId) ?? [];
  }
}

let host: FakeHost;
let sessions: FakeSessions;
let audits: AuditInput[];
let dispatcher: SessionHandler & { stop(): void };

const log: BridgeLog = { info() {}, warn() {}, error() {}, addSecret() {} };
const audit: AuditLog = { append: (r) => void audits.push(r), tail: () => [] };
beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  sessions = new FakeSessions();
  audits = [];
  dispatcher = createSessionHandler({
    host,
    sessions,
    audit,
    log,
    info: { hostId: 'h1', hostName: 'Mac', bridgeVersion: '0.1.0', minClient: '1.0.0', relays: [] },
    deviceName: () => 'Phone 1',
  });
});
afterEach(() => {
  dispatcher.stop();
  vi.useRealTimers();
});

const online = (revision = 1, activities: ReturnType<typeof act>[] = []) => {
  host.connect('b:1');
  host.load(revision, activities);
};
const call = (deviceId: string, id: string, method: string, params?: unknown) =>
  dispatcher.onFrame(deviceId, enc.encode(JSON.stringify({ id, method, params })));
const flush = () => vi.advanceTimersByTimeAsync(0);
const events = (deviceId: string, name: string) => sessions.of(deviceId).filter((f) => f.event === name);

describe('dispatcher', () => {
  beforeEach(() => {
    online();
    dispatcher.onOpen('d1');
  });

  it('1. a method outside the allowlist never reaches the host', async () => {
    call('d1', 'a', 'settings.set', { k: 1 });
    await flush();
    expect(host.calls).toEqual([]);
    expect(sessions.of('d1').at(-1)).toMatchObject({ id: 'a', error: { code: 'unknown_method' } });
    expect(audits).toEqual([expect.objectContaining({ kind: 'call-refused', method: 'settings.set', outcome: 'unknown_method' })]);
  });

  it('bad params are refused before the host (rooms.resolveProposal without rev)', async () => {
    call('d1', 'a', 'rooms.resolveProposal', { id: 'p' });
    await flush();
    expect(host.calls).toEqual([]);
    expect(sessions.of('d1').at(-1)).toMatchObject({ id: 'a', error: { code: 'bad_request' } });
    expect(audits[0]).toMatchObject({ kind: 'call-refused', method: 'rooms.resolveProposal' });
  });

  it('2. two phones with the same id get their own answers', async () => {
    dispatcher.onOpen('d2');
    const resolvers: ((v: unknown) => void)[] = [];
    host.handler = () => new Promise((r) => resolvers.push(r));
    call('d1', '1', 'host.info');
    call('d2', '1', 'works.list');
    await flush();
    resolvers[1]!({ from: 'second' });
    resolvers[0]!({ from: 'first' });
    await flush();
    expect(sessions.of('d1').at(-1)).toEqual({ id: '1', result: { from: 'first' } });
    expect(sessions.of('d2').at(-1)).toEqual({ id: '1', result: { from: 'second' } });
  });

  it('4. the 31st mutating call within a minute is rate_limited, the 31st read is not', async () => {
    for (let i = 0; i < 30; i++) {
      call('d1', `m${i}`, 'feed.decide', { n: i });
      await flush();
    }
    call('d1', 'over', 'feed.decide', {});
    for (let i = 0; i < 40; i++) {
      call('d1', `r${i}`, 'works.list');
      await flush();
    }
    expect(host.calls.filter((c) => c.method === 'feed.decide')).toHaveLength(30);
    expect(sessions.of('d1').find((f) => f.id === 'over')).toMatchObject({ error: { code: 'rate_limited' } });
    expect(sessions.of('d1').filter((f) => f.id?.startsWith('r') && f.error?.code === 'rate_limited').length).toBe(0);
    await vi.advanceTimersByTimeAsync(61_000);
    call('d1', 'later', 'feed.decide', {});
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'later')).toMatchObject({ result: { ok: true } });
  });

  it('allows at most 16 requests in flight', async () => {
    host.handler = () => new Promise(() => {});
    for (let i = 0; i < 17; i++) call('d1', `i${i}`, 'works.list');
    await flush();
    expect(host.calls).toHaveLength(16);
    expect(sessions.of('d1').find((f) => f.id === 'i16')).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('5. a frame over 64 KiB closes the session', async () => {
    dispatcher.onFrame('d1', new Uint8Array(64 * 1024 + 1));
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'shutdown' }]);
    expect(host.calls).toEqual([]);
  });

  it('a malformed frame closes the session', () => {
    dispatcher.onFrame('d1', enc.encode('{"id":1}'));
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'shutdown' }]);
  });

  it('6. host down: phones get bridge.status offline, calls get host_offline', async () => {
    host.drop('offline');
    expect(sessions.of('d1').at(-1)).toEqual({ event: 'bridge.status', data: { host: 'offline', epoch: 'b:1' } });
    call('d1', 'x', 'works.list');
    await flush();
    expect(sessions.of('d1').at(-1)).toMatchObject({ id: 'x', error: { code: 'host_offline' } });
    expect(host.calls).toEqual([]);
  });

  it('9. incompatible host: calls give host_offline and nothing reaches the host', async () => {
    host.drop('incompatible');
    call('d1', 'x', 'feed.decide', {});
    await flush();
    expect(sessions.of('d1').at(-1)).toMatchObject({ id: 'x', error: { code: 'host_offline' } });
    expect(host.calls).toEqual([]);
  });

  it('host errors pass as is; data only for a known reason', async () => {
    host.handler = async () => {
      throw new HostCallError('conflict', 'busy now', { reason: 'busy', extra: 1 });
    };
    call('d1', 'a', 'works.list');
    host.handler = async () => {
      throw new HostCallError('internal', 'boom', { reason: 'secret-path', path: '/x' });
    };
    await flush();
    call('d1', 'b', 'works.list');
    host.handler = async () => {
      throw new Error('/Users/x/secret');
    };
    await flush();
    call('d1', 'c', 'works.list');
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'a')).toEqual({ id: 'a', error: { code: 'conflict', message: 'busy now', data: { reason: 'busy', extra: 1 } } });
    expect(sessions.of('d1').find((f) => f.id === 'b')).toEqual({ id: 'b', error: { code: 'internal', message: 'boom' } });
    expect(sessions.of('d1').find((f) => f.id === 'c')).toEqual({ id: 'c', error: { code: 'internal', message: 'internal error' } });
  });

  it('audits mutating calls without their text, and not reads', async () => {
    call('d1', 'a', 'feed.decide', { ref: 's-1', choice: 'allow', note: 'private words here that are long enough' });
    call('d1', 'b', 'works.list');
    await flush();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ kind: 'call', method: 'feed.decide', deviceId: 'd1', deviceName: 'Phone 1', outcome: 'ok' });
    expect(JSON.stringify(audits)).not.toContain('private words');
    expect(audits[0]!.detail).toContain('choice=allow');
    expect(audits[0]!.detail).toMatch(/note:len=\d+,sha256=/);
  });

  it('bridge methods: ping, client.info, push.register never reach the host', async () => {
    call('d1', '1', 'ping', {});
    call('d1', '2', 'client.info', { app: 'parley', version: '1.0.0', platform: 'ios' });
    call('d1', '3', 'push.register', { apnsToken: 'ab'.repeat(32), env: 'sandbox' });
    call('d1', '4', 'push.register', { apnsToken: 'not hex', env: 'sandbox' });
    await flush();
    expect(host.calls).toEqual([]);
    const byId = (id: string) => sessions.of('d1').find((f) => f.id === id);
    expect(byId('1')).toEqual({ id: '1', result: {} });
    expect(byId('2')).toEqual({ id: '2', result: {} });
    expect(byId('3')).toEqual({ id: '3', result: {} });
    expect(byId('4')).toMatchObject({ error: { code: 'bad_request' } });
    expect(sessions.pushes['d1']).toEqual({ apnsToken: 'ab'.repeat(32), env: 'sandbox' });
    call('d1', '5', 'push.register', { apnsToken: null, env: 'sandbox' });
    await flush();
    expect(sessions.pushes['d1']).toBeNull();
  });

  it('bridge methods work while the host is offline', async () => {
    host.drop('offline');
    call('d1', '1', 'ping', {});
    await flush();
    expect(sessions.of('d1').at(-1)).toEqual({ id: '1', result: {} });
  });

  it('a response above 8 MiB becomes too_large', async () => {
    host.handler = async () => 'x'.repeat(8 * 1024 * 1024 + 10);
    call('d1', 'big', 'works.list');
    await flush();
    expect(sessions.of('d1').at(-1)).toEqual({ id: 'big', error: { code: 'too_large', message: 'response is too large' } });
  });
});

describe('hello', () => {
  it('describes the host state and the stage A lists', () => {
    online(2);
    const hello = dispatcher.hello('d1');
    expect(bridgeHelloSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({ host: 'online', epoch: 'b:1', stage: 'A' });
    expect(hello.methods).toEqual(expect.arrayContaining(['works.list', 'feed.decide', 'ping', 'push.register']));
    expect(hello.methods).not.toContain('settings.set');
    expect(hello.events).toEqual(expect.arrayContaining(['works.changed', 'bridge.status', 'activity.snapshot']));
  });
});

describe('fanout', () => {
  it('3. 10 works.changed within 300 ms: the last one, once', async () => {
    online(1);
    dispatcher.onOpen('d1');
    const before = events('d1', 'works.changed').length;
    for (let i = 2; i <= 11; i++) {
      host.works(i);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(events('d1', 'works.changed')).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1000);
    const got = events('d1', 'works.changed');
    expect(got).toHaveLength(before + 1);
    expect(got.at(-1).data.revision).toBe(11);
  });

  it('works.changed older than the pending revision does not win', async () => {
    online(5);
    dispatcher.onOpen('d1');
    host.works(9);
    host.works(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events('d1', 'works.changed').at(-1).data.revision).toBe(9);
  });

  it('7. a phone joining a blocked session: status, snapshot, activity.snapshot first', () => {
    online(3, [act('s-1', 'blocked')]);
    dispatcher.onOpen('d1');
    const frames = sessions.of('d1');
    expect(frames.slice(0, 3).map((f) => f.event)).toEqual(['bridge.status', 'works.changed', 'activity.snapshot']);
    expect(frames[0].data).toEqual({ host: 'online', epoch: 'b:1' });
    expect(frames[2].data.items).toEqual([act('s-1', 'blocked')]);
    expect(frames).toHaveLength(3);
  });

  it('8. host restart: a new epoch, revision 1 reaches the phone after revision 40', async () => {
    online(40);
    dispatcher.onOpen('d1');
    host.drop('offline');
    host.connect('b:2');
    host.load(1);
    const last = sessions.of('d1').slice(-3);
    expect(last.map((f) => f.event)).toEqual(['bridge.status', 'works.changed', 'activity.snapshot']);
    expect(last[0].data).toEqual({ host: 'online', epoch: 'b:2' });
    expect(last[1].data.revision).toBe(1);
    host.works(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events('d1', 'works.changed').at(-1).data.revision).toBe(2);
  });

  it('8b. a new epoch resets coalescing: a pending old snapshot is not sent', async () => {
    online(40);
    dispatcher.onOpen('d1');
    host.works(41);
    host.drop('offline');
    host.connect('b:2');
    host.load(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events('d1', 'works.changed').map((f) => f.data.revision)).toEqual([40, 1]);
  });

  it('8c. a fresh bridge with a restarted host: the phone connecting later starts at revision 1', () => {
    online(1);
    dispatcher.onOpen('d9');
    expect(events('d9', 'works.changed')[0].data.revision).toBe(1);
  });

  it('10. a phone connecting while the epoch loads gets starting, then the initial state; calls get host_offline', async () => {
    host.connect('b:1');
    dispatcher.onOpen('d1');
    expect(sessions.of('d1')).toEqual([{ event: 'bridge.status', data: { host: 'starting', epoch: 'b:1' } }]);
    call('d1', 'x', 'works.list');
    await flush();
    expect(sessions.of('d1').at(-1)).toMatchObject({ id: 'x', error: { code: 'host_offline' } });
    expect(host.calls).toEqual([]);
    host.load(4, [act('s-1', 'working')]);
    expect(sessions.of('d1').slice(-3).map((f) => f.event)).toEqual(['bridge.status', 'works.changed', 'activity.snapshot']);
    expect(sessions.of('d1').at(-3).data).toEqual({ host: 'online', epoch: 'b:1' });
  });

  it('11. snapshots pass remoteWorksSnapshotSchema; no task/summary/plans in any frame', async () => {
    online(1);
    dispatcher.onOpen('d1');
    host.works(2);
    await vi.advanceTimersByTimeAsync(1000);
    for (const f of events('d1', 'works.changed')) expect(remoteWorksSnapshotSchema.safeParse(f.data).success).toBe(true);
    const text = JSON.stringify(sessions.of('d1'));
    expect(text).not.toMatch(/"(task|summary|plans)"/);
    expect(text).not.toContain('SECRET');
  });

  it('12. 10 activity.changed of one ref: the last, once; two refs are both delivered', async () => {
    online(1);
    dispatcher.onOpen('d1');
    for (let i = 0; i < 10; i++) {
      host.activityChanged(act('s-1', `a${i}`));
      await vi.advanceTimersByTimeAsync(30);
    }
    host.activityChanged(act('s-2', 'blocked'));
    expect(events('d1', 'activity.changed')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    const got = events('d1', 'activity.changed');
    expect(got.map((f) => [f.data.ref.sessionId, f.data.activity])).toEqual([
      ['s-1', 'a9'],
      ['s-2', 'blocked'],
    ]);
  });

  it('forwards other allowed events at once and drops events outside the stage list', () => {
    online(1);
    dispatcher.onOpen('d1');
    host.event('rooms.mail', { n: 1 });
    host.event('host.notice', { m: 'x' });
    host.event('pty.output', { secret: 1 });
    host.event('feed.changed', {});
    expect(sessions.of('d1').slice(3)).toEqual([
      { event: 'rooms.mail', data: { n: 1 } },
      { event: 'host.notice', data: { m: 'x' } },
    ]);
  });

  it('a slow phone (queue over 4 MiB) is closed with slow and gets nothing more', () => {
    online(1);
    dispatcher.onOpen('d1');
    sessions.queued = 4 * 1024 * 1024 + 1;
    const before = sessions.of('d1').length;
    host.event('rooms.mail', { n: 1 });
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'slow' }]);
    sessions.queued = 0;
    host.event('rooms.mail', { n: 2 });
    expect(sessions.of('d1')).toHaveLength(before + 1);
  });

  it('a closed session stops receiving and its timers are dropped', async () => {
    online(1);
    dispatcher.onOpen('d1');
    host.works(2);
    dispatcher.onClose('d1');
    const n = sessions.of('d1').length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sessions.of('d1')).toHaveLength(n);
  });

  it('phones are independent: coalescing is per phone', async () => {
    online(1);
    dispatcher.onOpen('d1');
    await vi.advanceTimersByTimeAsync(500);
    dispatcher.onOpen('d2');
    host.works(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events('d1', 'works.changed').map((f) => f.data.revision)).toEqual([1, 2]);
    expect(events('d2', 'works.changed').map((f) => f.data.revision)).toEqual([1, 2]);
  });
});
