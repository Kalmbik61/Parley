// DEVELOPER BUILD ONLY (PARLEY_MOBILE_DEV_DEMO=1, __DEV__): fills the remote-client store with a made-up snapshot so the
// A15 screens can be looked at on a simulator before pairing exists. Never reached in a release build.
import type { FeedCard } from '@parley/core';
import type { RemoteClient, SessionRef } from '@parley/remote-client';
import type { RemoteWorksSnapshot } from '@parley/protocol/remote';
import { sessionParam, workParam } from '../nav/refs';

const P = '/Users/me/parley';
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const sess = (id: string, label: string, extra: Partial<RemoteWorksSnapshot['works'][number]['sessions'][number]> = {}) => ({
  id, label, provider: 'claude', model: 'opus', role: null, parent: null, createdBy: null, lifecycle: 'active' as const, result: null,
  stuck: null, lastEvent: { event: 'Stop', at: ago(3) }, startedAt: ago(42), resultAt: null, ...extra,
});

export const demoSnapshot: RemoteWorksSnapshot = {
  revision: 1,
  works: [
    {
      projectPath: P, id: 'w1', title: 'Improvements', status: 'active', messages: { direct: { total: 2, unread: 1 }, inline: 0 },
      sessions: [
        sess('greta', 'Greta', { role: 'feature-lead' }),
        sess('d1', 'Mobile-D1-designer', { role: 'designer', createdBy: 'greta' }),
        sess('a13', 'Mobile-A13-app-foundation', { role: 'executor', model: 'sonnet', createdBy: 'greta' }),
        sess('drone1', 'Research drone 1', { createdBy: 'greta' }),
        sess('queen', 'Research queen', { createdBy: 'greta' }),
        sess('solo', 'Changelog-writer', { role: 'writer' }),
      ],
      rooms: [
        { id: 'r1', title: 'iOS app: stage A', members: ['greta', 'd1', 'a13'], lead: 'greta', ownerId: 'greta', mode: 'verified', archived: false,
          proposal: { id: 'p-03', kind: 'decision', from: 'Greta', text: 'Ship A1 with the new projection', rev: 2, at: ago(12), planId: null, planRev: null }, messages: null },
      ],
      swarms: [
        { id: 'sw1', tag: 'Research', creator: { kind: 'session', sessionId: 'greta' }, queen: 'queen', status: 'running', createdAt: ago(20), endedAt: null, seenAt: null,
          members: [{ sessionId: 'queen', role: 'queen', n: 0, handedAt: null }, { sessionId: 'drone1', role: 'drone', n: 1, handedAt: ago(2) }] },
      ],
    },
    {
      projectPath: '/Users/me/codex-bridge', id: 'w2', title: 'Codex bridge', status: 'active', messages: { direct: null, inline: 0 },
      sessions: [sess('cb1', 'Bridge-planner')], rooms: [], swarms: [],
    },
  ],
};

const permission: FeedCard = {
  kind: 'permission', id: 'card-1', cardId: 'card-1', at: ago(2), state: 'pending', toolUseId: null, toolName: 'Bash',
  toolInput: { command: 'pnpm lint && pnpm -r build' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm lint:*' }] }], notified: true,
} as unknown as FeedCard;
const question: FeedCard = {
  kind: 'question', id: 'card-2', cardId: 'card-2', at: ago(5), state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
  questions: [{ question: 'Which branch should I rebase onto?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: 'The default branch' }, { label: 'feat/mobile-stage-a', description: null }] }],
} as unknown as FeedCard;

export function installDemo(client: RemoteClient): void {
  const { store } = client;
  if (store.getState().snapshot !== null) return;
  store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'demo' });
  store.dispatch({ t: 'snapshot', snapshot: demoSnapshot, epoch: 'demo' });
  const act = (ref: SessionRef, activity: string, need: unknown = null): void =>
    store.dispatch({ t: 'activity.changed', ref, metrics: null, activity: { activity, subagents: 0, tasks: [], waitingFor: null, heldByBackground: false, turnEndedAt: null, turnBoundaryAt: null, lastEventAt: ago(1), source: 'hooks', hooksMissing: false, need } as never });
  const ref = (sessionId: string): SessionRef => ({ projectPath: P, workId: 'w1', sessionId });
  act(ref('d1'), 'blocked', { kind: 'approval', since: ago(2), detail: null, resetsAt: null, window: null, account: null });
  act(ref('a13'), 'blocked', { kind: 'question', since: ago(5), detail: null, resetsAt: null, window: null, account: null });
  act(ref('greta'), 'unseen');
  act(ref('drone1'), 'working');
  store.dispatch({ t: 'cards.loaded', ref: ref('d1'), epoch: 'demo', items: [permission], at: Date.now() });
  store.dispatch({ t: 'cards.loaded', ref: ref('a13'), epoch: 'demo', items: [question], at: Date.now() });
}

/** `PARLEY_MOBILE_DEV_ROUTE=works|work|session|question|plain` → a path to open once, for screenshots. */
export function demoRoute(name: unknown): string | null {
  const w = workParam({ projectPath: P, workId: 'w1' });
  const s = (id: string): string => `/session/${sessionParam({ projectPath: P, workId: 'w1', sessionId: id })}`;
  switch (name) {
    case 'works':
      return '/works';
    case 'work':
      return `/work/${w}`;
    case 'session':
      return s('d1');
    case 'question':
      return s('a13');
    case 'plain':
      return s('greta');
    default:
      return null;
  }
}
