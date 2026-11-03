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
  state: { kind: 'sending' } | { kind: 'waking' } | { kind: 'held' } | SentUi;
}

/** A feed `prompt` with the same text, written at or after the call, is the message itself: the bubble merges into it. */
export function mergedWith(message: OutMessage, items: readonly FeedItem[], skewMs = 60_000): boolean {
  // Only a message the agent may have received can turn into a prompt.
  const kind = message.state.kind;
  if (kind !== 'sent' && kind !== 'queued' && kind !== 'unconfirmed') return false;
  return items.some((i) => i.kind === 'prompt' && i.text.trim() === message.text.trim() && Date.parse(i.at) >= message.at - skewMs);
}

/** What stays on screen: messages the feed has not absorbed. */
export function visibleOut(out: readonly OutMessage[], items: readonly FeedItem[]): OutMessage[] {
  return out.filter((m) => !mergedWith(m, items));
}

const store = new Map<string, OutMessage[]>();
const drafts = new Map<string, string>();

export const outboxOf = (key: string): OutMessage[] => store.get(key) ?? [];
export const setOutbox = (key: string, list: OutMessage[]): void => void store.set(key, list);
export const draftOf = (key: string): string => drafts.get(key) ?? '';
export const setDraft = (key: string, text: string): void => void (text === '' ? drafts.delete(key) : drafts.set(key, text));
/** Tests. */
export const clearOutbox = (): void => {
  store.clear();
  drafts.clear();
};
