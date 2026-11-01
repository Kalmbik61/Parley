/**
 * Фикстуры работ и сессий для тестов сайдбара карточек (кусок 3.3): одна форма
 * `WorkSession`/`WindowWorkEntry` на все его тесты вместо копии в каждом файле.
 */

import type { Activity, Message, NeedKind, Room, SessionNeed, WindowWorkEntry, WorkSession, WorkStatus, WorkSwarm, WorkSwarmMember } from '@parley/core';
import { refKey, type LiveMetrics, type RoomsMailEvent, type RoomsMailRoom, type SessionRef } from '@parley/protocol';
import type { ActivityEntry } from '../store/activity.js';

export function makeSession(id: string, label: string, patch: Partial<WorkSession> = {}): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
    ...patch,
  };
}

export interface WorkOptions {
  projectPath?: string;
  title?: string;
  status?: WorkStatus;
  createdAt?: string;
  sessions?: WorkSession[];
  messages?: Message[];
  rooms?: Room[];
  swarms?: WorkSwarm[];
}

export function makeWork(id: string, options: WorkOptions = {}): WindowWorkEntry {
  const createdAt = options.createdAt ?? '2026-09-27T08:00:00.000Z';
  return {
    projectPath: options.projectPath ?? '/tmp/proj',
    map: {
      schemaVersion: 2,
      work: { id, title: options.title ?? id, goal: '', status: options.status ?? 'active', createdAt, updatedAt: createdAt },
      sessions: options.sessions ?? [],
      messages: options.messages ?? [],
      rooms: options.rooms ?? [],
      ...(options.swarms === undefined ? {} : { swarms: options.swarms }),
    },
  };
}

/** Письмо: по умолчанию — прямое письмо человеку от s-01, не прочитанное. */
export function makeLetter(id: string, patch: Partial<Message> = {}): Message {
  return {
    id,
    roomId: null,
    from: 's-01',
    to: ['human'],
    at: '2026-09-27T09:00:00.000Z',
    text: 'text',
    kind: 'note',
    readBy: {},
    ...patch,
  };
}

export function makeRoom(id: string, title: string): Room {
  return { id, title, creator: 'human', ownerId: null, members: [], createdAt: '2026-09-27T08:00:00.000Z', lead: null, proposal: null };
}

/** Живая активность сессии для `useActivityStore.byRef` (ключ — `refKey(ref)`). */
export function makeActivity(
  ref: SessionRef,
  activity: Activity,
  patch: {
    lastEventAt?: string | null;
    turnEndedAt?: string | null;
    metrics?: LiveMetrics | null;
    heldByBackground?: boolean;
    /** Чего сессия ждёт от человека (спека застрявших 3.1); по умолчанию ничего. */
    need?: SessionNeed | null;
  } = {},
): ActivityEntry {
  return {
    ref,
    activity: {
      activity,
      subagents: 0,
      tasks: [],
      waitingFor: null,
      heldByBackground: patch.heldByBackground ?? false,
      runningBackground: [],
      turnEndedAt: patch.turnEndedAt ?? null,
      turnBoundaryAt: null,
      lastEventAt: patch.lastEventAt === undefined ? '2026-09-27T09:00:00.000Z' : patch.lastEventAt,
      source: 'hooks',
      hooksMissing: false,
      need: patch.need ?? null,
    },
    metrics: patch.metrics ?? null,
  };
}

/** Потребность сессии (спека застрявших 3.1): по умолчанию без текста, времени сброса, окна и вида входа. */
export function makeNeed(kind: NeedKind, patch: Partial<SessionNeed> = {}): SessionNeed {
  return { kind, since: '2026-10-21T09:00:00.000Z', detail: null, resetsAt: null, window: null, account: null, ...patch };
}

export function activityMap(entries: ActivityEntry[]): Record<string, ActivityEntry> {
  return Object.fromEntries(entries.map((entry) => [refKey(entry.ref), entry]));
}

/** Комната в событии `rooms.mail` (спека rooms.mail 6.3): по умолчанию пустая, без новых писем и отметок. */
export function makeMailRoom(roomId: string | null, patch: Partial<RoomsMailRoom> = {}): RoomsMailRoom {
  return { roomId, prevTop: 0, top: 0, total: 0, lastAt: null, letters: [], reads: [], deleted: [], ...patch };
}

/** Событие `rooms.mail` работы `w-01` проекта `/tmp/proj`; версии обязательны — по ним окно ищет разрыв. */
export function makeMailEvent(patch: Partial<RoomsMailEvent> & Pick<RoomsMailEvent, 'version' | 'prevVersion'>): RoomsMailEvent {
  return {
    projectPath: '/tmp/proj',
    workId: 'w-01',
    updatedAt: '2026-09-27T10:00:00.000Z',
    rooms: [],
    droppedRooms: [],
    unread: { letters: 0, rooms: {} },
    mentionCandidates: [],
    ...patch,
  };
}

/** Участник роя: `role` и номер, `handed` — сдал (иначе работает). */
export function makeSwarmMember(sessionId: string, role: WorkSwarmMember['role'], n = 1, handed = false): WorkSwarmMember {
  return { sessionId, role, n, addedAt: '2026-09-27T08:01:00.000Z', handedAt: handed ? '2026-09-27T08:05:00.000Z' : null };
}

/** Рой: по умолчанию `running`, создатель — человек, королева — первый участник. */
export function makeSwarm(id: string, queen: string, patch: Partial<WorkSwarm> = {}): WorkSwarm {
  return {
    id,
    tag: 'Research',
    creator: { kind: 'human' },
    objective: 'Study the crawlers',
    queen,
    members: [makeSwarmMember(queen, 'queen')],
    status: 'running',
    createdAt: '2026-09-27T08:00:00.000Z',
    endedAt: null,
    result: null,
    failure: null,
    seenAt: null,
    expiredAt: null,
    ...patch,
  };
}
