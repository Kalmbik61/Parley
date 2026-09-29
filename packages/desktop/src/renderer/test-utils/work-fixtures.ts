/**
 * Фикстуры работ и сессий для тестов сайдбара карточек (кусок 3.3): одна форма
 * `WorkSession`/`WorkEntry` на все его тесты вместо копии в каждом файле.
 */

import type { Activity, Message, Room, WorkEntry, WorkSession, WorkStatus } from '@harnas/core';
import { refKey, type LiveMetrics, type SessionRef } from '@harnas/protocol';
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
}

export function makeWork(id: string, options: WorkOptions = {}): WorkEntry {
  const createdAt = options.createdAt ?? '2026-09-27T08:00:00.000Z';
  return {
    projectPath: options.projectPath ?? '/tmp/proj',
    map: {
      schemaVersion: 2,
      work: { id, title: options.title ?? id, goal: '', status: options.status ?? 'active', createdAt, updatedAt: createdAt },
      sessions: options.sessions ?? [],
      messages: options.messages ?? [],
      rooms: options.rooms ?? [],
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
  return { id, title, creator: 'human', members: [], createdAt: '2026-09-27T08:00:00.000Z', lead: null, proposal: null };
}

/** Живая активность сессии для `useActivityStore.byRef` (ключ — `refKey(ref)`). */
export function makeActivity(
  ref: SessionRef,
  activity: Activity,
  patch: { lastEventAt?: string | null; metrics?: LiveMetrics | null } = {},
): ActivityEntry {
  return {
    ref,
    activity: {
      activity,
      subagents: 0,
      turnEndedAt: null,
      lastEventAt: patch.lastEventAt ?? '2026-09-27T09:00:00.000Z',
      source: 'hooks',
      exited: false,
      hooksMissing: false,
    },
    metrics: patch.metrics ?? null,
  };
}

export function activityMap(entries: ActivityEntry[]): Record<string, ActivityEntry> {
  return Object.fromEntries(entries.map((entry) => [refKey(entry.ref), entry]));
}
