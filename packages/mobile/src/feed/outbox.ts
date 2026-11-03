// Messages the person sent from this phone, shown in the feed until the host's own `prompt` replaces them (D1 §9.5).
// Kept in memory per session so leaving the screen does not lose the state; a cold start loses it. No React.
import type { FeedItem } from '@parley/core';
import type { SentUi } from './send';

export interface OutMessage {
  /** The `clientMsgId` of the attempt. */
  id: string;
  text: string;
  /** When the call went (`requestedAt`, ms); a feed `prompt` older than this is not ours. */
  at: number;
  /** Send again: how many prompts with this text the feed held at the call; only a newer one is this message. */
  seen?: number;
  /** The quote of the reply plate this text carried (a Retry clears the plate only while it still holds it). */
  plate?: string;
  state: { kind: 'sending' } | { kind: 'waking' } | { kind: 'held' } | SentUi;
}

/** A feed `prompt` with the same text, written at or after the call, is the message itself: the bubble merges into it. */
export function mergedWith(message: OutMessage, items: readonly FeedItem[], skewMs = 60_000): boolean {
  // Only a message the agent may have received can turn into a prompt.
  const kind = message.state.kind;
  if (kind !== 'sent' && kind !== 'queued' && kind !== 'unconfirmed') return false;
  if (message.seen !== undefined) return promptCount(items, message.text) > message.seen;
  return items.some((i) => i.kind === 'prompt' && i.text.trim() === message.text.trim() && Date.parse(i.at) >= message.at - skewMs);
}

/** How many prompts with this text the feed holds. */
export const promptCount = (items: readonly FeedItem[], text: string): number => items.filter((i) => i.kind === 'prompt' && i.text.trim() === text.trim()).length;

/** What stays on screen: messages the feed has not absorbed. */
export function visibleOut(out: readonly OutMessage[], items: readonly FeedItem[]): OutMessage[] {
  return out.filter((m) => !mergedWith(m, items));
}

const store = new Map<string, OutMessage[]>();
const drafts = new Map<string, string>();
/** The reply plate lives with the session's draft (D1 §9.2). */
const quotes = new Map<string, string>();

export const outboxOf = (key: string): OutMessage[] => store.get(key) ?? [];
export const setOutbox = (key: string, list: OutMessage[]): void => void store.set(key, list);
export const draftOf = (key: string): string => drafts.get(key) ?? '';
export const setDraft = (key: string, text: string): void => void (text === '' ? drafts.delete(key) : drafts.set(key, text));
export const quoteOf = (key: string): string | null => quotes.get(key) ?? null;
export const setQuote = (key: string, quote: string | null): void => void (quote === null ? quotes.delete(key) : quotes.set(key, quote));
/** Tests. */
export const clearOutbox = (): void => {
  store.clear();
  drafts.clear();
  quotes.clear();
};
