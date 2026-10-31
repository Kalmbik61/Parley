import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorksSnapshot } from '@parley/protocol';
import { projectWorksSnapshot } from '@parley/protocol/remote';
import { needsYouCount } from '@parley/core/attention';
import type { ActivityEntry, HostLink, HostLinkEvent, HostLinkStatus } from './host-link.js';
import { refKey } from './host-link.js';
import type { BridgeLog } from './log.js';
import { createPushNotifier, type Presence } from './push.js';
import { createPushGatewayClient, resolvePushGatewayUrl, type PushRequest, type PushResult } from './push-gateway-client.js';
import type { DeviceRecord } from './devices.js';

const log: BridgeLog = { info() {}, warn() {}, error() {}, addSecret() {} };
const ROUTE = 'AAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'ab'.repeat(32);

interface MapOver {
  sessions?: Array<{ id: string; lifecycle: string }>;
  rooms?: Array<Record<string, unknown>>;
  unread?: number;
}
const entry = (projectPath: string, workId: string, over: MapOver = {}) => ({
  projectPath,
  map: {
    work: { id: workId, title: workId, status: 'active', updatedAt: 'x' },
    sessions: (over.sessions ?? []).map((s) => ({ provider: 'claude', label: s.id, parent: null, history: [], ...s })),
    rooms: over.rooms ?? [],
    messages: [],
    compact: { version: 2, rooms: { '': { total: 0, top: 0, lastAt: null, unread: over.unread ?? 0, decision: null } }, unread: { letters: over.unread ?? 0, rooms: {} }, mentionCandidates: [], cut: [], omitted: {} },
  },
});
const snapshotOf = (revision: number, ...entries: ReturnType<typeof entry>[]) => ({ revision, branches: {}, entries }) as unknown as WorksSnapshot;
const act = (projectPath: string, workId: string, sessionId: string, activity: string, need: unknown = null): ActivityEntry =>
  ({ ref: { projectPath, workId, sessionId }, activity: { activity, need }, metrics: null }) as unknown as ActivityEntry;

class FakeHost implements HostLink {
  status: HostLinkStatus = 'offline';
  epoch: string | null = null;
  methods: string[] | null = null;
  failure = null;
  snapshot: WorksSnapshot | null = null;
  activity = new Map<string, ActivityEntry>();
  listeners = new Set<(e: HostLinkEvent) => void>();
  start() {}
  async stop() {}
  async call(): Promise<unknown> {
    return {};
  }
  subscribe(l: (e: HostLinkEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: HostLinkEvent) {
    for (const l of this.listeners) l(e);
  }
  /** Подключение к хосту и первая картина эпохи. */
  load(epoch: string, snapshot: WorksSnapshot, acts: ActivityEntry[] = []) {
    this.epoch = epoch;
    this.status = 'starting';
    this.emit({ type: 'status', status: 'starting', epoch });
    this.snapshot = snapshot;
    this.activity = new Map(acts.map((a) => [refKey(a.ref), a]));
    this.status = 'online';
    this.emit({ type: 'status', status: 'online', epoch });
  }
  works(snapshot: WorksSnapshot) {
    this.snapshot = snapshot;
    this.emit({ type: 'host', event: 'works.changed', data: snapshot });
  }
  activityChanged(a: ActivityEntry) {
    this.activity.set(refKey(a.ref), a);
    this.emit({ type: 'host', event: 'activity.changed', data: a });
  }
  mail(projectPath: string, workId: string, letters: object[], extra: object = {}, unread = letters.length) {
    this.emit({
      type: 'host',
      event: 'rooms.mail',
      data: { projectPath, workId, version: 1, prevVersion: 0, updatedAt: '', rooms: [{ roomId: null, prevTop: 0, top: 1, total: 1, lastAt: null, letters, reads: [], deleted: [], ...extra }], droppedRooms: [], unread: { letters: unread, rooms: {} } },
    });
  }
}

const letter = (id: string) => ({ id, roomId: null, from: 's-9', to: ['human'], at: 'x', text: 't', kind: 'note', readBy: {} });
const proposal = (id: string, rev: number) => ({ id, rev, from: 's', text: 't', at: 'x' });

let host: FakeHost;
let sent: PushRequest[];
let result: PushResult;
let devices: DeviceRecord[];
let erased: string[];
let notifier: ReturnType<typeof createPushNotifier>;

const gateway = {
  async send(req: PushRequest) {
    sent.push(req);
    return result;
  },
};
const device = (id: string, over: Partial<DeviceRecord> = {}): DeviceRecord =>
  ({ deviceId: id, dsPub: 'k', name: id, platform: 'ios', pairedAt: 0, lastSeen: null, lastTs: 0, relayTokenHash: 'h', state: 'active', push: { apnsToken: TOKEN, env: 'sandbox', updatedAt: 0 }, ...over }) as DeviceRecord;

beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  sent = [];
  result = 'sent';
  erased = [];
  devices = [device('d1')];
  notifier = createPushNotifier({
    host,
    gateway,
    log,
    routeId: () => ROUTE,
    devices: {
      list: () => devices,
      get: (id) => devices.find((d) => d.deviceId === id),
      setPush: async (id, push) => {
        if (push === null) {
          erased.push(id);
          devices = devices.map((d) => (d.deviceId === id ? { ...d, push: undefined } : d));
        }
        return true;
      },
    },
  });
});
afterEach(() => {
  notifier.stop();
  vi.useRealTimers();
});

