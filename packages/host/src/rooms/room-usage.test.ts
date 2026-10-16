import { describe, expect, it } from 'vitest';
import { addRoom, addSession, HUMAN, type UsageResolver, type UsageSummary, type WorkMap } from '@parley/core';
import { createRoomsUsage } from './room-usage.js';

const T0 = '2026-10-14T10:00:00.000Z';
const NOW = '2026-10-14T12:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

const usage = (input: number): UsageSummary => ({
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalInput: input,
  source: 'native-index',
  observedAt: NOW,
  stale: false,
  completeness: 'complete',
  coverage: 'conversation',
});

function roomWithLead(): WorkMap {
  const map = emptyMap();
  const session = addSession(map, { provider: 'claude', label: 'lead', task: 'x' });
  session.providerSessionId = 'conv-secret-1';
  addRoom(map, { title: 'r', creator: HUMAN, members: [session.id] }, T0);
  return map;
}

const request = {} as never;

describe('rooms.usage (спека расхода токенов, 6.1)', () => {
  it('итог комнаты по карте работы и источнику цифр, без нативных id', async () => {
    const map = roomWithLead();
    const resolver: UsageResolver = {
      whole: () => usage(42),
      bounds: () => ({ startedAt: '2026-10-14T10:05:00.000Z', endedAt: null }),
      slice: async () => null,
    };
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver }, () => NOW);
    const result = await handler({ projectPath: '/p', workId: 'w-0001', roomId: 'r-01' }, request);
    expect(result).toMatchObject({ roomId: 'r-01', computedAt: NOW, total: { input: 42 } });
    expect(JSON.stringify(result)).not.toContain('conv-secret-1');
  });

  it('нет работы или комнаты — not_found', async () => {
    const map = roomWithLead();
    const resolver: UsageResolver = { whole: () => null, bounds: () => null, slice: async () => null };
    const missingWork = createRoomsUsage({ entry: () => undefined }, { usageResolver: () => resolver });
    await expect(missingWork({ projectPath: '/p', workId: 'w-0009', roomId: 'r-01' }, request)).rejects.toMatchObject({ code: 'not_found' });
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver });
    await expect(handler({ projectPath: '/p', workId: 'w-0001', roomId: 'r-09' }, request)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('одновременные запросы одной комнаты — один расчёт', async () => {
    const map = roomWithLead();
    let slices = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver: UsageResolver = {
      whole: () => null,
      // Начало лога раньше комнаты — путь среза.
      bounds: () => ({ startedAt: '2026-10-14T09:00:00.000Z', endedAt: null }),
      slice: async () => {
        slices += 1;
        await gate;
        return usage(7);
      },
    };
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver }, () => NOW);
    const params = { projectPath: '/p', workId: 'w-0001', roomId: 'r-01' };
    const both = Promise.all([handler(params, request), handler(params, request)]);
    release();
    const [a, b] = await both;
    expect(slices).toBe(1);
    expect(a).toBe(b);
    await handler(params, request);
    expect(slices).toBe(2);
  });
});
