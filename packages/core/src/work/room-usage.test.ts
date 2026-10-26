import { describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { roomUsage, type UsageResolver } from './room-usage.js';
import { addMember, addRoom, archiveRoom, joinedLine } from './rooms.js';
import { HUMAN, SYSTEM, type WorkMap, type WorkSession } from './types.js';
import type { UsageSummary, UsageWindow } from './usage-ledger.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T11:00:00.000Z';
const T2 = '2026-10-14T12:00:00.000Z';
const T3 = '2026-10-14T13:00:00.000Z';
const NOW = '2026-10-14T14:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

function usage(input: number, over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalInput: input,
    source: 'native-index',
    observedAt: T1,
    stale: false,
    completeness: 'complete',
    coverage: 'conversation',
    ...over,
  };
}

/** Сессия с разговором у провайдера: без него она `not started`. */
function bound(map: WorkMap, label: string, provider = 'claude', conversation = `conv-${label}`): WorkSession {
  const session = addSession(map, { provider, label, task: 'x' });
  session.providerSessionId = conversation;
  return session;
}

interface FakeResolver extends UsageResolver {
  sliced: Array<{ session: string; windows: readonly UsageWindow[] }>;
}

function resolver(
  over: { whole?: UsageResolver['whole']; bounds?: UsageResolver['bounds']; slice?: (session: WorkSession) => UsageSummary | null } = {},
): FakeResolver {
  const sliced: FakeResolver['sliced'] = [];
  return {
    sliced,
    whole: over.whole ?? (() => usage(100)),
    bounds: over.bounds ?? (() => ({ startedAt: T1, endedAt: T2 })),
    slice: async (session, windows) => {
      sliced.push({ session: session.id, windows });
      return over.slice === undefined ? usage(10) : over.slice(session);
    },
  };
}