const idle = (n = 3100) => vi.advanceTimersByTimeAsync(n);
const w1 = (over: MapOver) => snapshotOf(1, entry('/p', 'w-1', over));

describe('A9: когда слать push', () => {
  it('1. число в push равно счёту по проекции (бейдж приложения) на тех же данных: сессии, решения, письма; архивная комната и упоминания не в счёте', async () => {
    const snap = snapshotOf(1, entry('/p', 'w-1', {
      sessions: [{ id: 's-1', lifecycle: 'active' }, { id: 's-2', lifecycle: 'active' }, { id: 's-3', lifecycle: 'active' }, { id: 's-4', lifecycle: 'closed' }],
      rooms: [{ id: 'r-1', proposal: proposal('p-1', 1) }, { id: 'r-2', archivedAt: 'a', proposal: proposal('p-2', 1) }],
      unread: 2,
    }));
    const lives: Record<string, { activity: string; need?: unknown }> = {
      's-1': { activity: 'blocked' },
      's-2': { activity: 'unseen', need: { kind: 'limit' } },
      's-3': { activity: 'blocked' },
      's-4': { activity: 'blocked' },
    };
    const projected = projectWorksSnapshot(snap).works.map((w) => ({
      projectPath: w.projectPath, workId: w.id, sessions: w.sessions, rooms: w.rooms, unreadLetters: w.messages.direct?.unread ?? 0,
    }));
    const viaProjection = needsYouCount(projected, (_p, _w, id) => (lives[id] as never) ?? null);
    host.load('e1', snap, ['s-1', 's-2', 's-4'].map((id) => act('/p', 'w-1', id, lives[id]!.activity, lives[id]!.need ?? null)).concat(act('/p', 'w-1', 's-3', 'working')));
    host.activityChanged(act('/p', 'w-1', 's-3', 'blocked'));
    await idle();
    expect(viaProjection).toBe(3 + 1 + 2); // s-1, s-2 (need), s-3 + решение r-1 + 2 письма
    expect(sent).toHaveLength(1);
    expect(sent[0]!.count).toBe(viaProjection);
  });

  it('2. два новых пункта за 1 с — один push через 3 с; уход пункта push не даёт', async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }, { id: 's-2', lifecycle: 'active' }] }), [act('/p', 'w-1', 's-1', 'working'), act('/p', 'w-1', 's-2', 'working')]);
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
    await idle(1000);
    host.activityChanged(act('/p', 'w-1', 's-2', 'blocked'));
    await idle(1500);
    expect(sent).toHaveLength(0);
    await idle(1000);
    expect(sent).toEqual([{ token: TOKEN, env: 'sandbox', count: 2, route: ROUTE }]);
    host.activityChanged(act('/p', 'w-1', 's-1', 'working'));
    await idle(10_000);
    expect(sent).toHaveLength(1);
  });

  it('2. presence active — push нет; idle, locked и «окна нет» — push есть', async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }] }), [act('/p', 'w-1', 's-1', 'working')]);
    const trip = async (state: Presence, id: number, expected: number) => {
      notifier.setPresence(state);
      host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
      await idle();
      expect(sent, String(state)).toHaveLength(expected);
      host.activityChanged(act('/p', 'w-1', 's-1', 'working'));
      void id;
    };
    await trip('active', 1, 0);
    await trip('idle', 2, 1);
    await trip('locked', 3, 2);
    await trip(null, 4, 3);
  });

  it('3. ведущий заменил решение (новый rev, счёт тот же) — push; сессия вышла и снова вошла — push', async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }], rooms: [{ id: 'r-1', proposal: proposal('p-1', 0) }] }), [act('/p', 'w-1', 's-1', 'working')]);
    host.works(snapshotOf(2, entry('/p', 'w-1', { sessions: [{ id: 's-1', lifecycle: 'active' }], rooms: [{ id: 'r-1', proposal: proposal('p-1', 1) }] })));
    await idle();
    expect(sent).toEqual([expect.objectContaining({ count: 1 })]);
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
    await idle();
    expect(sent).toHaveLength(2);
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked')); // тот же вход: ключ тот же
    await idle();
    expect(sent).toHaveLength(2);
    host.activityChanged(act('/p', 'w-1', 's-1', 'working'));
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
    await idle();
    expect(sent).toHaveLength(3);
  });

  it('4. первая картина после подключения к хосту (новая эпоха) push не даёт', async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }], unread: 1 }), [act('/p', 'w-1', 's-1', 'blocked')]);
    await idle(10_000);
    expect(sent).toHaveLength(0);
    host.load('e2', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }], unread: 1 }), [act('/p', 'w-1', 's-1', 'blocked')]);
    await idle(10_000);
    expect(sent).toHaveLength(0);
    // Ждущее прежде, но новое в эпохе e2, — повод.
    host.works(snapshotOf(5, entry('/p', 'w-1', { sessions: [{ id: 's-1', lifecycle: 'active' }, { id: 's-2', lifecycle: 'active' }], unread: 1 })));
    host.activityChanged(act('/p', 'w-1', 's-2', 'blocked'));
    await idle();
    expect(sent).toHaveLength(1);
  });

  it('4. таймер пачки не переживает смену эпохи', async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }] }), [act('/p', 'w-1', 's-1', 'working')]);
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
    await idle(1000);
    host.load('e2', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }] }), [act('/p', 'w-1', 's-1', 'blocked')]);
    await idle(10_000);
    expect(sent).toHaveLength(0);
  });

  it('5. непрочитанные m-01 в двух работах — два ключа и push на второй; прочтение в одной не снимает ключ другой', async () => {
    host.load('e1', snapshotOf(1, entry('/p', 'w-1'), entry('/p', 'w-2')));
    host.mail('/p', 'w-1', [letter('m-01')], {}, 1);
    await idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.count).toBe(1);
    host.mail('/p', 'w-2', [letter('m-01')], {}, 1);
    await idle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.count).toBe(2);
    // Прочтение m-01 в w-1: счётчик падает, push нет, ключ w-2 цел.
    host.mail('/p', 'w-1', [], { reads: [{ id: 'm-01', reader: 'human', at: 'now' }] }, 0);
    await idle();
    expect(sent).toHaveLength(2);
    // Повторное письмо m-02 в w-1 — новый ключ, push.
    host.mail('/p', 'w-1', [letter('m-02')], {}, 1);
    await idle();
    expect(sent).toHaveLength(3);
  });
});

