/**
 * Путь создания: что нужно записать в карту, когда сессия заводится как участник роя (спека роя v1, 3–5). Всё выполняется
 * внутри той же записи карты, что создаёт `pending`-сессию (`createPendingSession`): отказ бросает исключение, и
 * `updateMap` ничего не пишет — ни роя, ни сессии, ни счётчиков.
 */

import {
  checkSwarmSpawn,
  isRoomArchived,
  isSwarmTerminal,
  liveLead,
  noteCreation,
  readMap,
  swarmOfSession,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ResourceDeniedError, ResourceLimits, SwarmCreator, SwarmRole, WorkMap, WorkSession, WorkSwarm } from '@parley/core';
import { HOST_ERROR_REASONS } from '@parley/protocol';
import { HostError } from '../errors.js';
import { memberBrief, queenBrief } from './briefs.js';

/** Внутреннее поле `CreateSessionInput.swarm`: агентский эндпоинт сессий его не принимает, ставит его только путь роя. */
export type SwarmSpawn =
  | { kind: 'create'; tag: string; objective: string }
  | { kind: 'add'; role: 'drone' | 'verifier' };

const ROLE_LABEL = { drone: 'Drone', verifier: 'Verifier' } as const;

/** Имя участника в ответе `swarm_add` и в ярлыке по умолчанию: «Drone 3», «Verifier 1». */
export const memberName = (role: 'drone' | 'verifier' | 'queen', n: number): string => role === 'queen' ? `Queen ${n}` : `${ROLE_LABEL[role]} ${n}`;

/** Следующий id роя: `sw-01`, `sw-02`, … Счётчик — `work.swarmSeq`, id не переиспользуется (как `nextRoomId`). */
function nextSwarmId(map: WorkMap): string {
  const used = (map.swarms ?? []).map((swarm) => Number(/^sw-(\d+)$/.exec(swarm.id)?.[1] ?? 0));
  const next = Math.max(map.work.swarmSeq ?? 0, ...used) + 1;
  map.work.swarmSeq = next;
  return `sw-${String(next).padStart(2, '0')}`;
}

/** Отказ хоста с причиной из протокола: агент видит `reason: message`, окно выбирает по `data.reason` свой текст. */
export const swarmRefusal = (reason: (typeof HOST_ERROR_REASONS)[keyof typeof HOST_ERROR_REASONS], message: string): HostError =>
  new HostError('conflict', message, { reason });

const SWARM_DENIED: readonly string[] = [
  HOST_ERROR_REASONS.swarms,
  HOST_ERROR_REASONS.swarmSessions,
  HOST_ERROR_REASONS.swarmConcurrent,
  HOST_ERROR_REASONS.swarmTotal,
];

/**
 * Отказ порога при создании участника роя. Пороги роёв несут свою причину (`swarms`, `swarm-sessions`, …); общие пороги
 * запуска (`workConcurrent`, `workLaunches`) — как отказ запуска (`refuseLaunch`): `data.code = 'resource-budget'`.
 */
export const swarmBudgetRefusal = (error: ResourceDeniedError): HostError =>
  new HostError('conflict', error.message, {
    ...(SWARM_DENIED.includes(error.code) ? {} : { code: 'resource-budget' }),
    reason: error.code,
    scope: error.scope,
    limit: error.limit,
    used: error.used,
  });

/** Участник роя не создаёт сессий, роёв и не входит в комнаты (спека роя, 4). */
export const swarmMemberRefusal = (sessionId: string, what: string): HostError =>
  swarmRefusal(HOST_ERROR_REASONS.swarmMember, `${sessionId} is a member of a swarm and cannot ${what}.`);

/** Создатель определяет хост: ведущий живой комнаты — комната, иная сессия — сессия, человек — человек. */
function creatorOf(map: WorkMap, caller: WorkSession | undefined): SwarmCreator {
  if (caller === undefined) return { kind: 'human' };
  const room = map.rooms.find((candidate) => !isRoomArchived(candidate) && liveLead(map, candidate) === caller.id);
  return room === undefined ? { kind: 'session', sessionId: caller.id } : { kind: 'room', roomId: room.id };
}

