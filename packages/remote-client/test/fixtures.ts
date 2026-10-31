import type { FeedItem, SessionActivity } from '@parley/core';
import type { RemoteRoom, RemoteSession, RemoteWork, RemoteWorksSnapshot } from '@parley/protocol/remote';
import type { SessionRef } from '../src/index.js';

export const PROJECT = '/Users/me/proj';

export const session = (id: string, over: Partial<RemoteSession> = {}): RemoteSession => ({
  id,
  label: `label-${id}`,
  provider: 'claude',
  model: null,
  role: null,
  parent: null,
  createdBy: null,
  lifecycle: 'active',
  result: null,
  stuck: null,
  lastEvent: null,
  startedAt: null,
  resultAt: null,
  ...over,
});

export const room = (id: string, over: Partial<RemoteRoom> = {}): RemoteRoom => ({
  id,
  title: `room-${id}`,
  members: [],
  lead: null,
  ownerId: null,
  mode: 'free',
  archived: false,
  proposal: null,
  messages: null,
  ...over,
});

export const proposal = (id: string, rev: number, text: string, at = '2026-10-31T10:00:00.000Z') => ({
  id,
  from: 's-1',
  text,
  rev,
  at,
});

export const work = (id: string, over: Partial<RemoteWork> = {}): RemoteWork => ({
  projectPath: PROJECT,
  id,
  title: `work ${id}`,
  status: 'active',
  messages: { direct: null, inline: 0 },
  sessions: [],
  rooms: [],
  swarms: [],
  ...over,
});

export const snap = (revision: number, works: RemoteWork[]): RemoteWorksSnapshot => ({ revision, works });

export const ref = (sessionId: string, workId = 'w-1'): SessionRef => ({ projectPath: PROJECT, workId, sessionId });

export const live = (activity: SessionActivity['activity'], over: Partial<SessionActivity> = {}): SessionActivity =>
  ({
    activity,
    subagents: 0,
    tasks: [],
    waitingFor: null,
    heldByBackground: false,
    turnEndedAt: null,
    turnBoundaryAt: null,
    lastEventAt: '2026-10-31T10:00:00.000Z',
    need: null,
    ...over,
  }) as unknown as SessionActivity;

export const activityItem = (r: SessionRef, activity: SessionActivity['activity']) => ({
  ref: r,
  activity: live(activity),
  metrics: null,
});

export const permissionCard = (cardId: string, command: string, at = '2026-10-31T10:00:00.000Z'): FeedItem =>
  ({
    kind: 'permission',
    id: cardId,
    cardId,
    at,
    state: 'pending',
    toolUseId: null,
    toolName: 'Bash',
    toolInput: { command },
    suggestions: [],
    notified: false,
  }) as unknown as FeedItem;

export const textItem = (id: string, text: string): FeedItem =>
  ({ kind: 'text', id, at: '2026-10-31T10:00:01.000Z', messageId: null, text, streaming: false }) as unknown as FeedItem;
