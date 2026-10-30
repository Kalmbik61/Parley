import { describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { roomUsage, type UsageResolver } from './room-usage.js';
import { addRoom } from './rooms.js';
import { mapLetterTx } from './letter-store.js';
import { HUMAN, type AgentBinding, type WorkMap } from './types.js';
import { createUsageLedger, freezeUsage, type UsageSummary } from './usage-ledger.js';
import { bindingUsage, currentSegmentUsage, sumSegments } from './usage-segments.js';

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T11:00:00.000Z';
const T2 = '2026-10-14T12:00:00.000Z';
const NOW = '2026-10-14T14:00:00.000Z';

const usage = (input: number, over: Partial<UsageSummary> = {}): UsageSummary => ({
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
});

const binding = (input: number, startedAt: string | null, endedAt: string, id = 'old'): AgentBinding => ({
  provider: 'claude',
  model: 'opus',
  effort: null,
  providerSessionId: id,
  startedAt,
  endedAt,
  reason: 'manual',
  requestedBy: 'human',
  carried: 'handover',
  usage: freezeUsage(usage(input), { binding: id, epoch: null, closed: true }),
  costUsd: null,
});

describe('excludeIds в ledger: копии прежних ответов не считаются второй раз', () => {
  const delta = (id: string, input: number) => ({
    kind: 'delta' as const,
    id,
    at: T1,
    counters: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalInput: input },
  });

  it('наблюдение с исключённым id пропускается, остальные считаются', () => {
    const ledger = createUsageLedger({ windows: [{ from: T0, to: null }], excludeIds: new Set(['msg:old']) });
    ledger.observe(delta('msg:old', 100));
    ledger.observe(delta('msg:new', 7));
    expect(ledger.summary()).toMatchObject({ input: 7 });
  });
});

describe('сумма отрезков', () => {
  it('складывает счётчики; неизвестный счётчик и неполнота делают итог неизвестным и неполным', () => {
    const total = sumSegments([usage(10), usage(20, { completeness: 'partial' }), usage(5, { cacheWrite: null })]);
    expect(total).toMatchObject({ input: 35, cacheRead: 0, cacheWrite: null, completeness: 'partial' });
  });

  it('закрытый отрезок без снимка — неизвестный расход', () => {
    const bare: AgentBinding = binding(1, T0, T1);
    delete bare.usage;
    expect(bindingUsage(bare)).toMatchObject({ input: null, completeness: 'unknown' });
  });
});

describe('currentSegmentUsage и расход комнаты у переведённой сессии', () => {
  function fixture() {
    const map: WorkMap = {
      schemaVersion: 2,
      work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
      sessions: [],
      messages: [],
      rooms: [],
    };
    const session = addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    session.providerSessionId = 'fork';
    session.startedAt = T0;
    session.previousAgents = [binding(100, T0, T1)];
    return { map, session };
  }

  const resolver = (log: string[] = []): UsageResolver & { sliced: unknown[] } => {
    const sliced: unknown[] = [];
    return {
      sliced,
      whole: () => usage(999),
      bounds: () => null,
      slice: async (_session, windows, excluded) => {
        sliced.push({ windows, excluded: [...(excluded ?? [])] });
        return usage(40);
      },
      ids: async (session) => (session.providerSessionId === 'old' ? new Set(log) : null),
    };
  };

  it('текущий отрезок — срез после конца последней привязки, без ответов прежних отрезков', async () => {
    const { session } = fixture();
    const fake = resolver(['msg:a', 'msg:b']);
    expect(await currentSegmentUsage(session, fake)).toMatchObject({ input: 40 });
    expect(fake.sliced).toEqual([{ windows: [{ from: T1, to: null }], excluded: ['msg:a', 'msg:b'] }]);
  });

  it('участие в комнате: закрытый отрезок целиком внутри входит, текущий режется окнами; сумма без двойного счёта', async () => {
    const { map, session } = fixture();
    addRoom(map, { title: 'r', creator: HUMAN, members: [session.id], lead: session.id }, T0);
    const fake = resolver();
    const result = await roomUsage(map, 'r-01', fake, NOW, mapLetterTx(map).letters);
    const member = result.members[0]!;
    expect(member).toMatchObject({ status: 'counted', method: 'sliced' });
    expect(member.usage).toMatchObject({ input: 140, completeness: 'complete' });
    expect(result.total).toMatchObject({ input: 140, conversations: 1 });
  });

  it('участник вошёл в комнату посреди закрытого отрезка: итог не полнее нижней границы', async () => {
    const { map, session } = fixture();
    addRoom(map, { title: 'r', creator: HUMAN, members: [session.id], lead: session.id }, '2026-10-14T10:30:00.000Z');
    const result = await roomUsage(map, 'r-01', resolver(), NOW, mapLetterTx(map).letters);
    expect(result.members[0]!.usage).toMatchObject({ completeness: 'partial' });
  });
});

describe('claudeCostIn: накопитель cost-state', () => {
  const timeline = (costs: Array<[string, number, boolean?]>, first: string | null = T0) =>
    ({
      file: 'x',
      family: 'claude',
      offset: 0,
      size: 0,
      ino: 0,
      lineNo: 0,
      observations: first === null ? [] : [{ kind: 'delta', id: 'msg:1', at: first, counters: usage(1) }],
      costs: costs.map(([at, total, unknown]) => ({ at, total, unknown: unknown === true })),
    }) as const;
  const window = { from: T1, to: T2 };

  it('конец окна минус значение до начала', async () => {
    const { claudeCostIn } = await import('./usage-timeline.js');
    expect(claudeCostIn(timeline([[T0, 3], ['2026-10-14T11:30:00.000Z', 3.5], ['2026-10-14T12:30:00.000Z', 9]]), window)).toBeCloseTo(0.5);
  });

  it('до начала записей нет: с начала разговора — база ноль, иначе null; неизвестная цена модели — null', async () => {
    const { claudeCostIn } = await import('./usage-timeline.js');
    expect(claudeCostIn(timeline([['2026-10-14T11:30:00.000Z', 2]], null), window)).toBe(2);
    expect(claudeCostIn(timeline([['2026-10-14T11:30:00.000Z', 2]]), window)).toBeNull();
    expect(claudeCostIn(timeline([[T0, 3], ['2026-10-14T11:30:00.000Z', 3.5, true]]), window)).toBeNull();
    expect(claudeCostIn(timeline([]), window)).toBeNull();
  });
});