describe('roomUsage (спека расхода токенов, 5)', () => {
  it('целиком в окне — готовый итог; с историей до комнаты — срез по окну участия', async () => {
    const map = emptyMap();
    const lead = bound(map, 'lead');
    const agent = bound(map, 'agent');
    addRoom(map, { title: 'r', creator: HUMAN, members: [lead.id, agent.id], lead: lead.id }, T0);
    const fake = resolver({
      bounds: (session) => ({ startedAt: session.id === lead.id ? '2026-10-14T09:00:00.000Z' : T1, endedAt: T2 }),
    });
    const result = await roomUsage(map, 'r-01', fake, NOW);
    expect(result.members.map((member) => [member.sessionId, member.lead, member.status, member.method, member.usage?.input])).toEqual([
      [lead.id, true, 'counted', 'sliced', 10],
      [agent.id, false, 'counted', 'whole-session', 100],
    ]);
    expect(fake.sliced).toEqual([{ session: lead.id, windows: [{ from: T0, to: null }] }]);
    expect(result.total).toMatchObject({ input: 110, completeness: 'complete', conversations: 2 });
    expect(result.byProvider).toEqual([{ provider: 'claude', total: expect.objectContaining({ input: 110 }) }]);
    expect(result).toMatchObject({ roomId: 'r-01', computedAt: NOW, reconstructed: false });
  });

  it('перетащенную в другую комнату старая считает до ухода, новая — после входа', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    addRoom(map, { title: 'r1', creator: HUMAN, members: [session.id] }, T0);
    addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addMember(map, lt(map), 'r-02', session.id, T2);
    const fake = resolver({ bounds: () => ({ startedAt: T1, endedAt: T3 }) });
    const old = await roomUsage(map, 'r-01', fake, NOW);
    expect(old.members[0]).toMatchObject({ sessionId: session.id, current: false, periods: [{ from: T0, to: T2 }], method: 'sliced', sharedWith: [] });
    const fresh = await roomUsage(map, 'r-02', fake, NOW);
    expect(fresh.members[0]).toMatchObject({ sessionId: session.id, current: true, periods: [{ from: T2, to: null }] });
  });

  it('архив режет окна: работа после архивации в итог комнаты не входит', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    addRoom(map, { title: 'r', creator: HUMAN, members: [session.id] }, T0);
    archiveRoom(map, lt(map), 'r-01', T2);
    const fake = resolver({ bounds: () => ({ startedAt: T1, endedAt: T3 }) });
    const result = await roomUsage(map, 'r-01', fake, NOW);
    expect(fake.sliced).toEqual([{ session: session.id, windows: [{ from: T0, to: T2 }] }]);
    expect(result.members[0]).toMatchObject({ current: true, periods: [{ from: T0, to: T2 }] });
  });

  it('не запущенная — not started; без лога и удалённая — n/a; порядок: ведущий, текущие, вышедшие', async () => {
    const map = emptyMap();
    const idle = addSession(map, { provider: 'claude', label: 'idle', task: 'x' });
    const lost = bound(map, 'lost');
    const room = addRoom(map, { title: 'r', creator: HUMAN, members: [idle.id, lost.id] }, T0);
    room.memberLog!.push({ session: 's-09', from: T1, to: null });
    const result = await roomUsage(map, 'r-01', resolver({ whole: () => null }), NOW);
    expect(result.members.map((member) => [member.sessionId, member.status, member.reason, member.provider])).toEqual([
      [idle.id, 'not-started', null, 'claude'],
      [lost.id, 'unavailable', 'log-missing', 'claude'],
      ['s-09', 'unavailable', 'deleted', null],
    ]);
    expect(result.total).toMatchObject({ input: null, completeness: 'unknown' });
  });

  it('все участники не запускались — итог ноль, а не неизвестно', async () => {
    const map = emptyMap();
    const idle = addSession(map, { provider: 'claude', label: 'idle', task: 'x' });
    addRoom(map, { title: 'r', creator: HUMAN, members: [idle.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver(), NOW);
    expect(result.total).toMatchObject({ input: 0, output: 0, completeness: 'complete', conversations: 0 });
  });

  it('участник без лога делает неполным итог и итог своего провайдера', async () => {
    const map = emptyMap();
    const ok = bound(map, 'ok');
    const lost = bound(map, 'lost');
    addRoom(map, { title: 'r', creator: HUMAN, members: [ok.id, lost.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver({ whole: (session) => (session.id === lost.id ? null : usage(100)) }), NOW);
    expect(result.total).toMatchObject({ input: 100, completeness: 'partial' });
    expect(result.byProvider[0]?.total.completeness).toBe('partial');
  });

  it('разбивка по провайдерам; один разговор у двух записей карты — в итоге один раз', async () => {
    const map = emptyMap();
    const a = bound(map, 'a', 'claude', 'conv-1');
    const b = bound(map, 'b', 'claude', 'conv-1');
    const c = bound(map, 'c', 'codex', 'thread-1');
    addRoom(map, { title: 'r', creator: HUMAN, members: [a.id, b.id, c.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver({ whole: (session) => usage(session.provider === 'codex' ? 7 : 100) }), NOW);
    expect(result.total).toMatchObject({ input: 107, conversations: 2 });
    expect(result.byProvider.map((item) => [item.provider, item.total.input])).toEqual([
      ['claude', 100],
      ['codex', 7],
    ]);
  });

  it('старая карта, сессия в двух комнатах сразу — shared with, история восстановлена', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: [session.id] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: [session.id] }, T1);
    delete r1.memberLog;
    delete r2.memberLog;
    const result = await roomUsage(map, 'r-01', resolver(), NOW);
    expect(result.reconstructed).toBe(true);
    expect(result.members[0]?.sharedWith).toEqual(['r-02']);
  });

  // Спека хранилища 6.2: ленту старой комнаты хост читает из базы, а не из `map.messages`.
  it('старая комната: вход восстанавливается по письмам, которые дал читатель, а не по карте', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    const room = addRoom(map, { title: 'r', creator: HUMAN, members: [session.id] }, T0);
    delete room.memberLog;
    const line = { id: 'm-01', roomId: room.id, from: SYSTEM, to: [], text: joinedLine(session.id), kind: 'note', at: T2, readBy: {} } as const;
    const letters = {
      query: () => [line],
      count: () => 1,
    };
    const without = await roomUsage(map, room.id, resolver(), NOW);
    const result = await roomUsage(map, room.id, resolver(), NOW, letters);
    expect(without.members[0]?.periods).toEqual([{ from: T0, to: null }]);
    expect(result.members[0]?.periods).toEqual([{ from: T2, to: null }]);
  });
});

it('ownership alone never duplicates owner usage across rooms', async () => {
  const map = emptyMap();
  const owner = bound(map, 'owner');
  const member = bound(map, 'member');
  const first = addRoom(map, { title: 'one', creator: owner.id, ownerId: owner.id, members: [member.id] }, T0);
  const second = addRoom(map, { title: 'two', creator: owner.id, ownerId: owner.id, members: [] }, T0);
  const firstUsage = await roomUsage(map, first.id, resolver(), NOW);
  const secondUsage = await roomUsage(map, second.id, resolver(), NOW);
  expect(firstUsage.members.map((entry) => entry.sessionId)).toEqual([member.id]);
  expect(firstUsage.total.input).toBe(100);
  expect(secondUsage.members).toEqual([]);
  expect(secondUsage.total.input).toBe(0);
});
