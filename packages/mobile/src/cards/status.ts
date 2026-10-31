// Status capsule of the Session screen (D1 §9.2) and Work-list text, from the projection and the activity cache.
import type { Attention } from '@parley/core/attention';
import type { RemoteSession } from '@parley/protocol/remote';
import type { RemoteNeed } from '@parley/remote-client';
import { timeAgo } from './model';

export type CapsuleTone = 'needsYou' | 'working' | 'idle' | 'success' | 'danger' | 'off';
export interface Capsule {
  icon: 'hand.raised.fill' | 'ellipsis' | 'pause.circle' | 'moon.zzz' | 'checkmark.circle.fill' | 'xmark.circle.fill';
  label: string;
  tone: CapsuleTone;
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
  now: number;
}

export function capsuleOf(i: CapsuleInput): Capsule {
  const { session: s } = i;
  if (s.lifecycle === 'closed') {
    const failed = s.result === 'failed';
    return {
      icon: failed ? 'xmark.circle.fill' : 'checkmark.circle.fill',
      label: failed ? 'Failed' : 'Done',
      tone: failed ? 'danger' : 'success',
      detail: s.resultAt === null ? null : (timeAgo(s.resultAt, i.now) === null ? null : `${timeAgo(s.resultAt, i.now)} ago`),
    };
  }
  if (s.lifecycle === 'sleeping') {
    const ago = timeAgo(s.lastEvent?.at ?? null, i.now);
    return { icon: 'moon.zzz', label: 'Sleeping', tone: 'off', detail: ago === null ? null : `Last active ${ago} ago` };
  }
  if (i.attention === 'needs-you') {
    return { icon: 'hand.raised.fill', label: 'Needs you', tone: 'needsYou', detail: needReason(i.need) };
  }
  if (i.attention === 'working') {
    const detail = i.waitingFor !== null ? `Waiting for ${i.waitingFor}` : i.subagents > 0 ? `${i.subagents} subagent${i.subagents === 1 ? '' : 's'}` : null;
    return { icon: 'ellipsis', label: 'Working', tone: 'working', detail };
  }
  const ago = timeAgo(i.turnEndedAt ?? s.lastEvent?.at ?? null, i.now);
  return { icon: 'pause.circle', label: 'Idle', tone: 'idle', detail: ago === null ? null : `Finished a turn · ${ago} ago` };
}
