// The inverted feed (A44b), shared by the session feed and the room feed. No React.
//
// The list is a `FlatList inverted`: data newest-first, so offset 0 is the latest message and the first frame already
// shows it — nothing scrolls after the open. "At the bottom" is offset near 0; new items stick there through
// `maintainVisibleContentPosition` (native), and reading history never moves. What stays here is the "Jump to latest"
// count: new items are counted only while the person is away from the bottom.

/** Within this many points of offset 0 the person is "at the bottom"; also the autoscroll threshold of the list. */
export const NEAR_BOTTOM = 48;

export const atBottom = (offset: number): boolean => offset <= NEAR_BOTTOM;

/** Chronological rows to list order (newest first). */
export const newestFirst = <T,>(rows: readonly T[]): T[] => [...rows].reverse();

/** The index of the chronological position `at` inside the newest-first list of `length` items. */
export const reverseIndex = (length: number, at: number): number => length - 1 - at;

export interface AwayState {
  /** The newest item the person has seen. "New" is whatever lies before it in the newest-first list. */
  readonly seenKey: string | null;
  readonly away: number;
}

export const start: AwayState = { seenKey: null, away: 0 };

/** `keys`: item keys, newest first. A vanished anchor (a folded turn, a re-read room) keeps the previous count. */
export function trackAway(s: AwayState, keys: readonly string[], bottom: boolean): AwayState {
  if (keys.length === 0) return start;
  if (bottom || s.seenKey === null) return { seenKey: keys[0]!, away: 0 };
  const at = keys.indexOf(s.seenKey);
  return at < 0 ? s : { seenKey: s.seenKey, away: at };
}
