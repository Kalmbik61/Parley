/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorksSnapshot } from '@parley/protocol';
import { MIN_CLIENT_VERSION, REMOTE_METHODS, bridgeHelloSchema, remoteWorksSnapshotSchema } from '@parley/protocol/remote';
import type { AuditInput, AuditLog } from './audit.js';
import { createSessionHandler } from './dispatch.js';
import { HostCallError, refKey } from './host-link.js';
import type { ActivityEntry, HostLink, HostLinkEvent, HostLinkStatus } from './host-link.js';
import type { SessionHandler, PhoneSessions, DevicePush, SessionClosingReason } from './session-contract.js';
import type { BridgeLog } from './log.js';
import type { PhoneActionEvent } from '@parley/protocol/remote';

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
  methods: string[] | null = null;
  failure: 'line_too_long' | null = null;
  hostMethodSet: string[] = [...REMOTE_METHODS];
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
    this.methods = this.hostMethodSet;
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
    this.methods = null;
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
let actions: PhoneActionEvent[];
let dispatcher: SessionHandler & { stop(): void };

const log: BridgeLog = { info() {}, warn() {}, error() {}, addSecret() {} };
const audit: AuditLog = { append: (r) => void audits.push(r), tail: () => [] };
beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  sessions = new FakeSessions();
  audits = [];
  actions = [];
  dispatcher = createSessionHandler({
    host,
    sessions,
    audit,
    log,
    info: { hostId: 'h1', hostName: 'Mac', bridgeVersion: '0.1.0', minClient: MIN_CLIENT_VERSION, relays: [] },
    deviceName: () => 'Phone 1',
    onPhoneAction: (event) => void actions.push(event),
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
    call('d2', '1', 'feed.snapshot', { ref: ref('s-1'), scope: 'attention' });
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
    for (let i = 0; i < 17; i++) call('d1', `i${i}`, 'host.info');
    await flush();
    expect(host.calls).toHaveLength(16);
    expect(sessions.of('d1').find((f) => f.id === 'i16')).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('5. a frame over 64 KiB closes the session', async () => {
    dispatcher.onFrame('d1', new Uint8Array(64 * 1024 + 1));
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'protocol' }]);
    expect(host.calls).toEqual([]);
  });

  it('a malformed frame closes the session', () => {
    dispatcher.onFrame('d1', enc.encode('{"id":1}'));
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'protocol' }]);
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
    call('d1', 'a', 'host.info');
    host.handler = async () => {
      throw new HostCallError('internal', 'boom', { reason: 'secret-path', path: '/x' });
    };
    await flush();
    call('d1', 'b', 'host.info');
    host.handler = async () => {
      throw new Error('/Users/x/secret');
    };
    await flush();
    call('d1', 'c', 'host.info');
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'a')).toEqual({ id: 'a', error: { code: 'conflict', message: 'busy now', data: { reason: 'busy', extra: 1 } } });
    expect(sessions.of('d1').find((f) => f.id === 'b')).toEqual({ id: 'b', error: { code: 'internal', message: 'boom' } });
    expect(sessions.of('d1').find((f) => f.id === 'c')).toEqual({ id: 'c', error: { code: 'internal', message: 'internal error' } });
  });

  it('audits mutating calls without their text, and not reads', async () => {
    call('d1', 'a', 'feed.decide', { ref: ref('s-1'), cardId: 'c-1', decision: { kind: 'permission', behavior: 'allow', always: true, message: 'private words here that are long enough' } });
    call('d1', 'b', 'works.list');
    await flush();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ kind: 'call', method: 'feed.decide', deviceId: 'd1', deviceName: 'Phone 1', outcome: 'ok', target: 's-1' });
    expect(JSON.stringify(audits)).not.toContain('private words');
    expect(audits[0]!.detail).toContain('cardId=c-1');
    expect(audits[0]!.detail).toContain('kind=permission');
    expect(audits[0]!.detail).toContain('behavior=allow');
    expect(audits[0]!.detail).toContain('always=true');
    expect(audits[0]!.detail).toMatch(/message:len=\d+,sha256=/);
  });

  it('W4: a feed.decide answer to a question is audited by the length and hash of the answers only', async () => {
    call('d1', 'a', 'feed.decide', { ref: ref('s-1'), cardId: 'c-2', decision: { kind: 'question', answers: { q1: 'my secret answer' } } });
    call('d1', 'b', 'feed.decide', { ref: ref('s-1'), cardId: 'c-3', decision: { kind: 'plan', choice: 'manual' } });
    await flush();
    expect(JSON.stringify(audits)).not.toContain('secret answer');
    expect(audits[0]!.detail).toMatch(/answers:len=\d+,sha256=/);
    expect(audits[1]).toMatchObject({ target: 's-1' });
    expect(audits[1]!.detail).toContain('choice=manual');
  });

  it('A27: feed.snapshot from a phone has no scope rule', async () => {
    call('d1', 'a', 'feed.snapshot', { ref: ref('s-1') });
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'a')).toMatchObject({ result: { ok: true } });
    expect(host.calls.map((c) => c.method)).toEqual(['feed.snapshot']);
  });

  it('W3: reads are limited per device (120 a minute), the window slides', async () => {
    for (let i = 0; i < 121; i++) {
      call('d1', `r${i}`, 'host.info');
      await flush();
    }
    expect(sessions.of('d1').filter((f) => f.error?.code === 'rate_limited')).toHaveLength(1);
    expect(sessions.of('d1').find((f) => f.id === 'r120')).toMatchObject({ error: { code: 'rate_limited' } });
    await vi.advanceTimersByTimeAsync(61_000);
    call('d1', 'later', 'host.info');
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'later')).toMatchObject({ result: { ok: true } });
  });

  it('W5: push.register is limited to 10 a minute, and an unchanged token is not written again', async () => {
    const reg = (id: string, token: string | null) => call('d1', id, 'push.register', { apnsToken: token, env: 'sandbox' });
    let writes = 0;
    const set = sessions.setPush.bind(sessions);
    sessions.setPush = async (d, v) => {
      writes++;
      return set(d, v);
    };
    reg('a', 'ab'.repeat(32));
    await flush();
    reg('b', 'ab'.repeat(32));
    await flush();
    expect(writes).toBe(1);
    expect(sessions.of('d1').find((f) => f.id === 'b')).toEqual({ id: 'b', result: {} });
    reg('c', 'cd'.repeat(32));
    await flush();
    expect(writes).toBe(2);
    for (let i = 0; i < 12; i++) reg(`x${i}`, i % 2 ? 'ab'.repeat(32) : 'cd'.repeat(32));
    await flush();
    expect(sessions.of('d1').filter((f) => f.error?.code === 'rate_limited').length).toBeGreaterThan(0);
    // Токен в журнале не появляется, лимит не трогает ping.
    call('d1', 'p', 'ping', {});
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'p')).toEqual({ id: 'p', result: {} });
  });

  it('W5: bridge methods count as in flight', async () => {
    sessions.setPush = () => new Promise(() => {});
    host.handler = () => new Promise(() => {});
    for (let i = 0; i < 10; i++) call('d1', `h${i}`, 'push.register', { apnsToken: i.toString(16).padStart(2, '0').repeat(32), env: 'sandbox' });
    for (let i = 0; i < 6; i++) call('d1', `i${i}`, 'host.info');
    await flush();
    expect(host.calls).toHaveLength(6);
    call('d1', 'ping', 'ping', {});
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'ping')).toMatchObject({ error: { code: 'rate_limited' } });
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
    call('d1', 'big', 'context.text');
    await flush();
    expect(sessions.of('d1').at(-1)).toEqual({ id: 'big', error: { code: 'too_large', message: 'response is too large' } });
  });
});

