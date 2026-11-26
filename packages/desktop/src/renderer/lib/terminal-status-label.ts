import type { WorkSession } from '@parley/core';
import { S } from '../../shared/strings.js';
import { sessionNeed } from '../attention/derive.js';
import type { ActivityEntry } from '../store/activity.js';

/** Shared display rule. This label must not change attention, input availability or the session result. */
export function terminalStatusLabel(session: WorkSession, entry: ActivityEntry | null): string | null {
  if (entry === null) return null;
  const status = entry.terminalStatus;
  if (status == null || session.lifecycle !== 'active' || session.result !== null || session.queued != null) return null;
  const live = entry.activity;
  if (live.activity === 'blocked' || sessionNeed(session, live) !== null) return null;
  if (status.state === live.activity || (status.state === 'done' && live.activity === 'unseen')) return null;
  const labels = S.cliStatus;
  return Object.hasOwn(labels, status.state) ? labels[status.state] : null;
}