describe('A9: шлюз и токены', () => {
  const trigger = async () => {
    host.load('e1', w1({ sessions: [{ id: 's-1', lifecycle: 'active' }] }), [act('/p', 'w-1', 's-1', 'working')]);
    host.activityChanged(act('/p', 'w-1', 's-1', 'blocked'));
    await idle();
  };

  it('7. шлюз ответил 410 — токен стёрт; устройство без токена и неподтверждённое — запроса нет', async () => {
    result = 'invalid-token';
    devices = [device('d1'), device('d2', { push: undefined }), device('d3', { state: 'pending' })];
    await trigger();
    expect(sent).toHaveLength(1);
    expect(erased).toEqual(['d1']);
  });

  it('410 не стирает токен, который телефон успел заменить', async () => {
    result = 'invalid-token';
    const original = gateway.send.bind(gateway);
    gateway.send = async (req) => {
      const r = await original(req);
      devices = devices.map((d) => ({ ...d, push: { apnsToken: 'cd'.repeat(32), env: 'sandbox', updatedAt: 1 } }));
      return r;
    };
    try {
      await trigger();
    } finally {
      gateway.send = original;
    }
    expect(erased).toEqual([]);
  });

  it('шлюз недоступен — пропуск без повтора', async () => {
    result = 'unavailable';
    await trigger();
    await idle(60_000);
    expect(sent).toHaveLength(1);
  });

  it('без адреса шлюза push не шлётся и ничего не падает', async () => {
    notifier.stop();
    notifier = createPushNotifier({ host, gateway: null, log, routeId: () => ROUTE, devices: { list: () => devices, get: () => undefined, setPush: async () => true } });
    await trigger();
    expect(sent).toHaveLength(0);
  });
});

