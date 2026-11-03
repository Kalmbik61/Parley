import { useCallback, useSyncExternalStore } from 'react';
import { haptic } from '../haptics';
import type { FeedDecision } from '@parley/core';
import { sessionKey, type SessionRef } from '@parley/remote-client';
import { useClient } from '../hooks/use-remote';
import { hapticFor } from './haptics-map';
import { DECISION_TEXT, runDecision, type DecisionUi } from './model';

export interface DecisionState {
  busy: boolean;
  /** Caption under the card for a few seconds ("Already answered at your Mac"…); persists for `unconfirmed`. */
  message: string | null;
  submit(decision: FeedDecision): Promise<DecisionUi | null>;
}

interface Flow {
  readonly busy: boolean;
  readonly message: string | null;
}
const IDLE: Flow = { busy: false, message: null };

// A card's decision flow lives outside the components, keyed by session and card: the card's body (in the list) and its
// actions (in the footer) are two components that read the same flow (A44), and nothing moves UI through an effect.
const flows = new Map<string, Flow>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const keyOf = (ref: SessionRef, cardId: string): string => `${sessionKey(ref)}\u0000${cardId}`;
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
function setFlow(key: string, next: Flow): void {
  if (next === IDLE) flows.delete(key);
  else flows.set(key, next);
  listeners.forEach((l) => l());
}
/** Tests and a removed host: nothing of a flow outlives its keys. */
export function clearDecisionFlows(): void {
  timers.forEach(clearTimeout);
  timers.clear();
  flows.clear();
  listeners.forEach((l) => l());
}

/**
 * One card's decision flow (spec §11.4): gate → `feed.decide` → outcome. Buttons stay locked while `busy`; a result with
 * no confirmation keeps the card and says so; nothing is retried.
 */
export function useDecision(ref: SessionRef, cardId: string): DecisionState {
  const client = useClient();
  const key = keyOf(ref, cardId);
  const flow = useSyncExternalStore(subscribe, () => flows.get(key) ?? IDLE);

  const submit = useCallback(
    async (decision: FeedDecision): Promise<DecisionUi | null> => {
      const now = flows.get(key) ?? IDLE;
      if (client === null || now.busy) return null;
      const stale = timers.get(key);
      if (stale !== undefined) clearTimeout(stale);
      setFlow(key, { busy: true, message: null });
      const ui = await runDecision(decision, (d) => client.decide(ref, cardId, d));
      const kind = hapticFor(ui, decision);
      if (kind === 'success') haptic.success();
      else if (kind === 'warning') haptic.warning();
      else if (kind === 'error') haptic.error();
      const text = DECISION_TEXT[ui.kind];
      setFlow(key, text === null ? IDLE : { busy: false, message: text });
      if (text !== null && ui.kind !== 'unconfirmed') {
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            setFlow(key, IDLE);
          }, 2000),
        );
      }
      return ui;
    },
    [client, key, ref, cardId],
  );
  return { busy: flow.busy, message: flow.message, submit };
}
