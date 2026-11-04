// Reply: what goes as a quote (port of the window's `chat/reply.ts`, D1 §9.2). A selected fragment goes whole; otherwise the
// start of the message, up to `REPLY_QUOTE_MAX` characters with "…" — the whole reply is already in the model's history.
// The quote rides as a Markdown `> …` block before the person's text (`withQuote`); the prompt bubble shows it folded
// (`splitQuote`). No React.

/** The limit of a whole-message quote, characters. */
export const REPLY_QUOTE_MAX = 300;

/** The quote: the selected fragment, or the start of the text up to `REPLY_QUOTE_MAX` characters. */
export function replyQuote(text: string, selected: string): string {
  const fragment = selected.trim();
  if (fragment !== '') return fragment;
  const chars = Array.from(text.trim());
  return chars.length <= REPLY_QUOTE_MAX ? chars.join('') : `${chars.slice(0, REPLY_QUOTE_MAX).join('').trimEnd()}…`;
}

/** The text to send: the quote as a `> …` block, an empty line, then the text. */
export function withQuote(quote: string, text: string): string {
  const block = quote
    .split(/\r\n|\r|\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return text === '' ? block : `${block}\n\n${text}`;
}

/** The reverse of `withQuote`: the `>` lines at the start are the quote (without `> `), the rest is the text. */
export function splitQuote(text: string): { quote: string | null; text: string } {
  const lines = text.split('\n');
  let count = 0;
  while (count < lines.length && /^>(?: |$)/.test(lines[count] ?? '')) count += 1;
  if (count === 0) return { quote: null, text };
  return {
    quote: lines.slice(0, count).map((line) => line.replace(/^> ?/, '')).join('\n'),
    text: lines.slice(count).join('\n').trim(),
  };
}

/** A CLI slash command (`/compact`, `/model opus`): a quote before it would break it. An absolute path (`/Users/…`) is not one. */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(text.trimStart());
}

/** What the field sends: with the plate's quote, except for a slash command (the plate stays). */
export function composeMessage(typed: string, quote: string | null): string {
  return quote !== null && !isSlashCommand(typed) ? withQuote(quote, typed) : typed;
}

/** `sent` starts with the plate's quote block (then the typed text or nothing). */
export function carriesQuote(sent: string, plate: string | null): boolean {
  if (plate === null) return false;
  const block = withQuote(plate, '');
  return sent === block || sent.startsWith(`${block}\n\n`);
}

/** What the person typed: `sent` without the plate's block (a refusal gives back only this, the plate stays). */
export function typedPart(sent: string, plate: string | null): string {
  if (!carriesQuote(sent, plate)) return sent;
  return sent.slice(withQuote(plate as string, '').length).replace(/^\n\n/, '');
}

export interface AfterSendFacts {
  /** The host accepted the message (`pty.send` answered `sent`; `blocked` and `busy` also answer `sent`, see `textBack`). */
  accepted: boolean;
  /** The refusal wants the text back in the field. */
  textBack: boolean;
  /** The text that went (the draft with the plate's block, or an old prompt for Send again). */
  sent: string;
  /** The plate now. */
  plate: string | null;
  /** The send came from the field or from a wake-up of it, or is the retry of one (the plate's quote went with it). */
  carriesPlate: boolean;
  /** The text was taken from the field (it was cleared then). */
  fromDraft: boolean;
  /** The field is empty now. */
  draftFree: boolean;
  /** Send again (a fresh one): its bubble is dropped on a refusal that gives nothing back — the prompt is in the feed anyway. */
  again?: boolean;
}

/**
 * What to do with the field, the plate and the bubble once the call has an answer (critic A42 M1, M2, m1, m14, m16):
 * - the plate goes only with an accepted send that carried it and did not give the text back (`blocked` is "accepted" by
 *   the bridge, but nothing reached the agent);
 * - text goes back to the field only when it came from there or the field is empty, and only what the person typed (the
 *   quote block is stripped by content, whoever sent it; the plate stays, so the quote does not go twice).
 * `draft`: the new field text; `null` — leave it. `giveBack` — the text went back, the bubble goes. `dropBubble` — the
 * bubble goes (also for a refused Send again with a busy field).
 */
export function afterSend(f: AfterSendFacts): { draft: string | null; clearPlate: boolean; giveBack: boolean; dropBubble: boolean } {
  const carried = f.carriesPlate && carriesQuote(f.sent, f.plate);
  const giveBack = f.textBack && (f.fromDraft || f.draftFree);
  const typed = typedPart(f.sent, f.plate);
  return {
    draft: giveBack ? typed : f.fromDraft ? '' : null,
    clearPlate: f.accepted && carried && !giveBack,
    giveBack,
    dropBubble: giveBack || (f.textBack && f.again === true),
  };
}

/** Retry carries the plate when the plate still holds the quote the message carried (critic A42 m15). */
export const retryCarriesPlate = (carried: string | undefined, current: string | null): boolean => carried !== undefined && carried === current;
