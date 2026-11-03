// The session's message flow (D1 §9.5): draft, `pty.send`, the bubble's states. The text is cleared once the call has
// an answer.
import { useCallback, useRef, useState } from 'react';
import { newClientMsgId, sessionKey, type SessionRef } from '@parley/remote-client';
import { haptic } from '../haptics';
import { useClient } from '../hooks/use-remote';
import { draftOf, outboxOf, quoteOf, setDraft as saveDraft, setOutbox, setQuote as saveQuote, type OutMessage } from './outbox';
import { againMessage } from './message-actions';
import { afterSend, composeMessage } from './reply';
import type { AutoSend } from './resume';
import { messageProblem, uiOfSend } from './send';

export interface Chat {
  out: OutMessage[];
  draft: string;
  setDraft(text: string): void;
  /** The reply plate's quote (Reply, Reply with selection); lives with the draft. */
  quote: string | null;
  setQuote(quote: string | null): void;
  /** What ⬆ sends: the draft with the plate's quote, except for a slash command. */
  composed: string;
  /** Send again: the same text through the same path with a NEW `clientMsgId`; the field and the plate are not touched. */
  again(text: string, seen?: number): Promise<AutoSend>;
  /** A wake-up that failed gives the text back: only what was typed, and only into a free field. */
  giveBack(text: string): void;
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
  const [quote, setQuoteState] = useState<string | null>(() => quoteOf(key));
  const [busy, setBusy] = useState(false);
  const [switchedOff, setSwitchedOff] = useState(false);
  const inFlight = useRef(false);
  const composed = composeMessage(draft, quote);

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

  const setQuote = useCallback(
    (next: string | null) => {
      saveQuote(key, next);
      setQuoteState(next);
    },
    [key],
  );

  const run = useCallback(
    async (text: string, clientMsgId: string, replaces: string | null, fromDraft: boolean, quiet = false, carriesPlate = false, seen?: number): Promise<AutoSend> => {
      if (client === null || ref === null || inFlight.current) return 'not-started';
      inFlight.current = true;
      setBusy(true);
      const entry: OutMessage = { id: clientMsgId, text, at: Date.now(), state: { kind: 'sending' }, ...(seen === undefined ? {} : { seen }) };
      update((l) => [...l.filter((m) => m.id !== replaces && m.id !== clientMsgId), entry]);
      try {
        const outcome = await client.sendMessage({ ref, text, clientMsgId });
        const ui = uiOfSend(outcome, turnRunning);
        // After waking: nothing reached the terminal (`busy`, `blocked`, `no-paste-mode`) means "not ready yet" — the
        // bubble goes and the text is sent again on the next activity event.
        if (quiet && outcome.outcome === 'sent' && !outcome.inserted && !outcome.submitted && (outcome.reason === 'busy' || outcome.reason === 'blocked' || outcome.reason === 'no-paste-mode')) {
          if (fromDraft) setDraft('');
          update((l) => l.filter((m) => m.id !== clientMsgId));
          return 'retry';
        }
        // The field and the plate after the answer (critic A42 M1, M2, m1): see `afterSend`.
        const after = afterSend({
          accepted: outcome.outcome === 'sent',
          textBack: ui.kind === 'failed' && ui.textBack,
          sent: text,
          plate: quoteOf(key),
          carriesPlate,
          fromDraft,
          draftFree: draftOf(key) === '',
        });
        if (after.draft !== null) setDraft(after.draft);
        if (after.clearPlate) setQuote(null);
        if (ui.kind === 'failed') {
          haptic.error();
          if (ui.hideComposer) setSwitchedOff(true);
          if (ui.textBack) {
            notify(ui.message);
            // Given back: the bubble goes. Not given back (a draft is in the field): the bubble stays with the reason.
            if (after.giveBack) {
              update((l) => l.filter((m) => m.id !== clientMsgId));
              return 'done';
            }
          }
        } else if (ui.kind === 'sent' || ui.kind === 'queued') haptic.success();
        update((l) => l.map((m) => (m.id === clientMsgId ? { ...m, state: ui } : m)));
        return 'done';
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [client, ref, key, turnRunning, update, setDraft, setQuote, notify],
  );

  return {
    out,
    draft,
    setDraft,
    quote,
    setQuote,
    composed,
    again: (text, seen) => {
      const m = againMessage(text, Date.now());
      return run(m.text, m.clientMsgId, null, false, false, false, seen);
    },
    giveBack: (text) => {
      const a = afterSend({ accepted: false, textBack: true, sent: text, plate: quoteOf(key), carriesPlate: true, fromDraft: false, draftFree: draftOf(key) === '' });
      if (a.giveBack && a.draft !== null) setDraft(a.draft);
    },
    busy,
    switchedOff,
    send: async () => {
      if (messageProblem(draft) !== null || messageProblem(composed) !== null) return;
      await run(composed, newClientMsgId(Date.now()), null, true, false, true);
    },
      // After `lost` the same key goes again (the bridge answers from its cache, the agent reads the message once). After a
    // refusal nothing reached the agent: a new key.
    sendText: (text) => run(text, newClientMsgId(Date.now()), null, false, true, true),
    retry: async (message) => {
      const reuse = message.state.kind === 'unconfirmed';
      await run(message.text, reuse ? message.id : newClientMsgId(Date.now()), message.id, false, false, false, message.seen);
    },
    edit: (message) => {
      update((l) => l.filter((m) => m.id !== message.id));
      setDraft(message.text);
    },
  };
}
