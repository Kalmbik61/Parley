/**
 * Чистые функции показа роя в окне (спека роя v1, раздел 7): таймер, порядок и слова участников, значки карточки и
 * группы, видимость роя в сайдбаре. Состояние участника считает core (`memberState`), здесь — только то, что нужно
 * показу. Без React и без стора: тесты кормят их картой.
 */

import type { WindowWorkMap, WorkSession, WorkSwarm, WorkSwarmMember } from '@parley/core';
import { isSwarmTerminal, memberState, swarmProgress, type SwarmMemberState } from '@parley/core/swarms';
import { S } from '../../shared/strings.js';
import { isoMs } from './iso-time.js';

/** Сколько миллисекунд рой идёт: `createdAt` → `endedAt ?? now`; битая дата — 0. */
export function swarmElapsedMs(swarm: Pick<WorkSwarm, 'createdAt' | 'endedAt'>, nowMs: number): number {
  const start = isoMs(swarm.createdAt);
  if (start === null) return 0;
  const end = swarm.endedAt === null ? nowMs : (isoMs(swarm.endedAt) ?? nowMs);
  return Math.max(0, end - start);
}

/** `4:12`; от часа — `1:05:09`. */
export function formatSwarmTimer(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * Рой виден на карточке: идущий; законченный `done`/`failed`, пока человек не видел итог; остальные законченные
 * (и просмотренные) — только при раскрытых закрытых («N more closed»).
 */
export function isSwarmShown(swarm: WorkSwarm, showClosed: boolean): boolean {
  if (!isSwarmTerminal(swarm.status)) return true;
  if (showClosed) return true;
  return (swarm.status === 'done' || swarm.status === 'failed') && swarm.seenAt === null;
}

const ROLE_RANK = { queen: 0, drone: 1, verifier: 2 } as const;

export interface SwarmMemberView {
  member: WorkSwarmMember;
  /** Сессия участника; `null` — её удалили из карты (запись участника остаётся, счётчик не прыгает). */
  session: WorkSession | null;
  state: SwarmMemberState;
}

/** Участники роя для раскрытой строки: королева, трутни по номеру, проверяющие по номеру. */
export function swarmMemberViews(swarm: WorkSwarm, sessions: readonly WorkSession[]): SwarmMemberView[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return [...swarm.members]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.n - b.n)
    .map((member) => {
      const session = byId.get(member.sessionId) ?? null;
      return { member, session, state: memberState(swarm, member, session ?? undefined) };
    });
}

/** Точки строки роя: по одной на трутня и проверяющего; залита сдавшая, крест — упавшая. */
export function swarmDots(views: readonly SwarmMemberView[]): Array<'handed' | 'failed' | 'open'> {
  return views
    .filter((view) => view.member.role !== 'queen')
    .map((view) => (view.state === 'handed' ? 'handed' : view.state === 'failed' ? 'failed' : 'open'));
}

/** Название участника: `Queen`, `Drone 2`, `Verifier`. */
export function memberTitle(member: Pick<WorkSwarmMember, 'role' | 'n'>): string {
  return member.role === 'queen' ? S.workSwarm.role.queen : member.role === 'drone' ? S.workSwarm.role.drone(member.n) : S.workSwarm.role.verifier;
}

/**
 * Слово состояния участника. Королева: текст выводится из роя (режет задачу, ждёт сдачи, сводит, сдала), а у
 * законченного роя без сдачи — как у любого участника; трутень и проверяющий — по `memberState` и роли.
 */
export function memberWord(swarm: WorkSwarm, view: SwarmMemberView): string {
  const text = S.workSwarm;
  if (view.member.role === 'queen') {
    if (swarm.status === 'done') return text.queen.handed;
    if (swarm.status === 'failed' || swarm.status === 'cancelled') return text.status[swarm.status];
    if (view.state === 'failed') return text.member.failed;
    if (view.state === 'waiting') return text.member.waiting;
    if (swarm.status === 'collecting') return text.queen.collecting;
    return swarm.members.some((member) => member.role !== 'queen') ? text.queen.waiting : text.queen.cutting;
  }
  switch (view.state) {
    case 'handed':
      return text.member.handed;
    case 'failed':
      return text.member.failed;
    case 'closed':
      return text.member.closed;
    case 'waiting':
      return text.member.waiting;
    default:
      return view.member.role === 'drone' ? text.member.drone : text.member.verifier;
  }
}

/** Значки карточки работы и группы проекта: идущие рои и законченные с непросмотренным итогом. */
export function swarmBadge(map: Pick<WindowWorkMap, 'swarms'>): { active: number; ready: number } {
  let active = 0;
  let ready = 0;
  for (const swarm of map.swarms ?? []) {
    if (!isSwarmTerminal(swarm.status)) active += 1;
    else if ((swarm.status === 'done' || swarm.status === 'failed') && swarm.seenAt === null) ready += 1;
  }
  return { active, ready };
}

/** Счётчик роя `3/5`; до первого трутня — `…`. */
export function swarmCounter(swarm: WorkSwarm): string {
  const { handed, total } = swarmProgress(swarm);
  return S.workSwarm.counter(handed, total);
}

/**
 * Что показывает значок роя на карточке и в группе: идущие рои (`🐝 N`) или, когда их нет, готовый непросмотренный
 * итог (`🐝✓`); `null` — значка нет.
 */
export function swarmBadgeView(badge: { active: number; ready: number }): { status: 'running' | 'done'; count: number | null; title: string } | null {
  if (badge.active > 0) return { status: 'running', count: badge.active, title: S.workSwarm.activeSwarms(badge.active) };
  if (badge.ready > 0) return { status: 'done', count: null, title: S.workSwarm.readySwarms(badge.ready) };
  return null;
}
