/** Числа ёмкости (спека сна и ёмкости 2026-10-30, 4.3 и 4.5): машина, бюджет работы и комнаты, рой, свои подсессии, canStart и совет. */

import { describe, expect, it } from 'vitest';
import {
  capacityReport,
  machineCapacity,
  type CapacityFacts,
  type CapacityReport,
  type MachineCapacity,
  type MachineInput,
} from './capacity-report.js';
import { addMessage, addSession, transitionSession } from './map.js';
import {
  DEFAULT_RESOURCE_LIMITS,
  RESOURCE_WINDOW_MS,
  checkSwarmSpawn,
  resourceStatus,
  swarmBusy,
  type ResourceLimits,
} from './resource-policy.js';
import { addRoom } from './rooms.js';
import type { WorkSwarm } from './swarms.js';
import type { CreationKind, MemoryPressure, QueuedLaunch, ResourceAttempt, WindowWorkMap } from './types.js';

const NOW = Date.now() + 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const AT = iso(NOW);
const MINUTE = 60_000;

const limits = (patch: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...patch });

const emptyMap = (): WindowWorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'ёмкость', goal: '', status: 'active', createdAt: AT, updatedAt: AT },
  sessions: [],
  messages: [],
  rooms: [],
});

function addActive(map: WindowWorkMap, patch: { createdBy?: string } = {}): string {
  const session = addSession(map, { provider: 'claude', label: 'x', task: 'y', ...patch });
  transitionSession(map, session.id, 'active');
  return session.id;
}

function addSleeping(map: WindowWorkMap, patch: { createdBy?: string } = {}): string {
  const id = addActive(map, patch);
  transitionSession(map, id, 'sleeping');
  return id;
}

const queuedLaunch = (): QueuedLaunch => ({ class: 'agent', mode: 'launch', by: 'x', at: AT, reason: 'machine-limit', live: 18, limit: 18 });

const attempt = (patch: Partial<ResourceAttempt> & Pick<ResourceAttempt, 'session'>): ResourceAttempt => ({
  id: `a-${Math.random().toString(36).slice(2, 8)}`,
  kind: 'launch',
  state: 'spent',
  at: iso(NOW - 1000),
  actor: 'human',
  room: null,
  owner: 'o1',
  ...patch,
});

const withAttempts = (map: WindowWorkMap, attempts: ResourceAttempt[], recent: { kind: CreationKind; room: string | null }[] = []): void => {
  map.resources = {
    seq: attempts.length, spawned: 0, spawnedByRoom: {}, attempts,
    recent: recent.map((entry) => ({ ...entry, at: iso(NOW - 1000) })),
  };
};

const machineOf = (patch: Partial<MachineCapacity> = {}): MachineCapacity => ({
  live: 3, limit: 18, queued: 0, pressure: 'normal', swapGb: null, sleepMinutes: 60, ...patch,
});

const factsOf = (machine: Partial<MachineCapacity> = {}, activity: CapacityFacts['activity'] = { subagents: 0, background: [] }): CapacityFacts => ({
  machine: machineOf(machine), activity,
});

const report = (
  map: WindowWorkMap,
  sessionId: string | null,
  facts: CapacityFacts | null,
  patch: Partial<ResourceLimits> = {},
  resumeRate = 6,
): CapacityReport => capacityReport({ map, sessionId, limits: limits(patch), resumeRate, facts, now: NOW });

const swarmOf = (sessionIds: string[], patch: Partial<WorkSwarm> = {}): WorkSwarm => ({
  id: 'sw-01', tag: 'Research', creator: { kind: 'human' }, objective: 'Audit', queen: sessionIds[0]!,
  members: sessionIds.map((sessionId, index) => ({ sessionId, role: index === 0 ? 'queen' : 'drone', n: index === 0 ? 1 : index, addedAt: AT, handedAt: null })),
  status: 'running', createdAt: iso(NOW - 30 * MINUTE), endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null,
  ...patch,
});

