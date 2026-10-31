/**
 * Числа ёмкости (спека сна и ёмкости 2026-10-30, 4.3 и 4.5): сколько агентов живо на машине и в работе, сколько ждёт в
 * очереди, какие пороги действуют и сколько из них израсходовано. Модуль чистый: хост даёт снимок машины, карта — всё
 * остальное. Считает одно место, показывают двое: окно (сегмент строки состояния) и агент (`get_capacity`).
 */

import {
  RESOURCE_WINDOW_MS,
  resourceStatus,
  roomOfSession,
  swarmBusy,
  type Meter,
  type ResourceLimits,
} from './resource-policy.js';
import { isSwarmTerminal, swarmDeadline, swarmOfSession } from './swarms.js';
import type { MemoryPressure, WindowWorkMap } from './types.js';

export interface MachineInput {
  /** `CapacityService.occupied()`: живые CLI хоста и запуски с резервом. */
  occupied: number;
  /** `machineLimit(machineConcurrent, totalmem)`; `null` — потолок выключен. */
  limit: number | null;
  /** `CapacityService.queue().length`. */
  queued: number;
  pressure: MemoryPressure;
  swapGb: number | null;
  sleepAfterMinutes: number;
  sleepUnderPressureMinutes: number;
}

export interface MachineCapacity {
  live: number;
  limit: number | null;
  queued: number;
  pressure: MemoryPressure;
  /** Одна цифра после запятой. */
  swapGb: number | null;
  /** Действующий порог сна; `null` — сон выключен. */
  sleepMinutes: number | null;
}

/**
 * Числа машины. Порог сна — как у сервиса сна: при давлении `warn`/`critical` (сон по давлению) или непустой очереди
 * (сон ради слота) действует меньший из двух порогов, иначе обычный; `sleepAfterMinutes` = 0 выключает сон совсем.
 */
export function machineCapacity(input: MachineInput): MachineCapacity {
  const hurry = input.pressure === 'warn' || input.pressure === 'critical' || input.queued > 0;
  const sleepMinutes = input.sleepAfterMinutes === 0
    ? null
    : hurry ? Math.min(input.sleepAfterMinutes, input.sleepUnderPressureMinutes) : input.sleepAfterMinutes;
  return {
    live: input.occupied,
    limit: input.limit,
    queued: input.queued,
    pressure: input.pressure,
    swapGb: input.swapGb === null ? null : Math.round(input.swapGb * 10) / 10,
    sleepMinutes,
  };
}

export interface CapacityFacts {
  machine: MachineCapacity;
  /** Активность вызывающей сессии у хоста; `null` — хост её не знает. */
  activity: { subagents: number; background: readonly string[] } | null;
}

export type CapacityLimit =
  | 'workConcurrent' | 'workLaunches' | 'workNewSessions'
  | 'roomConcurrent' | 'roomLaunches' | 'roomNewSessions'
  | 'memory' | 'queue' | 'machine';

export interface CapacityReport {
  machine: { live: string; queued: number; memory: MemoryPressure; swapGb: number | null; sleepAfterMin: number | null } | null;
  workspace: { live: string; asleep: number; queued: number; launchesHour: string; newSessionsDay: string; messagesHour: string };
  room: { id: string; live: string; launchesHour: string } | null;
  swarm: { id: string; live: string; members: string; minutesLeft: number | null } | null;
  you: {
    children: { running: number; asleep: number; queued: number };
    subagents: number | null;
    background: Record<string, number> | null;
    wakesHour: string;
    keepAwake: boolean;
  } | null;
  canStart: number;
  limitedBy: CapacityLimit;
  hint: string;
}

export interface CapacityReportInput {
  /** Карта с письмами: «письма за час» считаются по ним. */
  map: WindowWorkMap;
  sessionId: string | null;
  limits: ResourceLimits;
  resumeRate: number;
  facts: CapacityFacts | null;
  now: number;
}

/** Занято заранее и использовано: «живые с резервом» и «запуски с резервом». */
const held = (meter: Meter): string => `${meter.used + meter.reserved}/${meter.limit}`;
const usedOf = (meter: Meter): string => `${meter.used}/${meter.limit}`;

function childrenOf(map: WindowWorkMap, sessionId: string): { running: number; asleep: number; queued: number } {
  const children = { running: 0, asleep: 0, queued: 0 };
  for (const session of map.sessions) {
    if (session.createdBy !== sessionId || session.lifecycle === 'closed') continue;
    if (session.queued != null) children.queued += 1;
    else if (session.lifecycle === 'active' || session.lifecycle === 'pending') children.running += 1;
    else children.asleep += 1;
  }
  return children;
}

/** Подъёмы сессии письмом за час: тот же отбор, что у окна запусков в бюджете (без `windowFree` и отменённых). */
function wakesInHour(map: WindowWorkMap, sessionId: string, now: number): number {
  return (map.resources?.attempts ?? []).filter(
    (attempt) =>
      attempt.actor === 'wake' && attempt.session === sessionId && attempt.kind !== 'spawn' && attempt.windowFree !== true &&
      attempt.state !== 'released' && now - Date.parse(attempt.at) < RESOURCE_WINDOW_MS,
  ).length;
}