describe('A9: клиент шлюза', () => {
  const mk = (status: number | Error) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createPushGatewayClient({
      url: 'https://push.example.com',
      log,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (status instanceof Error) throw status;
        return { status } as Response;
      }) as unknown as typeof fetch,
    });
    return { client, calls };
  };
  const req: PushRequest = { token: 'AB'.repeat(32), env: 'production', count: 3, route: ROUTE };

  it('7. в теле только поля схемы A1, токен в нижнем регистре', async () => {
    const { client, calls } = mk(200);
    expect(await client.send(req)).toBe('sent');
    expect(calls[0]!.url).toBe('https://push.example.com/v1/push');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ v: 1, token: 'ab'.repeat(32), env: 'production', count: 3, route: ROUTE });
  });

  it('статусы: 410 → invalid-token, 400 и 429 → rejected, 5xx и обрыв → unavailable; count режется до 9999', async () => {
    expect(await mk(410).client.send(req)).toBe('invalid-token');
    expect(await mk(400).client.send(req)).toBe('rejected');
    expect(await mk(429).client.send(req)).toBe('rejected');
    expect(await mk(503).client.send(req)).toBe('unavailable');
    expect(await mk(new Error('down')).client.send(req)).toBe('unavailable');
    const { client, calls } = mk(200);
    await client.send({ ...req, count: 123456 });
    expect(JSON.parse(calls[0]!.init.body as string).count).toBe(9999);
    expect(await mk(200).client.send({ ...req, token: 'not hex' })).toBe('rejected');
  });

  it('адрес шлюза: переопределение из remote.json, иначе сборка; только https (и петля)', () => {
    expect(resolvePushGatewayUrl(undefined, null)).toBeNull();
    expect(resolvePushGatewayUrl(undefined, 'https://build.example.com/x')).toBe('https://build.example.com');
    expect(resolvePushGatewayUrl('https://mine.example.com', 'https://build.example.com')).toBe('https://mine.example.com');
    expect(resolvePushGatewayUrl('http://push.example.com', null)).toBeNull();
    expect(resolvePushGatewayUrl('http://127.0.0.1:8080', null)).toBe('http://127.0.0.1:8080');
    expect(resolvePushGatewayUrl('nonsense', null)).toBeNull();
  });
});
