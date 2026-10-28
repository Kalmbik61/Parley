import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from './resource-policy.js';
import {
  SWARM_TAG_MAX,
  isSwarmExpired,
  isSwarmTag,
  isSwarmTerminal,
  memberState,
  swarmDeadline,
  swarmMemberIds,
  swarmOfSession,
  swarmProgress,
  type WorkSwarm,
  type WorkSwarmMember,
} from './swarms.js';

const AT = '2026-10-28T10:00:00.000Z';

const member = (sessionId: string, role: WorkSwarmMember['role'], n: number, handedAt: string | null = null): WorkSwarmMember => ({
  sessionId, role, n, addedAt: AT, handedAt,
});

const swarm = (patch: Partial<WorkSwarm> = {}): WorkSwarm => ({
  id: 'sw-01', tag: 'Research', creator: { kind: 'human' }, objective: 'Audit', queen: 's-01',
  members: [member('s-01', 'queen', 1), member('s-02', 'drone', 1, AT), member('s-03', 'drone', 2), member('s-04', 'verifier', 1)],
  status: 'running', createdAt: AT, endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null,
  ...patch,
});

describe('memberState', () => {
  const drone = member('s-03', 'drone', 2);

  it('handed: сдал — остаётся сдавшим и в отменённом рое, и без сессии', () => {
    const handed = member('s-02', 'drone', 1, AT);
    expect(memberState(swarm(), handed, { lifecycle: 'closed', result: 'done' })).toBe('handed');
    expect(memberState(swarm({ status: 'cancelled' }), handed, undefined)).toBe('handed');
    expect(memberState(swarm({ status: 'failed' }), handed, { lifecycle: 'active', result: null })).toBe('handed');
  });

  it('closed: рой failed/cancelled, участник не сдал — его закрыл хост, даже если сессии нет или она упала', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(memberState(swarm({ status }), drone, { lifecycle: 'active', result: null })).toBe('closed');
      expect(memberState(swarm({ status }), drone, undefined)).toBe('closed');
      expect(memberState(swarm({ status }), drone, { lifecycle: 'closed', result: 'failed' })).toBe('closed');
    }
    // `done` — не отмена: несдавший участник считается по сессии.
    expect(memberState(swarm({ status: 'done' }), drone, { lifecycle: 'active', result: null })).toBe('working');
  });

  it('failed: сессии нет в карте, итог failed или сессия закрыта без сдачи', () => {
    expect(memberState(swarm(), drone, undefined)).toBe('failed');
    expect(memberState(swarm(), drone, { lifecycle: 'active', result: 'failed' })).toBe('failed');
    expect(memberState(swarm(), drone, { lifecycle: 'closed', result: null })).toBe('failed');
  });

  it('waiting: добавлен, процесс не стартовал (lifecycle pending)', () => {
    expect(memberState(swarm(), drone, { lifecycle: 'pending', result: null })).toBe('waiting');
  });

  it('working: живая или спящая сессия без итога failed', () => {
    expect(memberState(swarm(), drone, { lifecycle: 'active', result: null })).toBe('working');
    expect(memberState(swarm(), drone, { lifecycle: 'sleeping', result: null })).toBe('working');
    // Итог done без `handedAt` — хост ещё не записал сдачу: участник пока работает.
    expect(memberState(swarm(), drone, { lifecycle: 'active', result: 'done' })).toBe('working');
  });
});

describe('swarmMemberIds и swarmOfSession', () => {
  const map = {
    swarms: [
      swarm(),
      swarm({ id: 'sw-02', queen: 's-10', members: [member('s-10', 'queen', 1), member('s-11', 'verifier', 1)] }),
    ],
  };

  it('swarmMemberIds: сессии всех роёв, королев включая', () => {
    expect([...swarmMemberIds(map)].sort()).toEqual(['s-01', 's-02', 's-03', 's-04', 's-10', 's-11']);
    expect(swarmMemberIds({}).size).toBe(0);
    expect(swarmMemberIds({ swarms: [] }).size).toBe(0);
  });

  it('swarmOfSession: рой и запись участника; чужая сессия — null', () => {
    const found = swarmOfSession(map, 's-11');
    expect(found?.swarm.id).toBe('sw-02');
    expect(found?.member).toMatchObject({ role: 'verifier', n: 1 });
    expect(swarmOfSession(map, 's-01')?.member.role).toBe('queen');
    expect(swarmOfSession(map, 's-99')).toBeNull();
    expect(swarmOfSession({}, 's-01')).toBeNull();
  });
});

describe('swarmProgress и isSwarmTerminal', () => {
  it('считает сдавших трутней и проверяющих; королева не входит ни в счёт, ни в итог', () => {
    expect(swarmProgress(swarm())).toEqual({ handed: 1, total: 3 });
    expect(swarmProgress(swarm({ members: [member('s-01', 'queen', 1, AT)] }))).toEqual({ handed: 0, total: 0 });
  });

  it('терминальны done, failed, cancelled', () => {
    expect(['running', 'collecting'].some((status) => isSwarmTerminal(status as 'running'))).toBe(false);
    expect((['done', 'failed', 'cancelled'] as const).every(isSwarmTerminal)).toBe(true);
  });
});

describe('isSwarmTag', () => {
  it('1–24 знака без перевода строки', () => {
    expect(isSwarmTag('Research')).toBe(true);
    expect(isSwarmTag('Аудит')).toBe(true);
    expect(isSwarmTag('x'.repeat(SWARM_TAG_MAX))).toBe(true);
    expect(isSwarmTag('')).toBe(false);
    expect(isSwarmTag('x'.repeat(SWARM_TAG_MAX + 1))).toBe(false);
    expect(isSwarmTag('a\nb')).toBe(false);
    expect(isSwarmTag('a\rb')).toBe(false);
    expect(isSwarmTag(42)).toBe(false);
  });
});

describe('срок жизни роя', () => {
  const limits = { swarmMinutes: DEFAULT_RESOURCE_LIMITS.swarmMinutes };
  const start = Date.parse(AT);

  it('swarmDeadline: createdAt + swarmMinutes; ноль — срока нет', () => {
    expect(swarmDeadline(swarm(), limits)).toBe(start + 90 * 60_000);
    expect(swarmDeadline(swarm(), { swarmMinutes: 1 })).toBe(start + 60_000);
    expect(swarmDeadline(swarm(), { swarmMinutes: 0 })).toBeNull();
  });

  it('isSwarmExpired: идущий рой после срока; до срока, без срока и терминальный — нет', () => {
    const deadline = start + 90 * 60_000;
    expect(isSwarmExpired(swarm(), limits, deadline - 1)).toBe(false);
    expect(isSwarmExpired(swarm(), limits, deadline)).toBe(true);
    expect(isSwarmExpired(swarm({ status: 'collecting' }), limits, deadline + 1)).toBe(true);
    expect(isSwarmExpired(swarm(), { swarmMinutes: 0 }, deadline * 10)).toBe(false);
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      expect(isSwarmExpired(swarm({ status }), limits, deadline + 1)).toBe(false);
    }
  });
});
