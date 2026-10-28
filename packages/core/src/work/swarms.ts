/**
 * Рой (спека роя v1, раздел 2): группа сессий под одной сессией-королевой для больших исследовательских задач.
 * Запись лежит в `WorkMap.swarms` рядом с `rooms` и `plans`.
 *
 * Модуль чистый и без значений из других файлов core (типы стираются при сборке), поэтому его берёт и окно через подпуть
 * `@parley/core/swarms`, как `@parley/core/session-state`. Имя сущности с префиксом `Work`: голые `Swarm` / `createSwarm`
 * принадлежат анимации острова (спека роя, 2.3).
 */

import type { ResourceLimits } from './resource-policy.js';
import type { SessionAxes } from './session-state.js';
import type { WorkMap } from './types.js';

export const SWARM_STATUSES = ['running', 'collecting', 'done', 'failed', 'cancelled'] as const;
export type SwarmStatus = (typeof SWARM_STATUSES)[number];

export const SWARM_ROLES = ['queen', 'drone', 'verifier'] as const;
export type SwarmRole = (typeof SWARM_ROLES)[number];

/** Кто завёл рой: сессия агента, комната (её ведущий) или человек. От этого зависит, куда уходит итог. */
export type SwarmCreator =
  | { kind: 'session'; sessionId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'human' };

export interface WorkSwarmMember {
  sessionId: string;
  role: SwarmRole;
  /** Номер среди своей роли: «Трутень 2»; у королевы 1. */
  n: number;
  addedAt: string;
  /** Сдал (done-report принят хостом); трутни и проверяющие. */
  handedAt: string | null;
}

export interface WorkSwarm {
  /** `sw-01`; счётчик `Work.swarmSeq`, id не переиспользуется (как `roomSeq`). */
  id: string;
  /** `Research`, `Аудит`, `Отладка` или свой текст; задаёт создатель. */
  tag: string;
  creator: SwarmCreator;
  objective: string;
  /** Сессия королевы; она же первый элемент `members`. */
  queen: string;
  members: WorkSwarmMember[];
  status: SwarmStatus;
  createdAt: string;
  /** Таймер в окне считает `createdAt` → `endedAt ?? now`. */
  endedAt: string | null;
  result: { summary: string; at: string; deliveredAt: string | null } | null;
  /** Причина `failed` / `cancelled`. */
  failure: string | null;
  /** Человек увидел итог (карточка в окне). */
  seenAt: string | null;
  /** Когда хост закрыл рой по сроку жизни (`swarmMinutes`); `null` — по сроку не закрывался. */
  expiredAt: string | null;
}

/** Пределы текстов роя: задача (`objective`) и итог (`result.summary`). */
export const SWARM_OBJECTIVE_MAX = 4096;
export const SWARM_SUMMARY_MAX = 4096;
/** Длина тега: 1–24 знака. */
export const SWARM_TAG_MAX = 24;

/** Тег роя годится: строка 1–24 знака без переводов строки. */
export const isSwarmTag = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= SWARM_TAG_MAX && !/[\r\n]/.test(value);

/** Рой закончил: `endedAt` стоит, таймер встал, живых трутней и проверяющих закрывает хост. */
export const isSwarmTerminal = (status: SwarmStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled';

/** Срок жизни роя в миллисекундах от `createdAt`; `null` — срока нет (`swarmMinutes` = 0). */
export function swarmDeadline(swarm: Pick<WorkSwarm, 'createdAt'>, limits: Pick<ResourceLimits, 'swarmMinutes'>): number | null {
  return limits.swarmMinutes === 0 ? null : Date.parse(swarm.createdAt) + limits.swarmMinutes * 60_000;
}

/** Рой ещё идёт, а срок жизни вышел: хост закрывает такой рой (`expiredAt`). */
export function isSwarmExpired(swarm: WorkSwarm, limits: Pick<ResourceLimits, 'swarmMinutes'>, nowMs: number): boolean {
  const deadline = swarmDeadline(swarm, limits);
  return deadline !== null && !isSwarmTerminal(swarm.status) && nowMs >= deadline;
}

export type SwarmMemberState = 'handed' | 'closed' | 'failed' | 'waiting' | 'working';

/**
 * Состояние участника для окна (спека роя, 2). Порядок важен: сдавший остаётся сдавшим, даже если рой потом отменён
 * и сессию закрыл хост; несдавший участник отменённого или упавшего роя — `closed`, а не `failed`.
 */
export function memberState(swarm: WorkSwarm, member: WorkSwarmMember, session: SessionAxes | undefined): SwarmMemberState {
  if (member.handedAt !== null) return 'handed';
  if (swarm.status === 'failed' || swarm.status === 'cancelled') return 'closed';
  if (session === undefined || session.result === 'failed' || session.lifecycle === 'closed') return 'failed';
  if (session.lifecycle === 'pending') return 'waiting';
  return 'working';
}

/** Все сессии роёв работы, королев включая: их сайдбар и остров не выводят обычными строками. */
export function swarmMemberIds(map: Pick<WorkMap, 'swarms'>): Set<string> {
  const ids = new Set<string>();
  for (const swarm of map.swarms ?? []) for (const member of swarm.members) ids.add(member.sessionId);
  return ids;
}

/** Рой и запись участника по id сессии; `null` — сессия не в рое. */
export function swarmOfSession(
  map: Pick<WorkMap, 'swarms'>,
  sessionId: string,
): { swarm: WorkSwarm; member: WorkSwarmMember } | null {
  for (const swarm of map.swarms ?? []) {
    const member = swarm.members.find((candidate) => candidate.sessionId === sessionId);
    if (member !== undefined) return { swarm, member };
  }
  return null;
}

/** Счётчик `3/5`: сдавшие и все трутни с проверяющими; королева не считается. */
export function swarmProgress(swarm: WorkSwarm): { handed: number; total: number } {
  const workers = swarm.members.filter((member) => member.role !== 'queen');
  return { handed: workers.filter((member) => member.handedAt !== null).length, total: workers.length };
}
