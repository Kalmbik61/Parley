// D1 §16: haptics for decision results. One place for cards and the Decision screen.
import type { FeedDecision } from '@parley/core';
import type { DecisionUi } from './model';

export type HapticKind = 'success' | 'warning' | 'error' | 'none';

/** Allow/Approve/Send answer applied → success; Deny applied → warning; not applied, conflict, lost → warning. */
export function hapticFor(ui: DecisionUi, decision: FeedDecision): HapticKind {
  switch (ui.kind) {
    case 'done':
      return decision.kind === 'permission' && decision.behavior === 'deny' ? 'warning' : 'success';
    case 'error':
      return 'error';
    default:
      return 'warning';
  }
}