describe('machineCapacity', () => {
  const input = (patch: Partial<MachineInput> = {}): MachineInput => ({
    occupied: 5, limit: 18, queued: 0, pressure: 'normal', swapGb: null, sleepAfterMinutes: 60, sleepUnderPressureMinutes: 5, ...patch,
  });

  it('сон выключен: sleepMinutes null при любом давлении и очереди', () => {
    const pressures: MemoryPressure[] = ['normal', 'warn', 'critical', 'unknown'];
    for (const pressure of pressures) {
      for (const queued of [0, 3]) {
        expect(machineCapacity(input({ sleepAfterMinutes: 0, pressure, queued })).sleepMinutes).toBeNull();
      }
    }
  });

  it('порог давления при warn/critical или очереди, обычный — при normal/unknown без очереди', () => {
    expect(machineCapacity(input({ pressure: 'warn' })).sleepMinutes).toBe(5);
    expect(machineCapacity(input({ pressure: 'normal', queued: 2 })).sleepMinutes).toBe(5);
    expect(machineCapacity(input({ pressure: 'unknown' })).sleepMinutes).toBe(60);
    expect(machineCapacity(input({ pressure: 'normal' })).sleepMinutes).toBe(60);
    expect(machineCapacity(input({ sleepAfterMinutes: 3, pressure: 'critical' })).sleepMinutes).toBe(3);
  });

  it('своп до десятых; live — занятое', () => {
    expect(machineCapacity(input({ swapGb: 4.26 })).swapGb).toBe(4.3);
    expect(machineCapacity(input({ swapGb: null })).swapGb).toBeNull();
    expect(machineCapacity(input({ occupied: 7, limit: null, queued: 2 }))).toMatchObject({ live: 7, limit: null, queued: 2 });
  });
});