function backgroundByKind(tasks: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of tasks) if (kind !== 'subagent') counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

function hintFor(canStart: number, limitedBy: CapacityLimit, facts: CapacityFacts | null): string {
  if (canStart > 0) {
    return limitedBy === 'machine'
      ? `${canStart} more can start now; further sessions will queue.`
      : `${canStart} more can start now; after that ${limitedBy} refuses new sessions.`;
  }
  const machine = facts?.machine;
  if (limitedBy === 'memory') return 'Memory is critical: new sessions queue until it eases.';
  if (limitedBy === 'queue') return `Launches are waiting for a slot (${machine?.queued ?? 0}): new sessions queue behind them.`;
  if (limitedBy === 'machine') {
    return `The machine is at its limit (${machine?.live ?? 0}/${machine?.limit ?? 'off'}): new sessions queue and start when a slot frees.`;
  }
  return `${limitedBy} is used up: new sessions are refused. Wait, or ask the human to raise it in Settings.`;
}

/**
 * Ответ `get_capacity`. Бюджет работы и комнаты — из `resourceStatus`, машина и активность сессии — из снимка хоста
 * (`facts`); без него (сессия без канала) `machine`, `subagents` и `background` — `null`, а `canStart` считается по
 * бюджету. По чужим проектам в ответе только числа машины.
 */
export function capacityReport(input: CapacityReportInput): CapacityReport {
  const { map, sessionId, limits, facts, now } = input;
  const roomId = sessionId === null ? null : roomOfSession(map, sessionId);
  const status = resourceStatus(map, limits, now, roomId);
  const machine = facts?.machine ?? null;

  const open = map.sessions.filter((session) => session.lifecycle !== 'closed');
  const workspace = {
    live: held(status.work.concurrent),
    asleep: open.filter((session) => session.lifecycle === 'sleeping' && session.queued == null).length,
    queued: open.filter((session) => session.queued != null).length,
    launchesHour: held(status.work.launches),
    newSessionsDay: usedOf(status.work.newSessions),
    messagesHour: usedOf(status.work.messages),
  };

  const room = roomId === null || status.room === null
    ? null
    : { id: roomId, live: held(status.room.concurrent), launchesHour: held(status.room.launches) };

  const membership = sessionId === null ? null : swarmOfSession(map, sessionId);
  let swarm: CapacityReport['swarm'] = null;
  if (membership !== null && !isSwarmTerminal(membership.swarm.status)) {
    const deadline = swarmDeadline(membership.swarm, limits);
    swarm = {
      id: membership.swarm.id,
      live: `${swarmBusy(map, membership.swarm)}/${limits.swarmConcurrent}`,
      members: `${membership.swarm.members.length}/${limits.swarmSessions}`,
      minutesLeft: deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 60_000)),
    };
  }

  const self = sessionId === null ? undefined : map.sessions.find((session) => session.id === sessionId);
  const activity = facts?.activity ?? null;
  const you = sessionId === null || self === undefined
    ? null
    : {
        children: childrenOf(map, sessionId),
        subagents: activity === null ? null : activity.subagents,
        background: activity === null ? null : backgroundByKind(activity.background),
        wakesHour: `${wakesInHour(map, sessionId, now)}/${input.resumeRate}`,
        keepAwake: self.keepAwake === true,
      };

  // Кандидаты по порядку спеки: бюджет раньше допуска машины, потому что `launch()` проверяет его первым.
  const candidates: [CapacityLimit, number][] = [
    ['workConcurrent', status.work.concurrent.remaining],
    ['workLaunches', status.work.launches.remaining],
    ['workNewSessions', status.work.newSessions.remaining],
  ];
  if (status.room !== null) {
    candidates.push(
      ['roomConcurrent', status.room.concurrent.remaining],
      ['roomLaunches', status.room.launches.remaining],
      ['roomNewSessions', status.room.newSessions.remaining],
    );
  }
  if (machine !== null) {
    if (machine.pressure === 'critical') candidates.push(['memory', 0]);
    if (machine.queued > 0) candidates.push(['queue', 0]);
    if (machine.limit !== null) candidates.push(['machine', Math.max(0, machine.limit - machine.live)]);
  }
  let [limitedBy, canStart] = candidates[0]!;
  for (const [name, remaining] of candidates) {
    if (remaining < canStart) {
      limitedBy = name;
      canStart = remaining;
    }
  }

  return {
    machine: machine === null
      ? null
      : {
          live: `${machine.live}/${machine.limit ?? 'off'}`,
          queued: machine.queued,
          memory: machine.pressure,
          swapGb: machine.swapGb,
          sleepAfterMin: machine.sleepMinutes,
        },
    workspace,
    room,
    swarm,
    you,
    canStart,
    limitedBy,
    hint: hintFor(canStart, limitedBy, facts),
  };
}