describe('works.list from a phone', () => {
  it('W3: is answered with the projection of the epoch snapshot, without calling the host', async () => {
    online(3);
    dispatcher.onOpen('d1');
    host.handler = async () => snap(99);
    call('d1', 'w', 'works.list');
    await flush();
    expect(host.calls).toEqual([]);
    const reply = sessions.of('d1').find((f) => f.id === 'w')!;
    expect(remoteWorksSnapshotSchema.safeParse(reply.result).success).toBe(true);
    expect(reply.result.revision).toBe(3);
    expect(JSON.stringify(reply)).not.toMatch(/"(task|summary|plans|planEffects|resources|branches)"/);
    expect(JSON.stringify(reply)).not.toContain('SECRET');
    host.works(4);
    call('d1', 'w2', 'works.list');
    await flush();
    expect(sessions.of('d1').find((f) => f.id === 'w2')!.result.revision).toBe(4);
  });

  it('a snapshot that cannot be projected is an internal error, not the raw one', async () => {
    online(3);
    dispatcher.onOpen('d1');
    host.snapshot = { entries: 'bad', secret: 'SECRET' } as unknown as WorksSnapshot;
    call('d1', 'w', 'works.list');
    await flush();
    const reply = sessions.of('d1').find((f) => f.id === 'w')!;
    expect(reply.error?.code).toBe('internal');
    expect(JSON.stringify(reply)).not.toContain('SECRET');
  });
});