describe('capacityReport', () => {
  it('без хоста: machine, subagents и background null, canStart по бюджету работы', () => {
    const map = emptyMap();
    const me = addActive(map);
    addActive(map);
    const result = report(map, me, null, { workConcurrent: 5 });
    expect(result.machine).toBeNull();
    expect(result.you).toMatchObject({ subagents: null, background: null });
    expect(result.canStart).toBe(3);
    expect(result.limitedBy).toBe('workConcurrent');
    expect(result.hint).toBe('3 more can start now; after that workConcurrent refuses new sessions.');
  });

  it('хост знает машину, но не сессию: activity null — subagents и background null, machine есть', () => {
    const map = emptyMap();
    const me = addActive(map);
    const result = report(map, me, factsOf({ live: 4, limit: 18, queued: 1, pressure: 'warn', swapGb: 1.5, sleepMinutes: 5 }, null));
    expect(result.machine).toEqual({ live: '4/18', queued: 1, memory: 'warn', swapGb: 1.5, sleepAfterMin: 5 });
    expect(result.you).toMatchObject({ subagents: null, background: null });
  });

  it('потолок выключен: live "5/off"', () => {
    const map = emptyMap();
    const me = addActive(map);
    expect(report(map, me, factsOf({ live: 5, limit: null })).machine?.live).toBe('5/off');
  });

  it('workspace: живые с резервом, спящие, очередь, запуски за час, новые за сутки, письма за час', () => {
    const map = emptyMap();
    const me = addActive(map);
    addActive(map);
    addActive(map);
    const reserved = addSession(map, { provider: 'claude', label: 'p', task: 't' }).id;
    addSleeping(map);
    const waiting = addSleeping(map);
    map.sessions.find((session) => session.id === waiting)!.queued = queuedLaunch();
    const pending = addSession(map, { provider: 'claude', label: 'q', task: 't' });
    pending.queued = queuedLaunch();
    const closed = addActive(map);
    transitionSession(map, closed, 'closed');
    map.sessions.find((session) => session.id === closed)!.queued = queuedLaunch();

    withAttempts(
      map,
      [
        attempt({ session: me }),
        attempt({ session: me, kind: 'retry' }),
        attempt({ session: reserved, state: 'reserved' }),
        attempt({ session: me, at: iso(NOW - RESOURCE_WINDOW_MS - 1) }),
      ],
      Array.from({ length: 5 }, () => ({ kind: 'session' as const, room: null })),
    );
    for (let i = 0; i < 7; i += 1) addMessage(map, { from: me, to: ['human'], text: 'x' }, iso(NOW - 1000));
    addMessage(map, { from: 'human', to: [me], text: 'x' }, iso(NOW - 1000));
    addMessage(map, { from: me, to: ['human'], text: 'old' }, iso(NOW - RESOURCE_WINDOW_MS - 1));

    const result = report(map, me, null);
    expect(result.workspace).toEqual({
      live: '4/24', asleep: 1, queued: 2, launchesHour: '3/60', newSessionsDay: '5/50', messagesHour: '7/200',
    });

    // Те же числа даёт бюджет: модуль не считает по-своему.
    const status = resourceStatus(map, limits(), NOW, null);
    expect(status.work.concurrent.used + status.work.concurrent.reserved).toBe(4);
    expect(status.work.launches.used + status.work.launches.reserved).toBe(3);
    expect(status.work.newSessions.used).toBe(5);
    expect(status.work.messages.used).toBe(7);
  });

  it('room только в комнате', () => {
    const map = emptyMap();
    const me = addActive(map);
    const mate = addActive(map);
    addActive(map);
    expect(report(map, me, null).room).toBeNull();

    const room = addRoom(map, { title: 'r', creator: me, members: [me, mate] });
    withAttempts(map, [
      attempt({ session: me, room: room.id }),
      attempt({ session: mate, room: room.id }),
      attempt({ session: me, room: null }),
    ]);
    expect(report(map, me, null).room).toEqual({ id: room.id, live: '2/12', launchesHour: '2/20' });
    // Сессия вне комнаты комнаты не видит.
    const outsider = map.sessions[2]!.id;
    expect(report(map, outsider, null).room).toBeNull();
  });

  it('swarm только в незавершённом рое; minutesLeft по swarmMinutes, 0 даёт null', () => {
    const map = emptyMap();
    const ids = [addActive(map), addActive(map), addActive(map), addActive(map)];
    const outsider = addActive(map);
    const swarm = swarmOf(ids);
    map.swarms = [swarm];

    expect(report(map, ids[1]!, null).swarm).toEqual({ id: 'sw-01', live: '4/8', members: '4/16', minutesLeft: 60 });
    expect(report(map, outsider, null).swarm).toBeNull();
    expect(report(map, null, null).swarm).toBeNull();
    // swarmMinutes 0 — срока нет.
    expect(report(map, ids[0]!, null, { swarmMinutes: 0 }).swarm?.minutesLeft).toBeNull();
    // Срок вышел — не меньше нуля; неполная минута округляется вверх.
    expect(report(map, ids[0]!, null, { swarmMinutes: 20 }).swarm?.minutesLeft).toBe(0);
    swarm.createdAt = iso(NOW - 89 * MINUTE - 1000);
    expect(report(map, ids[0]!, null).swarm?.minutesLeft).toBe(1);
    // Завершённый рой — null.
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      swarm.status = status;
      expect(report(map, ids[0]!, null).swarm).toBeNull();
    }
  });

  it('you: подсессии по createdBy, закрытые не в счёт; wakesHour считает только подъёмы письмом за час без windowFree', () => {
    const map = emptyMap();
    const me = addActive(map);
    const other = addActive(map);
    addActive(map, { createdBy: me });
    addSession(map, { provider: 'claude', label: 'p', task: 't', createdBy: me });
    addSleeping(map, { createdBy: me });
    const waiting = addSleeping(map, { createdBy: me });
    map.sessions.find((session) => session.id === waiting)!.queued = queuedLaunch();
    const gone = addActive(map, { createdBy: me });
    transitionSession(map, gone, 'closed');
    addActive(map, { createdBy: other });
    map.sessions.find((session) => session.id === me)!.keepAwake = true;

    withAttempts(map, [
      attempt({ session: me, kind: 'resume', actor: 'wake' }),
      attempt({ session: me, kind: 'resume', actor: 'wake', state: 'reserved' }),
      attempt({ session: me, kind: 'resume', actor: 'wake', windowFree: true }),
      attempt({ session: me, kind: 'resume', actor: 'wake', state: 'released' }),
      attempt({ session: me, kind: 'resume', actor: 'wake', at: iso(NOW - RESOURCE_WINDOW_MS - 1) }),
      attempt({ session: other, kind: 'resume', actor: 'wake' }),
      attempt({ session: me, kind: 'resume', actor: 'human' }),
      attempt({ session: me, kind: 'spawn', actor: 'wake' }),
    ]);

    const result = report(map, me, factsOf({}, { subagents: 2, background: [] }));
    expect(result.you).toEqual({
      children: { running: 2, asleep: 1, queued: 1 },
      subagents: 2,
      background: {},
      wakesHour: '2/6',
      keepAwake: true,
    });
  });

  it('you: null без сессии и для сессии, которой нет в карте', () => {
    const map = emptyMap();
    addActive(map);
    expect(report(map, null, null).you).toBeNull();
    expect(report(map, 'нет-такой', null).you).toBeNull();
  });

  it('background: виды без subagent', () => {
    const map = emptyMap();
    const me = addActive(map);
    const result = report(map, me, factsOf({}, { subagents: 1, background: ['shell', 'shell', 'monitor', 'subagent'] }));
    expect(result.you?.background).toEqual({ shell: 2, monitor: 1 });
    expect(result.you?.subagents).toBe(1);
  });

  describe('canStart и limitedBy', () => {
    const base = (): { map: WindowWorkMap; me: string } => {
      const map = emptyMap();
      const me = addActive(map);
      addActive(map);
      addActive(map);
      return { map, me };
    };

    const rows: {
      name: string;
      machine: Partial<MachineCapacity> | null;
      limits?: Partial<ResourceLimits>;
      canStart: number;
      limitedBy: CapacityReport['limitedBy'];
      hint: string;
    }[] = [
      {
        name: 'потолок 18, живых 16, работа даёт 5',
        machine: { live: 16, limit: 18 }, limits: { workConcurrent: 8 },
        canStart: 2, limitedBy: 'machine', hint: '2 more can start now; further sessions will queue.',
      },
      {
        name: 'остаток workConcurrent 0',
        machine: { live: 3, limit: 18 }, limits: { workConcurrent: 3 },
        canStart: 0, limitedBy: 'workConcurrent',
        hint: 'workConcurrent is used up: new sessions are refused. Wait, or ask the human to raise it in Settings.',
      },
      {
        name: 'давление critical',
        machine: { live: 3, limit: 18, pressure: 'critical' },
        canStart: 0, limitedBy: 'memory', hint: 'Memory is critical: new sessions queue until it eases.',
      },
      {
        name: 'очередь 3',
        machine: { live: 3, limit: 18, queued: 3 },
        canStart: 0, limitedBy: 'queue', hint: 'Launches are waiting for a slot (3): new sessions queue behind them.',
      },
      {
        name: 'машина у потолка',
        machine: { live: 18, limit: 18 },
        canStart: 0, limitedBy: 'machine',
        hint: 'The machine is at its limit (18/18): new sessions queue and start when a slot frees.',
      },
      {
        name: 'потолок выключен: упирается порог бюджета',
        machine: { live: 3, limit: null }, limits: { workConcurrent: 8 },
        canStart: 5, limitedBy: 'workConcurrent', hint: '5 more can start now; after that workConcurrent refuses new sessions.',
      },
      {
        name: 'ничья: машина 2 и workConcurrent 2 — бюджет первым',
        machine: { live: 16, limit: 18 }, limits: { workConcurrent: 5 },
        canStart: 2, limitedBy: 'workConcurrent', hint: '2 more can start now; after that workConcurrent refuses new sessions.',
      },
      {
        name: 'бюджет и память по нулям: бюджет первым',
        machine: { live: 3, limit: 18, pressure: 'critical', queued: 2 }, limits: { workLaunches: 0 },
        canStart: 0, limitedBy: 'workLaunches',
        hint: 'workLaunches is used up: new sessions are refused. Wait, or ask the human to raise it in Settings.',
      },
      {
        name: 'память раньше очереди и машины',
        machine: { live: 18, limit: 18, pressure: 'critical', queued: 2 },
        canStart: 0, limitedBy: 'memory', hint: 'Memory is critical: new sessions queue until it eases.',
      },
      {
        name: 'очередь раньше машины',
        machine: { live: 18, limit: 18, queued: 2 },
        canStart: 0, limitedBy: 'queue', hint: 'Launches are waiting for a slot (2): new sessions queue behind them.',
      },
      {
        name: 'давление warn и unknown не мешают',
        machine: { live: 3, limit: 18, pressure: 'warn' }, limits: { workConcurrent: 8 },
        canStart: 5, limitedBy: 'workConcurrent', hint: '5 more can start now; after that workConcurrent refuses new sessions.',
      },
      {
        name: 'без хоста память и очередь не видны',
        machine: null, limits: { workNewSessions: 0 },
        canStart: 0, limitedBy: 'workNewSessions',
        hint: 'workNewSessions is used up: new sessions are refused. Wait, or ask the human to raise it in Settings.',
      },
    ];

    for (const row of rows) {
      it(row.name, () => {
        const { map, me } = base();
        const facts = row.machine === null ? null : factsOf(row.machine);
        const result = report(map, me, facts, row.limits);
        expect({ canStart: result.canStart, limitedBy: result.limitedBy, hint: result.hint }).toEqual({
          canStart: row.canStart, limitedBy: row.limitedBy, hint: row.hint,
        });
      });
    }

    it('комната: остаток комнаты меньше — roomConcurrent; при ничьей с работой — работа', () => {
      const { map, me } = base();
      addRoom(map, { title: 'r', creator: me, members: [me, map.sessions[1]!.id] });
      const tight = report(map, me, null, { roomConcurrent: 4 });
      expect(tight).toMatchObject({ canStart: 2, limitedBy: 'roomConcurrent' });
      expect(tight.hint).toBe('2 more can start now; after that roomConcurrent refuses new sessions.');
      // Остаток работы тоже 2: ничья, работа идёт раньше комнаты.
      expect(report(map, me, null, { roomConcurrent: 4, workConcurrent: 5 })).toMatchObject({ canStart: 2, limitedBy: 'workConcurrent' });
    });
  });

  it('machine: только числа, без имён и путей', () => {
    const map = emptyMap();
    const secret = addSession(map, { provider: 'claude', label: 'СЕКРЕТНЫЙ-ПРОЕКТ', task: '/Users/someone/private' });
    transitionSession(map, secret.id, 'active');
    const result = report(map, secret.id, factsOf({ live: 4, limit: 18, queued: 1, pressure: 'warn', swapGb: 2, sleepMinutes: 5 }));
    expect(Object.keys(result.machine!).sort()).toEqual(['live', 'memory', 'queued', 'sleepAfterMin', 'swapGb']);
    expect(JSON.stringify(result)).not.toContain('СЕКРЕТНЫЙ');
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });
});

describe('swarmBusy', () => {
  it('тот же подсчёт, что у checkSwarmSpawn: живые и заказанные, сдавший, закрытый и чужой — нет', () => {
    const map = emptyMap();
    const ids = [addActive(map), addActive(map), addActive(map)];
    const closed = addActive(map);
    transitionSession(map, closed, 'closed');
    const ordered = addSession(map, { provider: 'claude', label: 'p', task: 't' }).id;
    const handed = addActive(map);
    addActive(map);
    const swarm = swarmOf([...ids, closed, ordered, handed]);
    swarm.members.find((member) => member.sessionId === handed)!.handedAt = AT;
    map.swarms = [swarm];

    expect(swarmBusy(map, swarm)).toBe(4);
    expect(checkSwarmSpawn(map, limits({ swarmConcurrent: 4 }), { swarm, creatingSwarm: false, byAgent: false }))
      .toMatchObject({ code: 'swarm-concurrent', used: 4, limit: 4 });
    expect(checkSwarmSpawn(map, limits({ swarmConcurrent: 5 }), { swarm, creatingSwarm: false, byAgent: false })).toBeNull();
  });
});
