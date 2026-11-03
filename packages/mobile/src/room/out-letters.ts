// Letters on their way from this phone, and when the history takes them over. Pure.
import type { Message } from '@parley/core';

export interface OutLetter {
  id: string;
  text: string;
  to: string[];
  replyTo: string | null;
  at: number;
  state: 'sending' | 'sent' | 'failed';
  note: string | null;
  /** The id the host gave it: when the history holds it, the bubble is the letter itself. */
  messageId: string | null;
  /** What the person typed (the text without the selected fragment's quote block): this goes back to the field on a refusal. */
  typed?: string;
}

/** Bubbles of letters that the history has not absorbed yet: by the host's id, or the same text after the send. */
export function visibleOutLetters(out: readonly OutLetter[], messages: readonly Message[], skewMs = 60_000): OutLetter[] {
  return out.filter((o) => {
    if (o.state !== 'sent') return true;
    return !messages.some((m) => (o.messageId !== null && m.id === o.messageId) || (m.from === 'human' && m.text.trim() === o.text.trim() && Date.parse(m.at) >= o.at - skewMs));
  });
}
