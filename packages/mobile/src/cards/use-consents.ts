// Pending consent cards for a screen, with the 2 s line after a card goes (D1 §7.3): our own answer ("Allowed", "Denied")
// or "Answered at your Mac" when `consents.changed` removed it without us.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsentCard } from '@parley/protocol';
import { DEMO_CONSENT_NOTES } from '../dev/demo';
import { DEMO } from '../dev/flags';
import { haptic } from '../haptics';
import { useClient, useRemoteState } from '../hooks/use-remote';
import { CONSENT_TEXT, canDecideConsent, pendingConsents, runConsent, type ConsentUi } from './consent-model';

export interface ConsentRow {
  card: ConsentCard;
  /** The caption under the card: a result or a prompt to re-check. */
  message: string | null;
  /** The card is already answered and only lingers. */
  settled: boolean;
  busy: boolean;
  /** `consents.decide` is in the bridge hello (the Mac switch is on); `false` — no buttons, answer at the Mac. */
  canDecide: boolean;
}

const LINGER_MS = 2000;

export function useConsents(): { rows: ConsentRow[]; decide(card: ConsentCard, decision: 'allow' | 'deny', enabled?: ReadonlyArray<{ name: string; fingerprint: string }>): Promise<void> } {
  const client = useClient();
  const state = useRemoteState();
  const items = state?.consents.items;
  // A hello without `consents.decide`: the Mac switch is off (or an old Mac) — the call would be refused, so no buttons.
  const canDecide = canDecideConsent(state?.methods ?? null);
  const pending = useMemo(() => pendingConsents(items ?? []), [items]);
  const known = useRef(new Map<string, ConsentCard>());
  const ours = useRef(new Map<string, string>());
  const [lingering, setLingering] = useState<Record<string, { card: ConsentCard; message: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>(() => (DEMO ? DEMO_CONSENT_NOTES : {}));

  // A card that was pending and is gone: show how it ended for two seconds.
  useEffect(() => {
    const now = new Set(pending.map((c) => c.id));
    for (const [id, card] of known.current) {
      if (now.has(id)) continue;
      known.current.delete(id);
      const message = ours.current.get(id) ?? 'Answered at your Mac';
      ours.current.delete(id);
      setLingering((l) => ({ ...l, [id]: { card, message } }));
      setTimeout(() => setLingering((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== id))), LINGER_MS);
    }
    for (const c of pending) known.current.set(c.id, c);
  }, [pending]);

  const decide = useCallback(
    async (card: ConsentCard, decision: 'allow' | 'deny', enabled?: ReadonlyArray<{ name: string; fingerprint: string }>): Promise<void> => {
      if (client === null || busyId !== null) return;
      setBusyId(card.id);
      setNotes((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== card.id)));
      try {
        const ui: ConsentUi = await runConsent(client, card, decision, enabled);
        switch (ui.kind) {
          case 'allowed':
            haptic.success();
            ours.current.set(card.id, ui.text);
            return;
          case 'denied':
            haptic.warning();
            ours.current.set(card.id, ui.text);
            return;
          case 'already-answered':
            haptic.warning();
            ours.current.set(card.id, CONSENT_TEXT['already-answered']);
            return;
          case 'no-longer-pending':
            ours.current.set(card.id, CONSENT_TEXT['no-longer-pending']);
            return;
          case 'unconfirmed':
            setNotes((n) => ({ ...n, [card.id]: CONSENT_TEXT.unconfirmed }));
            return;
          case 'error':
            haptic.error();
            setNotes((n) => ({ ...n, [card.id]: ui.text }));
        }
      } finally {
        setBusyId(null);
      }
    },
    [client, busyId],
  );

  const rows: ConsentRow[] = [
    ...Object.values(lingering).map((l): ConsentRow => ({ card: l.card, message: l.message, settled: true, busy: false, canDecide })),
    ...pending.map((card): ConsentRow => ({ card, message: notes[card.id] ?? null, settled: false, busy: busyId === card.id, canDecide })),
  ];
  return { rows, decide };
}
