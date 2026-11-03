// Status capsule of the Session screen (D1 §9.2) and Work-list text, from the projection and the activity cache.
import type { Attention } from '@parley/core/attention';
import type { RemoteSession } from '@parley/protocol/remote';
import { attentionOfSession, sessionKey, type RemoteNeed, type RemoteState, type SessionRef } from '@parley/remote-client';
import { timeAgo } from './model';

export type CapsuleTone = 'needsYou' | 'working' | 'unseen' | 'idle' | 'success' | 'danger' | 'off';
export interface Capsule {
  icon: 'hand.raised.fill' | 'ellipsis' | 'pause.circle' | 'moon.zzz' | 'checkmark.circle.fill' | 'xmark.circle.fill' | 'minus.circle';
  label: string;
  tone: CapsuleTone;
  /** A ring instead of a filled dot: "finished a turn", "starting" and "sleeping" (D1 §9.1). */
  ring: boolean;
  /** Second line. */
  detail: string | null;
}

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** What the session waits for, in words (Inbox `need` rows and the capsule's second line). */
export function needReason(need: RemoteNeed | null): string {
  if (need === null) return 'Waiting for you';
  switch (need.kind) {
    case 'approval':
      return 'Waiting for your approval';
    case 'question':
      return 'Waiting for your answer';
    case 'startup':
      return 'Waiting at startup';
    case 'limit':
      return need.resetsAt === null ? 'Usage limit reached' : `Usage limit · resets at ${hhmm(need.resetsAt)}`;
    case 'sign-in':
      return need.account === 'account' ? 'Signed out of the account' : 'Signed out of the provider';
  }
}

export interface CapsuleInput {
  session: RemoteSession;
  attention: Attention;
  need: RemoteNeed | null;
  subagents: number;
  waitingFor: string | null;
  turnEndedAt: string | null;
  /** `activity.lastEventAt`: the last hook event (the history's `lastEvent` holds lifecycle moves, not hooks). */
  lastEventAt?: string | null;
  now: number;
}

const agoOf = (at: string | null | undefined, now: number): string | null => {
  const a = timeAgo(at ?? null, now);
  return a === null ? null : `${a} ago`;
};

/** Done / Failed of a session that handed in a result (closed or asleep): the window's `result ?? 'exited'` word. */
const resultCapsule = (s: RemoteSession, now: number): Capsule => {
  const failed = s.result === 'failed';
  return { icon: failed ? 'xmark.circle.fill' : 'checkmark.circle.fill', label: failed ? 'Failed' : 'Done', tone: failed ? 'danger' : 'success', ring: false, detail: agoOf(s.resultAt, now) };
};

export function capsuleOf(i: CapsuleInput): Capsule {
  const { session: s } = i;
  if (s.lifecycle === 'closed') {
    if (s.result !== null) return resultCapsule(s, i.now);
    return { icon: 'minus.circle', label: 'Closed', tone: 'off', ring: false, detail: agoOf(s.lastEvent?.at, i.now) };
  }
  if (s.lifecycle === 'sleeping') {
    if (s.result !== null) return resultCapsule(s, i.now);
    const ago = timeAgo(s.lastEvent?.at ?? null, i.now);
    return { icon: 'moon.zzz', label: 'Sleeping', tone: 'off', ring: true, detail: ago === null ? null : `Last active ${ago} ago` };
  }
  if (s.lifecycle === 'pending') return { icon: 'ellipsis', label: 'Starting', tone: 'idle', ring: true, detail: null };
  if (i.attention === 'needs-you') {
    return { icon: 'hand.raised.fill', label: 'Needs you', tone: 'needsYou', ring: false, detail: needReason(i.need) };
  }
  if (i.attention === 'working') {
    const detail = i.waitingFor !== null ? `Waiting for ${i.waitingFor}` : i.subagents > 0 ? `${i.subagents} subagent${i.subagents === 1 ? '' : 's'}` : null;
    return { icon: 'ellipsis', label: 'Working', tone: 'working', ring: false, detail };
  }
  if (i.attention === 'unseen') {
    return { icon: 'checkmark.circle.fill', label: 'Finished a turn', tone: 'unseen', ring: true, detail: agoOf(i.turnEndedAt ?? i.lastEventAt ?? s.lastEvent?.at, i.now) };
  }
  return { icon: 'pause.circle', label: 'Idle', tone: 'idle', ring: false, detail: agoOf(i.lastEventAt ?? s.lastEvent?.at, i.now) };
}

/** The one builder of `capsuleOf`'s input from the store: the tree, the team head and the session screen all use it. */
export function capsuleInputOf(state: RemoteState, ref: SessionRef, session: RemoteSession, now: number): CapsuleInput {
  const live = state.activity[sessionKey(ref)]?.activity;
  return {
    session,
    attention: attentionOfSession(state, ref, session),
    need: live?.need ?? session.stuck,
    subagents: live?.subagents ?? 0,
    waitingFor: live?.waitingFor ?? null,
    turnEndedAt: live?.turnEndedAt ?? null,
    lastEventAt: live?.lastEventAt ?? null,
    now,
  };
}

export const capsuleOfSession = (state: RemoteState, ref: SessionRef, session: RemoteSession, now: number): Capsule => capsuleOf(capsuleInputOf(state, ref, session, now));
