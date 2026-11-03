// "Follow the end" of a feed (A44), shared by the session feed and the room feed. No React.
//
// Why it exists: rows below the window are drawn with estimated heights and their real heights (Markdown, tables, code,
// images) arrive later. The old code decided "at the bottom" from every `onScroll`, so the scroll event caused by that
// growth set `atBottom = false` and following stopped in the middle of the feed.
//
// Rules: after `open` the feed is `pinned`: every content height change scrolls to the end. Pinning ends after
// PIN_QUIET_MS without a height change (at most PIN_MAX_MS from the open) or at once on a human gesture. After that
// "not at the bottom" is decided only by the human's own scrolling (drag / momentum), never by growth.

export const PIN_QUIET_MS = 500;
export const PIN_MAX_MS = 3000;
export const NEAR_BOTTOM = 80;

export interface ScrollMetrics {
  readonly offset: number;
  readonly content: number;
  readonly viewport: number;
}

export interface FollowState {
  readonly pinned: boolean;
  readonly atBottom: boolean;
  /** A human gesture (drag or momentum) is in progress: only then does a scroll event move `atBottom`. */
  readonly gesture: boolean;
  readonly openedAt: number;
  readonly lastGrowthAt: number;
  /** Items the human has seen (the end of the feed was in view). */
  readonly seen: number;
  /** New items while the human is away from the bottom: the "Jump to latest" count. */
  readonly away: number;
}

export type ScrollTo = 'none' | 'instant' | 'animated';

export interface Step {
  readonly state: FollowState;
  readonly scroll: ScrollTo;
}

export const nearBottom = (m: ScrollMetrics): boolean => m.content - m.viewport - m.offset < NEAR_BOTTOM;

export function open(now: number): FollowState {
  return { pinned: true, atBottom: true, gesture: false, openedAt: now, lastGrowthAt: now, seen: 0, away: 0 };
}

/** The content height changed (or items were added). `count` is the number of feed items now. */
export function contentChanged(s: FollowState, now: number, count: number): Step {
  if (s.pinned || s.atBottom) {
    // The first fill is not animated: the screen opens at the end.
    const scroll: ScrollTo = s.seen === 0 ? 'instant' : s.pinned ? 'instant' : 'animated';
    return { state: { ...s, lastGrowthAt: now, seen: count, away: 0 }, scroll };
  }
  return { state: { ...s, lastGrowthAt: now, away: Math.max(0, count - s.seen) }, scroll: 'none' };
}

/** Time passed: the pin ends after a quiet spell or at the cap. */
export function tick(s: FollowState, now: number): FollowState {
  if (!s.pinned) return s;
  if (now - s.lastGrowthAt >= PIN_QUIET_MS || now - s.openedAt >= PIN_MAX_MS) return { ...s, pinned: false };
  return s;
}

/** Milliseconds until the pin may end; null when it is not pinned. */
export function pinDeadline(s: FollowState, now: number): number | null {
  if (!s.pinned) return null;
  return Math.max(0, Math.min(s.lastGrowthAt + PIN_QUIET_MS, s.openedAt + PIN_MAX_MS) - now);
}

/** The human put a finger on the feed or the momentum began: the pin ends at once. */
export function gestureBegan(s: FollowState): FollowState {
  return { ...s, pinned: false, gesture: true };
}

function evaluate(s: FollowState, m: ScrollMetrics, count: number): FollowState {
  const bottom = nearBottom(m);
  return bottom ? { ...s, atBottom: true, seen: count, away: 0 } : { ...s, atBottom: false };
}

/** A scroll event: counts only while a human gesture is in progress, so growth cannot unset `atBottom`. */
export function scrolled(s: FollowState, m: ScrollMetrics, count: number): FollowState {
  return s.gesture ? evaluate(s, m, count) : s;
}

/** The finger lifted. With momentum the gesture goes on until `momentumEnded`. */
export function dragEnded(s: FollowState, m: ScrollMetrics, count: number, willDecelerate: boolean): FollowState {
  const next = evaluate(s, m, count);
  return willDecelerate ? next : { ...next, gesture: false };
}

export function momentumEnded(s: FollowState, m: ScrollMetrics, count: number): FollowState {
  return { ...evaluate(s, m, count), gesture: false };
}

/** "Jump to latest" or the strip's tap: go to the end and follow again. */
export function jumped(s: FollowState, count: number): Step {
  return { state: { ...s, atBottom: true, pinned: false, gesture: false, seen: count, away: 0 }, scroll: 'animated' };
}

/** Developer preview only (screenshots): the state of a person who scrolled up while new items arrived. */
export function previewAway(s: FollowState, away: number): FollowState {
  return { ...s, pinned: false, atBottom: false, gesture: false, seen: Math.max(0, s.seen - away), away };
}
