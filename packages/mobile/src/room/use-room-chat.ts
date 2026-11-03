// The room's message flow (D1 §9.7): draft with chips, reply, `rooms.send`, the bubble of what is on its way. The text
// returns to the field when the host refuses; a lost answer is "Not sent · Retry" once the client's re-read found nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutLetter } from './out-letters';
import { roomKey } from '@parley/remote-client';
import { haptic } from '../haptics';
import { useClient } from '../hooks/use-remote';
import { letterProblem, recipientsOf, roomOutgoing, sendLetter, type Mentionable, type RoomReply, type RoomTarget } from './model';

const outboxes = new Map<string, OutLetter[]>();
const drafts = new Map<string, string>();

export interface RoomChatFlow {
  draft: string;
  setDraft(text: string): void;
  chips: Mentionable[];
  addChip(chip: Mentionable): void;
  reply: RoomReply | null;
  setReply(r: RoomReply | null): void;
  out: OutLetter[];
  busy: boolean;
  /** `rooms.send` answered `unknown_method`: the Mac switch is off. */
  switchedOff: boolean;
  send(): Promise<void>;
  retry(letter: OutLetter): Promise<void>;
}

export function useRoomChat(room: RoomTarget | null, notify: (text: string) => void): RoomChatFlow {
  const client = useClient();
  const key = room === null ? '' : roomKey(room);
  const [draft, setDraftState] = useState(() => drafts.get(key) ?? '');
  const [chips, setChips] = useState<Mentionable[]>([]);
  const [reply, setReply] = useState<RoomReply | null>(null);
  const [out, setOutState] = useState<OutLetter[]>(() => outboxes.get(key) ?? []);
  const [busy, setBusy] = useState(false);
  const [switchedOff, setSwitchedOff] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setOutState(outboxes.get(key) ?? []);
  }, [key]);

  const update = useCallback(
    (fn: (l: OutLetter[]) => OutLetter[]) => {
      const next = fn(outboxes.get(key) ?? []);
      outboxes.set(key, next);
      setOutState(next);
    },
    [key],
  );
  const setDraft = useCallback(
    (text: string) => {
      if (text === '') drafts.delete(key);
      else drafts.set(key, text);
      setDraftState(text);
    },
    [key],
  );

  const run = useCallback(
    async (letter: OutLetter, fromDraft: boolean): Promise<void> => {
      if (client === null || room === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      update((l) => [...l.filter((x) => x.id !== letter.id), { ...letter, state: 'sending', note: null }]);
      try {
        const ui = await sendLetter(client, room, letter.text, letter.to, letter.replyTo);
        if (ui.kind === 'sent') {
          haptic.success();
          if (fromDraft) {
            setDraft('');
            setChips([]);
            setReply(null);
          }
          update((l) => l.map((x) => (x.id === letter.id ? { ...x, state: 'sent', messageId: ui.messageId } : x)));
          return;
        }
        haptic.error();
        if (ui.kind === 'refused') {
          if (ui.hideComposer) setSwitchedOff(true);
          // The text goes back to the field (when the field is free); the bubble goes.
          update((l) => l.filter((x) => x.id !== letter.id));
          if (fromDraft || drafts.get(key) === undefined) setDraft(letter.text);
          notify(ui.message);
          return;
        }
        update((l) => l.map((x) => (x.id === letter.id ? { ...x, state: 'failed', note: ui.message } : x)));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [client, room, key, update, setDraft, notify],
  );

  return {
    draft,
    setDraft,
    chips,
    addChip: (chip) => setChips((c) => (c.some((x) => x.id === chip.id) ? c : [...c, chip])),
    reply,
    setReply,
    out,
    busy,
    switchedOff,
    send: async () => {
      const out = roomOutgoing(draft, reply);
      if (letterProblem(draft) !== null || letterProblem(out.text) !== null) return;
      const to = recipientsOf(draft, chips).map((c) => c.id);
      await run({ id: `out-${Date.now().toString(36)}`, text: out.text, to, replyTo: out.replyTo, at: Date.now(), state: 'sending', note: null, messageId: null }, true);
    },
    retry: (letter) => run(letter, false),
  };
}
