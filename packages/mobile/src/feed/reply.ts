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

/** The plate is cleared by a send that carried it and that the host accepted — not by a refusal or a lost call. */
export function plateCleared(quote: string | null, sent: string, accepted: boolean): boolean {
  return accepted && quote !== null && sent.startsWith(withQuote(quote, ''));
}
