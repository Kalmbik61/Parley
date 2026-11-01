// The session's message flow (D1 §9.5): draft, Face ID, `pty.send`, the bubble's states. The text is cleared only once
// the gate has said yes; a cancelled gate leaves it in the field.
import { useCallback, useRef, useState } from 'react';
import { newClientMsgId, sessionKey, type SessionRef } from '@parley/remote-client';
import { approve } from '../auth/instance';
import { FACE_ID_CANCELLED, NO_PASSCODE } from '../components/Toast';
import { haptic } from '../haptics';
import { useClient } from '../hooks/use-remote';
import { draftOf, outboxOf, setDraft as saveDraft, setOutbox, type OutMessage } from './outbox';
import { messageProblem, sendToAgent, uiOfSend } from './send';

export interface Chat {
  out: OutMessage[];
  draft: string;
  setDraft(text: string): void;
  /** Face ID or the call is in flight: the field and the button are off. */
  busy: boolean;
  /** `pty.send` answered `unknown_method`: the Mac switch is off, the composer is replaced by a line. */
  switchedOff: boolean;
  send(): Promise<void>;
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
    async (text: string, clientMsgId: string, replaces: string | null, fromDraft: boolean): Promise<void> => {
      if (client === null || ref === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      const entry: OutMessage = { id: clientMsgId, text, at: Date.now(), state: { kind: 'sending' } };
      update((l) => [...l.filter((m) => m.id !== replaces && m.id !== clientMsgId), entry]);
      try {
        const res = await sendToAgent(client, approve, ref, text, clientMsgId);
        if (res.cancelled) {
          update((l) => l.filter((m) => m.id !== clientMsgId));
          notify(res.reason === 'no-passcode' ? NO_PASSCODE : FACE_ID_CANCELLED);
          return;
        }
        if (fromDraft) setDraft('');
        const ui = uiOfSend(res.outcome, turnRunning);
        if (ui.kind === 'failed') {
          haptic.error();
          if (ui.hideComposer) setSwitchedOff(true);
          if (ui.textBack) {
            update((l) => l.filter((m) => m.id !== clientMsgId));
            setDraft(text);
            notify(ui.message);
            return;
          }
        } else if (ui.kind === 'sent' || ui.kind === 'queued') haptic.success();
        update((l) => l.map((m) => (m.id === clientMsgId ? { ...m, state: ui } : m)));
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
    // refusal nothing reached the agent: a new key, and Face ID asks again.
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