describe('W6: initial state when the projection fails', () => {
  it('the phone still gets bridge.status and the session is closed so it reconnects', () => {
    host.connect('b:1');
    host.status = 'online';
    host.snapshot = { entries: 'bad' } as unknown as WorksSnapshot;
    dispatcher.onOpen('d1');
    expect(sessions.of('d1')[0]).toEqual({ event: 'bridge.status', data: { host: 'online', epoch: 'b:1' } });
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'protocol' }]);
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

describe('A8b: host methods of the epoch', () => {
  it('a method the host did not offer is unknown_method and never reaches the host', async () => {
    host.hostMethodSet = REMOTE_METHODS.filter((m) => m !== 'feed.decide');
    online();
    dispatcher.onOpen('d1');
    call('d1', 'a', 'feed.decide', {});
    call('d1', 'b', 'host.info');
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['host.info']);
    expect(sessions.of('d1').find((f) => f.id === 'a')).toMatchObject({ error: { code: 'unknown_method' } });
    expect(audits[0]).toMatchObject({ kind: 'call-refused', method: 'feed.decide' });
  });

  it('hello lists a method only if the host offers it', () => {
    host.hostMethodSet = REMOTE_METHODS.filter((m) => m !== 'feed.decide');
    online();
    const hello = dispatcher.hello('d1');
    expect(hello.methods).toContain('works.list');
    expect(hello.methods).not.toContain('feed.decide');
    expect(hello.methods).toContain('ping');
  });

  it('hello while the host is not online offers bridge methods only', () => {
    expect(dispatcher.hello('d1').methods).toEqual(['ping', 'client.info', 'push.register']);
  });

  it('a different method set in a new epoch closes every phone with rekey', () => {
    online();
    dispatcher.hello('d1');
    dispatcher.onOpen('d1');
    dispatcher.hello('d2');
    dispatcher.onOpen('d2');
    host.drop('offline');
    host.hostMethodSet = REMOTE_METHODS.filter((m) => m !== 'feed.decide');
    host.connect('b:2');
    host.load(1);
    expect(sessions.closed).toEqual([
      { deviceId: 'd1', reason: 'rekey' },
      { deviceId: 'd2', reason: 'rekey' },
    ]);
  });

  it('the same method set in a new epoch keeps the phones', () => {
    online();
    dispatcher.hello('d1');
    dispatcher.onOpen('d1');
    host.drop('offline');
    host.connect('b:2');
    host.load(1);
    expect(sessions.closed).toEqual([]);
  });

  it('a phone that got hello before the host loaded is rekeyed once the host is online', () => {
    dispatcher.hello('d1'); // хост ещё не подключён: методов хоста в hello нет
    dispatcher.onOpen('d1');
    host.connect('b:1');
    host.load(1);
    expect(sessions.closed).toEqual([{ deviceId: 'd1', reason: 'rekey' }]);
  });

  it('launch methods are mutating: limited and audited with the work or room as target', async () => {
    // A1c: `rooms.send` is a stage A mutating method — it reaches the host, counts against the mutating limit and
    // is audited with the room as target and without the message text.
    expect(REMOTE_METHODS).toContain('rooms.send');
    host.hostMethodSet = [...REMOTE_METHODS];
    online();
    dispatcher.onOpen('d1');
    call('d1', 'a', 'rooms.send', { roomId: 'r-1', kind: 'note', text: 'secret words' });
    await flush();
    expect(host.calls).toEqual([{ method: 'rooms.send', params: { roomId: 'r-1', kind: 'note', text: 'secret words' } }]);
    expect(audits).toEqual([expect.objectContaining({ kind: 'call', method: 'rooms.send', target: 'r-1', outcome: 'ok' })]);
    expect(JSON.stringify(audits)).not.toContain('secret words');
    for (let i = 0; i < 29; i++) {
      call('d1', `m${i}`, 'rooms.send', { roomId: 'r-1', kind: 'note', text: `t${i}` });
      await flush();
    }
    call('d1', 'over', 'rooms.send', { roomId: 'r-1', kind: 'note', text: 'one too many' });
    await flush();
    expect(host.calls.filter((c) => c.method === 'rooms.send')).toHaveLength(30);
    expect(sessions.of('d1').find((f) => f.id === 'over')).toMatchObject({ error: { code: 'rate_limited' } });
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
    host.event('pty.exit', {});
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

describe('A30: feed subscriptions across phones', () => {
  const sub = (deviceId: string, id: string, sessionId = 's-1') => call(deviceId, id, 'feed.subscribe', { ref: ref(sessionId) });
  const unsub = (deviceId: string, id: string, sessionId = 's-1') => call(deviceId, id, 'feed.unsubscribe', { ref: ref(sessionId) });
  const hostCalls = (method: string) => host.calls.filter((c) => c.method === method);
  const delta = (sessionId: string, revision: number) => ({ ref: ref(sessionId), revision, upsert: [], removed: [], mode: null });
  const answer = (deviceId: string, id: string) => sessions.of(deviceId).find((f) => f.id === id);

  beforeEach(() => {
    online();
    dispatcher.onOpen('d1');
    dispatcher.onOpen('d2');
  });

  it('two phones subscribed: the host is subscribed once; one leaves, the subscription stays; the other disconnects, it is removed', async () => {
    sub('d1', 'a');
    await flush();
    sub('d2', 'b');
    await flush();
    expect(hostCalls('feed.subscribe')).toEqual([{ method: 'feed.subscribe', params: { ref: ref('s-1') } }]);
    expect(answer('d1', 'a')).toEqual({ id: 'a', result: { ok: true } });
    expect(answer('d2', 'b')).toEqual({ id: 'b', result: { ok: true } });

    unsub('d1', 'c');
    await flush();
    expect(answer('d1', 'c')).toEqual({ id: 'c', result: { ok: true } });
    expect(hostCalls('feed.unsubscribe')).toEqual([]);
    host.event('feed.changed', delta('s-1', 2));
    expect(events('d1', 'feed.changed')).toEqual([]);
    expect(events('d2', 'feed.changed')).toEqual([{ event: 'feed.changed', data: delta('s-1', 2) }]);

    dispatcher.onClose('d2');
    await flush();
    expect(hostCalls('feed.unsubscribe')).toEqual([{ method: 'feed.unsubscribe', params: { ref: ref('s-1') } }]);
  });

  it('feed.changed goes only to phones subscribed to that ref; consents.changed goes to every phone', async () => {
    sub('d1', 'a', 's-1');
    sub('d2', 'b', 's-2');
    await flush();
    host.event('feed.changed', delta('s-1', 5));
    host.event('feed.changed', delta('s-3', 1));
    host.event('consents.changed', { upsert: [], removed: ['c-1'] });
    expect(events('d1', 'feed.changed').map((f) => f.data.ref.sessionId)).toEqual(['s-1']);
    expect(events('d2', 'feed.changed')).toEqual([]);
    expect(events('d1', 'consents.changed')).toHaveLength(1);
    expect(events('d2', 'consents.changed')).toHaveLength(1);
  });

  it('race: phones subscribing while the first host subscribe is in flight join it (one host call, all answered after it)', async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    host.handler = () => new Promise((r) => resolvers.push(r));
    sub('d1', 'a');
    sub('d2', 'b');
    sub('d1', 'a2');
    await flush();
    expect(hostCalls('feed.subscribe')).toHaveLength(1);
    expect(answer('d1', 'a')).toBeUndefined();
    expect(answer('d2', 'b')).toBeUndefined();
    resolvers[0]!({ ok: true });
    await flush();
    expect(answer('d1', 'a')).toEqual({ id: 'a', result: { ok: true } });
    expect(answer('d1', 'a2')).toEqual({ id: 'a2', result: { ok: true } });
    expect(answer('d2', 'b')).toEqual({ id: 'b', result: { ok: true } });
    expect(hostCalls('feed.subscribe')).toHaveLength(1);
    // The duplicate subscribe of d1 is idempotent: one unsubscribe per phone frees the ref.
    unsub('d1', 'u1');
    unsub('d2', 'u2');
    await flush();
    expect(hostCalls('feed.unsubscribe')).toHaveLength(1);
  });

  it('race: unsubscribe while the host subscribe is in flight ends unsubscribed at the host', async () => {
    let resolve!: (v: unknown) => void;
    host.handler = (method) => (method === 'feed.subscribe' ? new Promise((r) => (resolve = r)) : Promise.resolve({ ok: true }));
    sub('d1', 'a');
    await flush();
    unsub('d1', 'b');
    await flush();
    expect(hostCalls('feed.unsubscribe')).toEqual([]);
    resolve({ ok: true });
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['feed.subscribe', 'feed.unsubscribe']);
    host.event('feed.changed', delta('s-1', 2));
    expect(events('d1', 'feed.changed')).toEqual([]);
  });

  it('race: subscribe while the host unsubscribe is in flight subscribes again after it', async () => {
    sub('d1', 'a');
    await flush();
    let resolve!: (v: unknown) => void;
    host.handler = (method) => (method === 'feed.unsubscribe' ? new Promise((r) => (resolve = r)) : Promise.resolve({ ok: true }));
    unsub('d1', 'b');
    await flush();
    sub('d2', 'c');
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['feed.subscribe', 'feed.unsubscribe']);
    expect(answer('d2', 'c')).toBeUndefined();
    resolve({ ok: true });
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['feed.subscribe', 'feed.unsubscribe', 'feed.subscribe']);
    expect(answer('d2', 'c')).toEqual({ id: 'c', result: { ok: true } });
    host.event('feed.changed', delta('s-1', 3));
    expect(events('d2', 'feed.changed')).toHaveLength(1);
  });

  it('race: a phone that disconnects while its subscribe is in flight leaves no host subscription behind', async () => {
    let resolve!: (v: unknown) => void;
    host.handler = (method) => (method === 'feed.subscribe' ? new Promise((r) => (resolve = r)) : Promise.resolve({ ok: true }));
    sub('d1', 'a');
    await flush();
    dispatcher.onClose('d1');
    resolve({ ok: true });
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['feed.subscribe', 'feed.unsubscribe']);
  });

  it('a new epoch re-subscribes once per ref for the live subscribed phones only', async () => {
    sub('d1', 'a', 's-1');
    sub('d2', 'b', 's-1');
    sub('d2', 'c', 's-2');
    await flush();
    dispatcher.onClose('d2');
    await flush();
    host.drop();
    host.calls = [];
    host.connect('b:2');
    host.load(1);
    await flush();
    // s-1 still has d1; s-2 lost its only phone before the drop.
    expect(host.calls).toEqual([{ method: 'feed.subscribe', params: { ref: ref('s-1') } }]);
    host.event('feed.changed', delta('s-1', 1));
    expect(events('d1', 'feed.changed')).toHaveLength(1);
    // The phone re-subscribing on resync is idempotent: no second host call in this epoch.
    sub('d1', 'r', 's-1');
    await flush();
    expect(hostCalls('feed.subscribe')).toHaveLength(1);
    expect(answer('d1', 'r')).toEqual({ id: 'r', result: { ok: true } });
    // The last unsubscribe in the new epoch reaches the new connection.
    unsub('d1', 'u', 's-1');
    await flush();
    expect(hostCalls('feed.unsubscribe')).toHaveLength(1);
  });

  it('unsubscribe while the host is away is kept: no host call for the dead subscription, no re-subscribe in the new epoch', async () => {
    sub('d1', 'a');
    await flush();
    host.drop();
    unsub('d1', 'b');
    await flush();
    expect(answer('d1', 'b')).toEqual({ id: 'b', result: { ok: true } });
    host.connect('b:2');
    host.load(1);
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['feed.subscribe']);
  });

  it('a re-subscribe the host refuses in the new epoch drops the subscribers', async () => {
    sub('d1', 'a');
    await flush();
    host.drop();
    host.handler = async () => {
      throw new HostCallError('not_found', 'no session');
    };
    host.connect('b:2');
    host.load(1);
    await flush();
    host.event('feed.changed', delta('s-1', 1));
    expect(events('d1', 'feed.changed')).toEqual([]);
    host.handler = async () => ({ ok: true });
    sub('d1', 'b');
    await flush();
    expect(hostCalls('feed.subscribe')).toHaveLength(3);
  });

  it('a host error on subscribe reaches the phone and leaves it unsubscribed; the next subscribe asks the host again', async () => {
    host.handler = async () => {
      throw new HostCallError('not_found', 'no session s-9');
    };
    sub('d1', 'a', 's-9');
    await flush();
    expect(answer('d1', 'a')).toMatchObject({ error: { code: 'not_found' } });
    host.event('feed.changed', delta('s-9', 1));
    expect(events('d1', 'feed.changed')).toEqual([]);
    host.handler = async () => ({ ok: true });
    sub('d1', 'b', 's-9');
    await flush();
    expect(hostCalls('feed.subscribe')).toHaveLength(2);
    expect(answer('d1', 'b')).toEqual({ id: 'b', result: { ok: true } });
  });

  it('a malformed ref is bad_request and never reaches the host', async () => {
    call('d1', 'a', 'feed.subscribe', { ref: { projectPath: '/p', workId: 1, sessionId: 's-1' } });
    call('d1', 'b', 'feed.subscribe', {});
    await flush();
    expect(host.calls).toEqual([]);
    expect(answer('d1', 'a')).toMatchObject({ error: { code: 'bad_request' } });
    expect(answer('d1', 'b')).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('the snapshot is per phone: each feed.snapshot is its own host call and answer', async () => {
    let n = 0;
    host.handler = async () => ({ items: [], revision: ++n, schemaVersion: 1, mode: null });
    call('d1', 'a', 'feed.snapshot', { ref: ref('s-1') });
    call('d2', 'b', 'feed.snapshot', { ref: ref('s-1') });
    await flush();
    expect(hostCalls('feed.snapshot')).toHaveLength(2);
    expect(answer('d1', 'a')?.result.revision).not.toBe(answer('d2', 'b')?.result.revision);
  });
});

