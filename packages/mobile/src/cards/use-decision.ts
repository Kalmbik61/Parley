import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from '../haptics';
import type { FeedDecision } from '@parley/core';
import type { SessionRef } from '@parley/remote-client';
import { useClient } from '../hooks/use-remote';
import { useApprove } from './approve-context';
import { hapticFor } from './haptics-map';
import { DECISION_TEXT, runDecision, type DecisionUi } from './model';

export interface DecisionState {
  busy: boolean;
  /** Caption under the card for a few seconds ("Already answered at your Mac"…); persists for `unconfirmed`. */
  message: string | null;
  submit(decision: FeedDecision): Promise<DecisionUi | null>;
}

/**
 * One card's decision flow (spec §11.4): gate → `feed.decide` → outcome. Buttons stay locked while `busy`; a result with
 * no confirmation keeps the card and says so; nothing is retried.
 */
export function useDecision(ref: SessionRef, cardId: string): DecisionState {
  const client = useClient();
  const approve = useApprove();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current !== null && clearTimeout(timer.current)), []);

  const submit = useCallback(
    async (decision: FeedDecision): Promise<DecisionUi | null> => {
      if (client === null || busy) return null;
      setBusy(true);
      setMessage(null);
      const ui = await runDecision(decision, approve, (d) => client.decide(ref, cardId, d));
      setBusy(false);
      const kind = hapticFor(ui, decision);
      if (kind === 'success') haptic.success();
      else if (kind === 'warning') haptic.warning();
      else if (kind === 'error') haptic.error();
      const text = DECISION_TEXT[ui.kind];
      setMessage(text);
      if (text !== null && ui.kind !== 'unconfirmed') {
        timer.current = setTimeout(() => setMessage(null), 2000);
      }
      return ui;
    },
    [client, busy, approve, ref, cardId],
  );
  return { busy, message, submit };
}