export interface SwarmAdmission {
  spawn: SwarmSpawn;
  /** Вызывающая сессия агента; `undefined` — человек (`swarms.create`, лимиты агентов не тратит). */
  caller: WorkSession | undefined;
  limits: ResourceLimits;
  /** Ярлык, который передал вызывающий; пустой — хост назовёт сам. */
  label: string;
  /** Что написал создатель: `objective` королевы или срез трутня. */
  task: string;
}

/**
 * Проверяет рой и пороги роёв, записывает рой и участника, переименовывает и переписывает задание новой сессии. Общие
 * пороги запуска (`reserveAttempt`) берёт вызывающий следом; ветка роя `spawned` и `spawnedByRoom` не читает и не
 * увеличивает (спека роя, 5).
 */
export function admitSwarmSession(map: WorkMap, session: WorkSession, admission: SwarmAdmission): void {
  const { spawn, caller, limits } = admission;
  const byAgent = caller !== undefined;
  const at = new Date().toISOString();
  const resources = (): NonNullable<WorkMap['resources']> => (map.resources ??= { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [] });

  if (spawn.kind === 'create') {
    if (caller !== undefined && swarmOfSession(map, caller.id) !== null) throw swarmMemberRefusal(caller.id, 'create a swarm');
    const denied = checkSwarmSpawn(map, limits, { swarm: null, creatingSwarm: true, byAgent });
    if (denied !== null) throw denied;
    const id = nextSwarmId(map);
    session.label = `Queen ${id}`;
    session.task = queenBrief({ swarmId: id, tag: spawn.tag, objective: admission.task, minutes: limits.swarmMinutes });
    const swarm: WorkSwarm = {
      id,
      tag: spawn.tag,
      creator: creatorOf(map, caller),
      objective: admission.task,
      queen: session.id,
      members: [{ sessionId: session.id, role: 'queen', n: 1, addedAt: at, handedAt: null }],
      status: 'running',
      createdAt: at,
      endedAt: null,
      result: null,
      failure: null,
      seenAt: null,
      expiredAt: null,
    };
    (map.swarms ??= []).push(swarm);
    if (byAgent) {
      resources().swarmsCreated = (resources().swarmsCreated ?? 0) + 1;
      resources().swarmSpawned = (resources().swarmSpawned ?? 0) + 1;
      noteCreation(map, 'swarm', null);
      noteCreation(map, 'swarm-session', null);
    }
    return;
  }

  const found = caller === undefined ? null : swarmOfSession(map, caller.id);
  if (found === null || found.member.role !== 'queen') {
    throw swarmRefusal(HOST_ERROR_REASONS.notQueen, 'Only the queen of a swarm can add members to it.');
  }
  const { swarm } = found;
  if (isSwarmTerminal(swarm.status)) {
    throw swarmRefusal(HOST_ERROR_REASONS.swarmClosed, `Swarm ${swarm.id} is ${swarm.status}: members cannot be added.`);
  }
  const denied = checkSwarmSpawn(map, limits, { swarm, creatingSwarm: false, byAgent });
  if (denied !== null) throw denied;
  const n = Math.max(0, ...swarm.members.filter((member) => member.role === spawn.role).map((member) => member.n)) + 1;
  if (admission.label.trim() === '') session.label = memberName(spawn.role, n);
  session.task = memberBrief(spawn.role, admission.task);
  swarm.members.push({ sessionId: session.id, role: spawn.role, n, addedAt: at, handedAt: null });
  // Вторая волна (спека, 3): королева добавила участника, пока рой собирал итоги, — рой снова работает.
  if (swarm.status === 'collecting') swarm.status = 'running';
  resources().swarmSpawned = (resources().swarmSpawned ?? 0) + 1;
  noteCreation(map, 'swarm-session', null);
}

/** Рой и номер только что созданного участника — по карте, которую записала та же операция; `undefined` — сессия не в рое. */
export async function swarmMemberOf(ref: SessionRef): Promise<{ swarmId: string; role: SwarmRole; n: number } | undefined> {
  const found = swarmOfSession(await readMap(ref.projectPath, ref.workId), ref.sessionId);
  return found === null ? undefined : { swarmId: found.swarm.id, role: found.member.role, n: found.member.n };
}