describe('A30: pty.send without duplicates', () => {
  const params = (clientMsgId: string, text = 'hello agent') => ({ ref: ref('s-1'), text, submit: true, clientMsgId });
  const send = (deviceId: string, id: string, clientMsgId: string, text?: string) => call(deviceId, id, 'pty.send', params(clientMsgId, text));
  const sends = () => host.calls.filter((c) => c.method === 'pty.send');
  const answer = (deviceId: string, id: string) => sessions.of(deviceId).find((f) => f.id === id);

  beforeEach(() => {
    online();
    dispatcher.onOpen('d1');
  });

  it('a repeat with the same clientMsgId gets the same answer without a second host call; params reach the host unchanged', async () => {
    host.handler = async () => ({ ok: true, queued: false });
    send('d1', 'a', 'msg-00000001');
    await flush();
    send('d1', 'b', 'msg-00000001');
    await flush();
    expect(sends()).toEqual([{ method: 'pty.send', params: params('msg-00000001') }]);
    expect(answer('d1', 'a')).toEqual({ id: 'a', result: { ok: true, queued: false } });
    expect(answer('d1', 'b')).toEqual({ id: 'b', result: { ok: true, queued: false } });
  });

  it('race: a repeat that arrives while the first call is in flight joins it', async () => {
    let resolve!: (v: unknown) => void;
    host.handler = () => new Promise((r) => (resolve = r));
    send('d1', 'a', 'msg-00000002');
    send('d1', 'b', 'msg-00000002');
    await flush();
    send('d1', 'c', 'msg-00000002');
    await flush();
    expect(sends()).toHaveLength(1);
    resolve({ ok: true });
    await flush();
    for (const id of ['a', 'b', 'c']) expect(answer('d1', id)).toEqual({ id, result: { ok: true } });
    expect(sends()).toHaveLength(1);
  });

  it('race: the phone loses its session mid-call and repeats on the new one: one host call, the answer reaches the new session', async () => {
    let resolve!: (v: unknown) => void;
    host.handler = () => new Promise((r) => (resolve = r));
    send('d1', 'a', 'msg-00000003');
    await flush();
    dispatcher.onClose('d1');
    sessions.frames.delete('d1');
    dispatcher.onOpen('d1');
    send('d1', 'b', 'msg-00000003');
    await flush();
    resolve({ ok: true });
    await flush();
    expect(sends()).toHaveLength(1);
    // The old session's answer never reaches the new session (critic M1).
    expect(answer('d1', 'a')).toBeUndefined();
    expect(answer('d1', 'b')).toEqual({ id: 'b', result: { ok: true } });
    // After the call finished, a later repeat on yet another session still gets the cached answer.
    dispatcher.onClose('d1');
    dispatcher.onOpen('d1');
    send('d1', 'c', 'msg-00000003');
    await flush();
    expect(sends()).toHaveLength(1);
    expect(answer('d1', 'c')).toEqual({ id: 'c', result: { ok: true } });
  });

  it('a host error is cached too (delivery unknown after a timeout): the repeat gets it, the host is not called again', async () => {
    host.handler = async () => {
      throw new HostCallError('timeout');
    };
    send('d1', 'a', 'msg-00000004');
    await flush();
    host.handler = async () => ({ ok: true });
    send('d1', 'b', 'msg-00000004');
    await flush();
    expect(sends()).toHaveLength(1);
    expect(answer('d1', 'b')).toEqual({ id: 'b', error: { code: 'timeout', message: 'timeout' } });
  });

  it('a refusal before the host (host offline) is not cached: the repeat reaches the host once it is online', async () => {
    host.drop();
    send('d1', 'a', 'msg-00000005');
    await flush();
    expect(answer('d1', 'a')).toMatchObject({ error: { code: 'host_offline' } });
    host.connect('b:2');
    host.load(1);
    send('d1', 'b', 'msg-00000005');
    await flush();
    expect(sends()).toHaveLength(1);
    expect(answer('d1', 'b')).toEqual({ id: 'b', result: { ok: true } });
  });

  it('the key is per device and per clientMsgId; it expires after 10 minutes', async () => {
    dispatcher.onOpen('d2');
    send('d1', 'a', 'msg-00000006');
    send('d2', 'b', 'msg-00000006');
    send('d1', 'c', 'msg-00000007');
    await flush();
    expect(sends()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    send('d1', 'd', 'msg-00000006');
    await flush();
    expect(sends()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    send('d1', 'e', 'msg-00000006');
    await flush();
    expect(sends()).toHaveLength(4);
  });

  it('pty.send is mutating: 30 per minute, repeats do not spend the limit; audited with the session as target, text only as length and hash', async () => {
    for (let i = 0; i < 30; i++) {
      send('d1', `m${i}`, `msg-limit-${String(i).padStart(3, '0')}`, `secret words ${i}`);
      await flush();
    }
    send('d1', 'repeat', 'msg-limit-000', 'secret words 0');
    send('d1', 'over', 'msg-limit-999', 'one too many');
    await flush();
    expect(sends()).toHaveLength(30);
    expect(answer('d1', 'repeat')).toEqual({ id: 'repeat', result: { ok: true } });
    expect(answer('d1', 'over')).toMatchObject({ error: { code: 'rate_limited' } });
    const calls = audits.filter((a) => a.kind === 'call');
    expect(calls).toHaveLength(30);
    expect(calls[0]).toMatchObject({ method: 'pty.send', target: 's-1', outcome: 'ok' });
    expect(JSON.stringify(audits)).not.toContain('secret words');
    // The refused one was never sent: a later retry with the same key after the window goes to the host.
    await vi.advanceTimersByTimeAsync(60_000);
    send('d1', 'retry', 'msg-limit-999', 'one too many');
    await flush();
    expect(sends()).toHaveLength(31);
  });

  it('critic M1: a late host answer of the previous session never reaches the new session under the same id', async () => {
    const pending: ((v: unknown) => void)[] = [];
    host.handler = (method) => (method === 'pty.send' ? new Promise((r) => pending.push(r)) : Promise.resolve({ from: 'new session' }));
    send('d1', '1', 'msg-00000010');
    send('d1', '2', 'msg-00000010');
    await flush();
    dispatcher.onClose('d1');
    sessions.frames.delete('d1');
    dispatcher.onOpen('d1');
    // The new connection restarts its id counter: its "1" and "2" are different requests.
    call('d1', '1', 'host.info');
    await flush();
    pending[0]!({ from: 'old session' });
    await flush();
    call('d1', '2', 'host.info');
    await flush();
    expect(sessions.of('d1').filter((f) => f.id === '1')).toEqual([{ id: '1', result: { from: 'new session' } }]);
    expect(sessions.of('d1').filter((f) => f.id === '2')).toEqual([{ id: '2', result: { from: 'new session' } }]);
    expect(JSON.stringify(sessions.of('d1'))).not.toContain('old session');
  });

  it('critic m1: the same clientMsgId with another message is bad_request, not a repeat', async () => {
    send('d1', 'a', 'msg-00000011', 'first text');
    await flush();
    send('d1', 'b', 'msg-00000011', 'other text');
    call('d1', 'c', 'pty.send', { ref: ref('s-2'), text: 'first text', submit: true, clientMsgId: 'msg-00000011' });
    call('d1', 'd', 'pty.send', { ref: ref('s-1'), text: 'first text', submit: false, clientMsgId: 'msg-00000011' });
    // A different requestedAt is still a repeat.
    call('d1', 'e', 'pty.send', { ref: ref('s-1'), text: 'first text', submit: true, clientMsgId: 'msg-00000011', requestedAt: 5 });
    await flush();
    expect(sends()).toHaveLength(1);
    for (const id of ['b', 'c', 'd']) expect(answer('d1', id)).toMatchObject({ error: { code: 'bad_request' } });
    expect(answer('d1', 'e')).toEqual({ id: 'e', result: { ok: true } });
  });

  it('critic m2: a precise host refusal is not cached (in-flight repeats share it, a later repeat reaches the host)', async () => {
    let reject!: (e: Error) => void;
    host.handler = () => new Promise((_, r) => (reject = r));
    send('d1', 'a', 'msg-00000012');
    send('d1', 'b', 'msg-00000012');
    await flush();
    reject(new HostCallError('not_found', 'session is not running'));
    await flush();
    expect(answer('d1', 'a')).toMatchObject({ error: { code: 'not_found' } });
    expect(answer('d1', 'b')).toMatchObject({ error: { code: 'not_found' } });
    host.handler = async () => ({ ok: true });
    send('d1', 'c', 'msg-00000012');
    await flush();
    expect(sends()).toHaveLength(2);
    expect(answer('d1', 'c')).toEqual({ id: 'c', result: { ok: true } });
  });

  it('critic m3: repeats waiting on an in-flight call count in MAX_IN_FLIGHT', async () => {
    let resolve!: (v: unknown) => void;
    host.handler = () => new Promise((r) => (resolve = r));
    send('d1', 'first', 'msg-00000013');
    for (let i = 0; i < 15; i++) send('d1', `r${i}`, 'msg-00000013');
    send('d1', 'over', 'msg-00000013');
    await flush();
    expect(answer('d1', 'over')).toMatchObject({ error: { code: 'rate_limited' } });
    resolve({ ok: true });
    await flush();
    expect(sends()).toHaveLength(1);
    for (let i = 0; i < 15; i++) expect(answer('d1', `r${i}`)).toEqual({ id: `r${i}`, result: { ok: true } });
  });

  it('critic m4: the mutating limit window survives a reconnect', async () => {
    for (let i = 0; i < 30; i++) {
      send('d1', `m${i}`, `msg-recon-${String(i).padStart(3, '0')}`);
      await flush();
    }
    dispatcher.onClose('d1');
    dispatcher.onOpen('d1');
    send('d1', 'over', 'msg-recon-999');
    await flush();
    expect(sends()).toHaveLength(30);
    expect(answer('d1', 'over')).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('pty.send without clientMsgId is bad_request before the host', async () => {
    call('d1', 'a', 'pty.send', { ref: ref('s-1'), text: 'x', submit: true });
    await flush();
    expect(sends()).toEqual([]);
    expect(answer('d1', 'a')).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('consents.decide is mutating: audited with the card as target and limited', async () => {
    call('d1', 'a', 'consents.decide', { id: 'c-1', decision: 'allow' });
    await flush();
    expect(audits).toEqual([expect.objectContaining({ kind: 'call', method: 'consents.decide', target: 'c-1', outcome: 'ok' })]);
    for (let i = 0; i < 29; i++) {
      call('d1', `m${i}`, 'consents.decide', { id: `c-${i + 2}`, decision: 'deny' });
      await flush();
    }
    call('d1', 'over', 'consents.decide', { id: 'c-99', decision: 'deny' });
    await flush();
    expect(host.calls.filter((c) => c.method === 'consents.decide')).toHaveLength(30);
    expect(answer('d1', 'over')).toMatchObject({ error: { code: 'rate_limited' } });
  });
});

describe('A34: phone.action for weighty phone actions', () => {
  // `phone.action` carries a real device id (16 bytes b64url).
  const D = 'AAAAAAAAAAAAAAAAAAAAAA';
  const create = (extra: Record<string, unknown> = {}) => ({ projectPath: '/p', workId: 'w-1', provider: 'claude', label: 'L', task: 'SECRET TASK', parent: null, ...extra });
  const answer = (id: string) => sessions.of(D).find((f) => f.id === id);

  beforeEach(() => {
    online();
    dispatcher.onOpen(D);
  });

  /** Host stub: `trust.check` reads a flag that `sessions.create` with `trustFolder` sets, as the real host does before the launch. */
  function trustingHost(opts: { trusted?: boolean; fail?: boolean } = {}) {
    let trusted = opts.trusted ?? false;
    host.handler = async (method, params) => {
      if (method === 'trust.check') return { trusted };
      if (method === 'sessions.create') {
        if ((params as { trustFolder?: boolean }).trustFolder === true) trusted = true;
        if (opts.fail) throw new HostCallError('conflict', 'launch failed');
        return { ref: ref('s-9') };
      }
      return { ok: true };
    };
  }

  it('sessions.create: session-create with the new ref; with trustFolder also trust-folder with the realpath', async () => {
    vi.useRealTimers();
    const real = mkdtempSync(join(tmpdir(), 'a34-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      trustingHost();
      call(D, 'a', 'sessions.create', create());
      await vi.waitFor(() => expect(answer('a')).toBeDefined());
      call(D, 'b', 'sessions.create', create({ projectPath: link, trustFolder: true }));
      await vi.waitFor(() => expect(actions).toHaveLength(3));
      expect(actions).toEqual([
        { deviceId: D, kind: 'session-create', target: ref('s-9') },
        { deviceId: D, kind: 'trust-folder', target: realpathSync(link) },
        { deviceId: D, kind: 'session-create', target: ref('s-9') },
      ]);
      expect(JSON.stringify(actions)).not.toContain('SECRET');
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('N3: trust-folder is sent when the launch fails after the trust was written, and only then', async () => {
    vi.useRealTimers();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    trustingHost({ fail: true });
    call(D, 'a', 'sessions.create', create({ trustFolder: true }));
    await vi.waitFor(() => expect(actions).toEqual([{ deviceId: D, kind: 'trust-folder', target: '/p' }]));
    await settle();
    expect(actions).toHaveLength(1);
    actions.length = 0;
    // Already trusted before the call: nothing was written by the phone.
    trustingHost({ trusted: true });
    call(D, 'b', 'sessions.create', create({ trustFolder: true }));
    await vi.waitFor(() => expect(actions.map((e) => e.kind)).toEqual(['session-create']));
    await settle();
    expect(actions).toHaveLength(1);
    actions.length = 0;
    // The host refused before writing anything (trust.check stays false).
    host.handler = async (method) => {
      if (method === 'trust.check') return { trusted: false };
      throw new HostCallError('forbidden', 'no');
    };
    call(D, 'c', 'sessions.create', create({ trustFolder: true }));
    await settle();
    expect(actions).toEqual([]);
  });

  it('consents.decide allow: trust-folder for a folder-trust card, provider-switch for an agent-switch card; deny and applied:false emit nothing', async () => {
    host.event('consents.changed', {
      upsert: [
        { id: 'c-1', kind: 'folder-trust', projectPath: '/p', folder: '/private/p', at: 'a', state: 'pending', requestedBy: { source: 'launch' } },
        { id: 'c-2', kind: 'agent-switch', projectPath: '/p', ref: ref('s-1'), provider: 'codex', providerLabel: 'Codex', model: null, reason: 'SECRET REASON', at: 'a', state: 'pending', requestedBy: { sessionId: 's-1', label: 'l' } },
        { id: 'c-3', kind: 'folder-trust', projectPath: '/p', folder: '/private/q', at: 'a', state: 'pending', requestedBy: { source: 'launch' } },
      ],
      removed: [],
    });
    host.handler = async (method, params) => ({ applied: (params as { id: string }).id !== 'c-3', state: 'allowed' });
    call(D, 'a', 'consents.decide', { id: 'c-1', decision: 'allow' });
    call(D, 'b', 'consents.decide', { id: 'c-2', decision: 'allow' });
    call(D, 'c', 'consents.decide', { id: 'c-1', decision: 'deny' });
    call(D, 'd', 'consents.decide', { id: 'c-3', decision: 'allow' });
    await flush();
    expect(actions).toEqual([
      { deviceId: D, kind: 'trust-folder', target: '/private/p' },
      { deviceId: D, kind: 'provider-switch', target: 'Codex' },
    ]);
    expect(host.calls.map((c) => c.method)).toEqual(['consents.decide', 'consents.decide', 'consents.decide', 'consents.decide']);
  });

  it('consents.decide allow on a card the bridge has not seen: one consents.list before the decision tells its kind', async () => {
    host.handler = async (method) =>
      method === 'consents.list'
        ? { items: [{ id: 'c-5', kind: 'folder-trust', projectPath: '/p', folder: '/private/r', at: 'a', state: 'pending', requestedBy: { source: 'agent' } }] }
        : { applied: true, state: 'allowed' };
    call(D, 'a', 'consents.decide', { id: 'c-5', decision: 'allow' });
    await flush();
    expect(host.calls.map((c) => c.method)).toEqual(['consents.list', 'consents.decide']);
    expect(actions).toEqual([{ deviceId: D, kind: 'trust-folder', target: '/private/r' }]);
  });

  it('A36a: consents.decide allow on a project-mcp card emits mcp-enable with the repo and names only; deny, empty allow and a stale pair emit nothing', async () => {
    const fp = (c: string) => c.repeat(64);
    const mcpCard = (id: string) => ({
      id,
      kind: 'project-mcp',
      version: 1,
      projectPath: '/p',
      repo: '/private/repo',
      servers: [
        { name: 'github', fingerprint: fp('a'), command: 'npx SECRET-CMD' },
        { name: 'files', fingerprint: fp('b'), command: 'node files.js' },
      ],
      at: 'a',
      state: 'pending',
      requestedBy: { source: 'launch' },
    });
    host.event('consents.changed', { upsert: ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'].map(mcpCard), removed: [] });
    host.handler = async (method, params) => {
      const enabled = (params as { enabled?: { fingerprint: string }[] }).enabled ?? [];
      if (enabled.some((pair) => pair.fingerprint === fp('c'))) throw new HostCallError('bad_request', 'Unknown or changed MCP server in the decision');
      return { applied: true, state: (params as { decision: string }).decision === 'allow' ? 'allowed' : 'denied' };
    };
    call(D, 'a', 'consents.decide', { id: 'c-1', decision: 'allow', revision: 2, enabled: [{ name: 'github', fingerprint: fp('a') }, { name: 'files', fingerprint: fp('b') }] });
    call(D, 'b', 'consents.decide', { id: 'c-2', decision: 'allow', enabled: [] });
    call(D, 'c', 'consents.decide', { id: 'c-3', decision: 'allow' });
    call(D, 'd', 'consents.decide', { id: 'c-4', decision: 'deny', revision: 1 });
    call(D, 'e', 'consents.decide', { id: 'c-5', decision: 'allow', enabled: [{ name: 'github', fingerprint: fp('c') }] });
    await flush();
    expect(actions).toEqual([{ deviceId: D, kind: 'mcp-enable', target: { repo: '/private/repo', servers: ['github', 'files'] } }]);
    expect(JSON.stringify(actions)).not.toMatch(/SECRET|aaaa|node/);
    // The host passes `enabled` through and its bad_request on a stale pair reaches the phone unchanged.
    expect(host.calls.find((c) => (c.params as { id: string }).id === 'c-1')?.params).toEqual({
      id: 'c-1',
      decision: 'allow',
      revision: 2,
      enabled: [{ name: 'github', fingerprint: fp('a') }, { name: 'files', fingerprint: fp('b') }],
    });
    expect(answer('e')).toEqual({ id: 'e', error: { code: 'bad_request', message: 'Unknown or changed MCP server in the decision' } });
  });

  it('A36a: malformed enabled pairs are bad_request before the host', async () => {
    const fp = 'a'.repeat(64);
    call(D, 'a', 'consents.decide', { id: 'c-1', decision: 'deny', enabled: [{ name: 'github', fingerprint: fp }] });
    call(D, 'b', 'consents.decide', { id: 'c-1', decision: 'allow', enabled: [{ name: 'github', fingerprint: fp, command: 'x' }] });
    call(D, 'c', 'consents.decide', { id: 'c-1', decision: 'allow', enabled: [{ name: 'github', fingerprint: 'not-hex' }] });
    call(D, 'd', 'consents.decide', { id: 'c-1', decision: 'allow', enabled: Array.from({ length: 201 }, (_, i) => ({ name: `s${i}`, fingerprint: fp })) });
    await flush();
    for (const id of ['a', 'b', 'c', 'd']) expect(answer(id)).toMatchObject({ error: { code: 'bad_request' } });
    expect(host.calls).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('feed.decide: allow-always and plan auto-accept are weighty; plain Allow, deny, manual plan and answers are not', async () => {
    host.handler = async () => ({ applied: true, state: 'allowed' });
    const decide = (id: string, decision: unknown) => call(D, id, 'feed.decide', { ref: ref('s-1'), cardId: 'k', decision });
    decide('a', { kind: 'permission', behavior: 'allow', always: true });
    decide('b', { kind: 'permission', behavior: 'allow' });
    decide('c', { kind: 'permission', behavior: 'deny', message: 'SECRET' });
    decide('d', { kind: 'plan', choice: 'auto-accept' });
    decide('e', { kind: 'plan', choice: 'manual' });
    decide('f', { kind: 'question', answers: { q: 'SECRET' } });
    await flush();
    expect(actions).toEqual([
      { deviceId: D, kind: 'allow-always', target: ref('s-1') },
      { deviceId: D, kind: 'plan-auto-accept', target: ref('s-1') },
    ]);
    host.handler = async () => ({ applied: false, state: 'allowed' });
    decide('g', { kind: 'permission', behavior: 'allow', always: true });
    await flush();
    expect(actions).toHaveLength(2);
  });

  it('messages, room letters, rooms.create, reads and failed calls emit nothing', async () => {
    host.handler = async (method) => {
      if (method === 'sessions.create') throw new HostCallError('bad_request', 'no');
      return { ok: true };
    };
    call(D, 'a', 'pty.send', { ref: ref('s-1'), text: 'SECRET', submit: true, clientMsgId: 'msg-00000099' });
    call(D, 'b', 'rooms.send', { roomId: 'r-1', kind: 'note', text: 'SECRET' });
    call(D, 'c', 'rooms.create', { projectPath: '/p', workId: 'w-1', title: 'T', members: ['s-1'] });
    call(D, 'd', 'rooms.resolveProposal', { id: 'p', rev: 1 });
    call(D, 'e', 'host.info');
    call(D, 'f', 'sessions.create', create({ trustFolder: true }));
    await flush();
    expect(host.calls.filter((c) => c.method !== 'trust.check')).toHaveLength(6);
    expect(actions).toEqual([]);
  });

  it('A37a: sessions.resume is mutating: audited with the session as target, limited, no phone.action; a bad ref is bad_request before the host', async () => {
    call(D, 'bad', 'sessions.resume', { ref: { ...ref('s-1'), sessionId: '' } });
    await flush();
    expect(answer('bad')).toMatchObject({ error: { code: 'bad_request' } });
    expect(host.calls.filter((c) => c.method === 'sessions.resume')).toEqual([]);
    call(D, 'a', 'sessions.resume', { ref: ref('s-1') });
    await flush();
    expect(answer('a')).toMatchObject({ result: { ok: true } });
    expect(host.calls.filter((c) => c.method === 'sessions.resume')).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({ kind: 'call-refused', method: 'sessions.resume', outcome: 'bad_request' }),
      expect.objectContaining({ kind: 'call', method: 'sessions.resume', deviceId: D, target: 's-1', outcome: 'ok', detail: expect.stringMatching(/^workId=w-1 project:sha256=[0-9a-f]{12}$/) }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('"/p"');
    for (let i = 0; i < 29; i++) {
      call(D, `m${i}`, 'sessions.resume', { ref: ref('s-1') });
      await flush();
    }
    call(D, 'over', 'sessions.resume', { ref: ref('s-1') });
    await flush();
    expect(host.calls.filter((c) => c.method === 'sessions.resume')).toHaveLength(30);
    expect(answer('over')).toMatchObject({ error: { code: 'rate_limited' } });
    expect(actions).toEqual([]);
  });

  it('critic A37a m3: ref-based calls write workId and a projectPath hash into the audit detail; the path itself is not written', async () => {
    call(D, 'a', 'pty.send', { ref: { projectPath: '/Users/a/secret-repo', workId: 'w-2', sessionId: 's-1' }, text: 'SECRET', submit: true, clientMsgId: 'msg-00000777' });
    call(D, 'b', 'sessions.resume', { ref: { projectPath: '/Users/a/other', workId: 'w-2', sessionId: 's-1' } });
    await flush();
    const [send, resume] = audits.filter((a) => a.kind === 'call');
    expect(send).toMatchObject({ method: 'pty.send', target: 's-1', detail: expect.stringMatching(/^workId=w-2 project:sha256=[0-9a-f]{12} /) });
    expect(resume).toMatchObject({ method: 'sessions.resume', target: 's-1', detail: expect.stringMatching(/^workId=w-2 project:sha256=[0-9a-f]{12}$/) });
    expect(send?.detail?.split(' ')[1]).not.toBe(resume?.detail?.split(' ')[1]);
    expect(JSON.stringify(audits)).not.toContain('secret-repo');
    expect(JSON.stringify(audits)).not.toContain('SECRET');
  });

  it('A38a: session-close and provider-switch only after a successful close and switchAgent; Stop and sleep emit nothing', async () => {
    const uuid = '0b6e5d3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    host.handler = async (method, params) => {
      const p = params as { ref?: { sessionId?: string }; provider?: string };
      if (method === 'sessions.close' && p.ref?.sessionId === 's-8') throw new HostCallError('conflict', 'no');
      if (method === 'sessions.switchAgent' && p.provider === 'broken') throw new HostCallError('conflict', 'blocked');
      if (method === 'sessions.switchOptions') {
        return { current: { provider: 'claude', available: true, reason: null }, targets: [{ id: 'codex', label: 'Codex', family: null, available: true, needs: null, limits: null, transcript: true }], suggested: 'codex', keeps: { rooms: 0, leads: [], owns: [], children: 0, unread: 0, worktree: null }, blockers: [] };
      }
      if (method === 'providers.list') return { providers: [{ id: 'gemini', label: 'Gemini CLI', available: true }] };
      if (method === 'sessions.switchAgent') {
        const outcome = p.provider === 'held-one' ? 'held' : p.provider === 'queued-one' ? 'queued' : 'started';
        return { outcome, carried: 'handover' };
      }
      return { ok: true };
    };
    call(D, 'a', 'feed.interrupt', { ref: ref('s-1') });
    call(D, 'b', 'sessions.stop', { ref: ref('s-1') });
    call(D, 'c', 'sessions.close', { ref: ref('s-1') });
    call(D, 'd', 'sessions.close', { ref: ref('s-9') });
    call(D, 'e', 'sessions.close', { ref: ref('s-8') });
    await flush();
    call(D, 'f', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'codex' });
    await flush();
    call(D, 'g', 'sessions.switchOptions', { ref: ref('s-1') });
    await flush();
    call(D, 'h', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'codex' });
    call(D, 'i', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'broken' });
    call(D, 'j', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'codex', force: true });
    await flush();
    call(D, 'k', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'gemini' });
    await flush();
    // Критик A38a m7: `held` (согласие) и `queued` (слот машины) — замена уже записана, событие есть.
    call(D, 'l', 'sessions.switchAgent', { ref: ref('s-1'), requestId: uuid, provider: 'held-one' });
    call(D, 'm', 'sessions.switchAgent', { ref: ref('s-9'), requestId: uuid, provider: 'queued-one' });
    await flush();
    expect(answer('j')).toMatchObject({ error: { code: 'bad_request' } });
    expect(answer('l')).toMatchObject({ result: { outcome: 'held' } });
    expect(answer('m')).toMatchObject({ result: { outcome: 'queued' } });
    const moved = (sessionId: string, label: string, provider: string) => ({ ...ref(sessionId), label, provider });
    expect(actions).toEqual([
      { deviceId: D, kind: 'session-close', target: { ...ref('s-1'), label: 'l' } },
      // Сессии нет в снимке — её номер вместо имени.
      { deviceId: D, kind: 'session-close', target: { ...ref('s-9'), label: 's-9' } },
      // Имя провайдера — только из известных (switchOptions, providers.list); сырой параметр не идёт (критик A38a m3).
      { deviceId: D, kind: 'provider-switch', target: moved('s-1', 'l', 'another provider') },
      { deviceId: D, kind: 'provider-switch', target: moved('s-1', 'l', 'Codex') },
      { deviceId: D, kind: 'provider-switch', target: moved('s-1', 'l', 'Gemini CLI') },
      { deviceId: D, kind: 'provider-switch', target: moved('s-1', 'l', 'another provider') },
      { deviceId: D, kind: 'provider-switch', target: moved('s-9', 's-9', 'another provider') },
    ]);
    expect(JSON.stringify(actions)).not.toContain('held-one');
    expect(JSON.stringify(actions)).not.toContain('SECRET');
    // Журнал: четыре изменяющих метода — `call`, switchOptions — чтение, без записи.
    const calls = audits.filter((a) => a.kind === 'call');
    expect(calls.map((a) => a.method)).toEqual([
      'feed.interrupt', 'sessions.stop', 'sessions.close', 'sessions.close', 'sessions.close',
      'sessions.switchAgent', 'sessions.switchAgent', 'sessions.switchAgent', 'sessions.switchAgent', 'sessions.switchAgent', 'sessions.switchAgent',
    ]);
    expect(calls[0]).toMatchObject({ target: 's-1', outcome: 'ok' });
    expect(calls[4]).toMatchObject({ target: 's-8', outcome: 'conflict' });
    expect(audits.some((a) => a.method === 'sessions.switchOptions')).toBe(false);
  });

  it('A41a: room-archive and room-delete only after a successful call, with the room title from the snapshot taken before it', async () => {
    (host.snapshot!.entries[0]!.map as any).rooms = [{ id: 'r-1', title: 'Design review' }];
    host.handler = async (method, params) => {
      const p = params as { roomId?: string };
      if (p.roomId === 'r-8') throw new HostCallError('conflict', 'the work is archived');
      // The room disappears with the call: the label must come from the snapshot read before it.
      if (method === 'rooms.delete') (host.snapshot!.entries[0]!.map as any).rooms = [];
      return { ok: true };
    };
    const room = (roomId: string) => ({ projectPath: '/p', workId: 'w-1', roomId });
    call(D, 'a', 'rooms.archive', { ...room('r-1'), stopSessions: true });
    call(D, 'b', 'rooms.archive', { ...room('r-9'), stopSessions: false });
    call(D, 'c', 'rooms.archive', { ...room('r-8'), stopSessions: false });
    await flush();
    call(D, 'd', 'rooms.delete', room('r-1'));
    call(D, 'e', 'rooms.delete', room('r-8'));
    // Refused by the rule, never reaches the host: no event, no host call.
    call(D, 'f', 'rooms.delete', { ...room('r-1'), stopSessions: true });
    call(D, 'g', 'rooms.archive', room('r-1'));
    await flush();
    expect(answer('c')).toMatchObject({ error: { code: 'conflict' } });
    expect(answer('f')).toMatchObject({ error: { code: 'bad_request' } });
    expect(answer('g')).toMatchObject({ error: { code: 'bad_request' } });
    const target = (roomId: string, label: string) => ({ ...room(roomId), label });
    expect(actions).toEqual([
      { deviceId: D, kind: 'room-archive', target: target('r-1', 'Design review') },
      // Not in the snapshot: its number instead of a title.
      { deviceId: D, kind: 'room-archive', target: target('r-9', 'r-9') },
      { deviceId: D, kind: 'room-delete', target: target('r-1', 'Design review') },
    ]);
    expect(host.calls.map((c) => c.method)).toEqual(['rooms.archive', 'rooms.archive', 'rooms.archive', 'rooms.delete', 'rooms.delete']);
    // Mutating: each one is audited as `call`, with the room, work and a project hash; refusals as `call-refused`.
    const calls = audits.filter((a) => a.kind === 'call');
    expect(calls.map((a) => `${a.method}:${a.outcome}`)).toEqual([
      'rooms.archive:ok', 'rooms.archive:ok', 'rooms.archive:conflict', 'rooms.delete:ok', 'rooms.delete:conflict',
    ]);
    expect(calls[0]).toMatchObject({ target: 'r-1', detail: expect.stringMatching(/^workId=w-1 project:sha256=[0-9a-f]{12} .*stopSessions=true/) });
    expect(audits.filter((a) => a.kind === 'call-refused')).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('Design review');
  });

  it('A41a: the room menu shares the mutating limit', async () => {
    for (let i = 0; i < 30; i++) {
      call(D, `m${i}`, i % 2 === 0 ? 'rooms.delete' : 'rooms.archive', { projectPath: '/p', workId: 'w-1', roomId: 'r-1', ...(i % 2 === 0 ? {} : { stopSessions: false }) });
      await flush();
    }
    call(D, 'over', 'rooms.delete', { projectPath: '/p', workId: 'w-1', roomId: 'r-1' });
    await flush();
    expect(answer('over')).toMatchObject({ error: { code: 'rate_limited' } });
    expect(host.calls.filter((c) => c.method === 'rooms.delete')).toHaveLength(15);
  });

  it('A38a: the session menu shares the mutating limit; switchOptions does not spend it', async () => {
    const menu = ['feed.interrupt', 'sessions.stop', 'sessions.close'];
    for (let i = 0; i < 30; i++) {
      call(D, `m${i}`, menu[i % 3]!, { ref: ref('s-1') });
      await flush();
    }
    call(D, 'read', 'sessions.switchOptions', { ref: ref('s-1') });
    call(D, 'over', 'sessions.switchAgent', { ref: ref('s-1'), requestId: '0b6e5d3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f', provider: 'codex' });
    await flush();
    expect(answer('read')).toMatchObject({ result: { ok: true } });
    expect(answer('over')).toMatchObject({ error: { code: 'rate_limited' } });
    expect(host.calls.filter((c) => c.method === 'sessions.switchAgent')).toEqual([]);
  });

  it('critic A38a m5: a refused ref-based call writes workId and a projectPath hash too', async () => {
    call(D, 'a', 'sessions.close', { ref: { projectPath: '/Users/a/secret-repo', workId: 'w-3', sessionId: '' } });
    await flush();
    expect(audits).toEqual([
      expect.objectContaining({ kind: 'call-refused', method: 'sessions.close', outcome: 'bad_request', detail: expect.stringMatching(/^workId=w-3 project:sha256=[0-9a-f]{12}/) }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('secret-repo');
  });
});
