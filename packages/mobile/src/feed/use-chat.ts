// The session's message flow (D1 §9.5): draft, `pty.send`, the bubble's states. The text is cleared once the call has
// an answer.
import { useCallback, useRef, useState } from 'react';
import { newClientMsgId, sessionKey, type SessionRef } from '@parley/remote-client';
import { haptic } from '../haptics';
import { useClient } from '../hooks/use-remote';
import { draftOf, outboxOf, setDraft as saveDraft, setOutbox, type OutMessage } from './outbox';
import type { AutoSend } from './resume';
import { messageProblem, uiOfSend } from './send';

export interface Chat {
  out: OutMessage[];
  draft: string;
  setDraft(text: string): void;
  /** The call is in flight: the field and the button are off. */
  busy: boolean;
  /** `pty.send` answered `unknown_method`: the Mac switch is off, the composer is replaced by a line. */
  switchedOff: boolean;
  send(): Promise<void>;
  /** A message that waited for a wake-up: a normal `pty.send` with a NEW `clientMsgId`, not from the field. */
  sendText(text: string): Promise<AutoSend>;
  retry(message: OutMessage): Promise<void>;
  edit(message: OutMessage): void;
}

export function useChat(ref: SessionRef | null, turnRunning: boolean, notify: (text: string) => void): Chat {
  const client = useClient();
  const key = ref === null ? '' : sessionKey(ref);
  const [out, setOutState] = useState<OutMessage[]>(() => outboxOf(key));
  const [draft, setDraftState] = useState(() => draftOf(key));
  const [busy, setBusy] = useState(false);
  const [switchedOff, setSwitchedOff] = useState(false);
  const inFlight = useRef(false);

  const update = useCallback(
    (fn: (list: OutMessage[]) => OutMessage[]) => {
      const next = fn(outboxOf(key));
      setOutbox(key, next);
      setOutState(next);
    },
    [key],
  );
  const setDraft = useCallback(
    (text: string) => {
      saveDraft(key, text);
      setDraftState(text);
    },
    [key],
  );

  const run = useCallback(
    async (text: string, clientMsgId: string, replaces: string | null, fromDraft: boolean, quiet = false): Promise<AutoSend> => {
      if (client === null || ref === null || inFlight.current) return 'not-started';
      inFlight.current = true;
      setBusy(true);
      const entry: OutMessage = { id: clientMsgId, text, at: Date.now(), state: { kind: 'sending' } };
      update((l) => [...l.filter((m) => m.id !== replaces && m.id !== clientMsgId), entry]);
      try {
        const outcome = await client.sendMessage({ ref, text, clientMsgId });
        if (fromDraft) setDraft('');
        const ui = uiOfSend(outcome, turnRunning);
        // After waking: nothing reached the terminal (`busy`, `blocked`, `no-paste-mode`) means "not ready yet" — the
        // bubble goes and the text is sent again on the next activity event.
        if (quiet && outcome.outcome === 'sent' && !outcome.inserted && !outcome.submitted && (outcome.reason === 'busy' || outcome.reason === 'blocked' || outcome.reason === 'no-paste-mode')) {
          update((l) => l.filter((m) => m.id !== clientMsgId));
          return 'retry';
        }
        if (ui.kind === 'failed') {
          haptic.error();
          if (ui.hideComposer) setSwitchedOff(true);
          if (ui.textBack) {
            update((l) => l.filter((m) => m.id !== clientMsgId));
            setDraft(text);
            notify(ui.message);
            return 'done';
          }
        } else if (ui.kind === 'sent' || ui.kind === 'queued') haptic.success();
        update((l) => l.map((m) => (m.id === clientMsgId ? { ...m, state: ui } : m)));
        return 'done';
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [client, ref, turnRunning, update, setDraft, notify],
  );

  return {
    out,
    draft,
    setDraft,
    busy,
    switchedOff,
    send: async () => {
      if (messageProblem(draft) !== null) return;
      await run(draft, newClientMsgId(Date.now()), null, true);
    },
      // After `lost` the same key goes again (the bridge answers from its cache, the agent reads the message once). After a
    // refusal nothing reached the agent: a new key.
    sendText: (text) => run(text, newClientMsgId(Date.now()), null, false, true),
    retry: async (message) => {
      const reuse = message.state.kind === 'unconfirmed';
      await run(message.text, reuse ? message.id : newClientMsgId(Date.now()), message.id, false);
    },
    edit: (message) => {
      update((l) => l.filter((m) => m.id !== message.id));
      setDraft(message.text);
    },
  };
}
