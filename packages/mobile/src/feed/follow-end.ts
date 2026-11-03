// "Follow the end" of a feed (A44), shared by the session feed and the room feed. No React.
//
// Why it exists: rows below the window are drawn with estimated heights and their real heights (Markdown, tables, code,
// images) arrive later. The old code decided "at the bottom" from every `onScroll`, so the scroll event caused by that
// growth set `atBottom = false` and following stopped in the middle of the feed.
//
// Rules (D1 §9.2): after the first rows arrive the feed is `pinned`: every content height change scrolls to the end.
// Pinning ends after PIN_QUIET_MS without a height change (at most PIN_MAX_MS), or at once when the human touches the
// feed. "At the bottom" is decided by POSITION, but a scroll event caused by growth of the content or the window, or by
// our own scroll, does not change it. Leaving the end by a quote jump, a status-bar tap or VoiceOver is a position change
// like any other. While a finger is on the feed nothing scrolls it; growth is remembered and applied once on release.

export const PIN_QUIET_MS = 500;
export const PIN_MAX_MS = 3000;
/** A44b: the feed stays invisible while the pin works; it shows after one frame without growth, at the latest after this. */
export const REVEAL_FRAME_MS = 32;
export const REVEAL_CAP_MS = 600;
export const NEAR_BOTTOM = 80;
/** A scroll event this soon after a size change is the echo of that change. */
export const GROWTH_ECHO_MS = 150;
/** Our own scroll is in flight for at most this long (a momentum end clears it sooner). */
export const OWN_SCROLL_MS = 600;

export interface ScrollMetrics {
  readonly offset: number;
  readonly content: number;
  readonly viewport: number;
}

export interface FollowState {
  /** Following the end without looking at the position, until the first render settles. */
  readonly pinned: boolean;
  /** A44b: the list is visible. False from the open until the pin has brought it to the end and the height settled. */
  readonly revealed: boolean;
  readonly atBottom: boolean;
  /** A finger is on the feed (drag begin … drag end). */
  readonly touching: boolean;
  /** The human's own momentum after a drag. */
  readonly momentum: boolean;
  /** The feed has had rows since the pin started. */
  readonly hadRows: boolean;
  readonly openedAt: number | null;
  readonly lastGrowthAt: number;
  readonly ownUntil: number;
  readonly echoUntil: number;
  readonly scrollContent: number | null;
  readonly scrollViewport: number | null;
  readonly scrollOffset: number | null;
  readonly layoutHeight: number | null;
  /** The latest content height reported by the size callback. */
  readonly contentHeight: number | null;
  /** Growth that arrived while a finger was down: one scroll on release, if still at the bottom. */
  readonly pendingGrowth: boolean;
  /** The last item the human has seen; "new" is what comes after it. */
  readonly seenKey: string | null;
  /** New items while the human is away from the bottom: the "Jump to latest" count. */
  readonly away: number;
}

export type ScrollTo = 'none' | 'instant' | 'animated';

export interface Step {
  readonly state: FollowState;
  readonly scroll: ScrollTo;
}

export const nearBottom = (m: ScrollMetrics): boolean => m.content - m.viewport - m.offset < NEAR_BOTTOM;

const last = (keys: readonly string[]): string | null => (keys.length === 0 ? null : keys[keys.length - 1]!);

/** Items after the last seen one. A vanished anchor (a folded turn, a re-read room) keeps the previous count. */
export function countAfter(keys: readonly string[], seenKey: string | null, previous: number): number {
  if (seenKey === null) return previous;
  const at = keys.lastIndexOf(seenKey);
  return at < 0 ? previous : keys.length - 1 - at;
}

export function open(): FollowState {
  return {
    pinned: true, revealed: false, atBottom: true, touching: false, momentum: false, hadRows: false, openedAt: null, lastGrowthAt: 0, ownUntil: 0,
    echoUntil: 0, scrollContent: null, scrollViewport: null, scrollOffset: null, layoutHeight: null, contentHeight: null, pendingGrowth: false, seenKey: null, away: 0,
  };
}

const own = (s: FollowState, now: number): boolean => now < s.ownUntil;
const humanBusy = (s: FollowState): boolean => s.touching || s.momentum;
const issue = (s: FollowState, now: number, how: ScrollTo): Step => ({ state: how === 'none' ? s : { ...s, ownUntil: now + OWN_SCROLL_MS }, scroll: how });

function evaluate(s: FollowState, m: ScrollMetrics, keys: readonly string[]): FollowState {
  return nearBottom(m) ? { ...s, atBottom: true, seenKey: last(keys), away: 0 } : { ...s, atBottom: false };
}

/** The content height changed or items were added. `content`: the new content height, when known (a feed that fits the window needs no scroll and shows at once). */
export function contentChanged(s: FollowState, now: number, keys: readonly string[], content?: number): Step {
  if (keys.length === 0) return { state: { ...s, hadRows: false }, scroll: 'none' };
  // The pin starts (or restarts) at the first change that has real rows, not at mount: a skeleton does not count.
  const first = !s.hadRows;
  const base: FollowState = first
    ? { ...s, hadRows: true, pinned: !s.touching, openedAt: now, lastGrowthAt: now, echoUntil: now + GROWTH_ECHO_MS }
    : { ...s, lastGrowthAt: now, echoUntil: now + GROWTH_ECHO_MS };
  const sized: FollowState = content === undefined ? base : { ...base, contentHeight: content };
  const fits = content !== undefined && base.layoutHeight !== null && content <= base.layoutHeight;
  const shown: FollowState = fits ? { ...sized, revealed: true } : sized;
  return follow(shown, now, keys, first);
}

function follow(base: FollowState, now: number, keys: readonly string[], first: boolean): Step {
  if (base.pinned || base.atBottom) {
    const following: FollowState = { ...base, seenKey: last(keys), away: 0 };
    if (humanBusy(following)) return { state: { ...following, pendingGrowth: true }, scroll: 'none' };
    return issue(following, now, first || following.pinned ? 'instant' : 'animated');
  }
  return { state: { ...base, away: countAfter(keys, base.seenKey, base.away) }, scroll: 'none' };
}

/** The last scroll event saw the latest content height and was at its end: the pin's scroll has landed. */
function landed(s: FollowState): boolean {
  if (s.scrollContent === null || s.scrollViewport === null || s.scrollOffset === null) return false;
  if (s.contentHeight !== null && s.scrollContent < s.contentHeight - 1) return false;
  return nearBottom({ offset: s.scrollOffset, content: s.scrollContent, viewport: s.scrollViewport });
}

/** Time passed: the feed shows once the pin's scroll has landed at the end and one frame passed without growth, or at the cap since the first real rows. A skeleton-only phase has no `openedAt`, so it starts nothing. */
export function revealCheck(s: FollowState, now: number): FollowState {
  if (s.revealed || !s.hadRows || s.openedAt === null) return s;
  const quiet = now - s.lastGrowthAt >= REVEAL_FRAME_MS && landed(s);
  return quiet || now - s.openedAt >= REVEAL_CAP_MS ? { ...s, revealed: true } : s;
}

/** Milliseconds until the feed may be revealed; null when it is shown or has no rows yet. A scroll event re-checks sooner. */
export function revealDeadline(s: FollowState, now: number): number | null {
  if (s.revealed || !s.hadRows || s.openedAt === null) return null;
  const cap = s.openedAt + REVEAL_CAP_MS;
  const quietAt = s.lastGrowthAt + REVEAL_FRAME_MS;
  return Math.max(0, (now >= quietAt && !landed(s) ? cap : Math.min(quietAt, cap)) - now);
}

/** Time passed: the pin ends after a quiet spell or at the cap. */
export function tick(s: FollowState, now: number): FollowState {
  if (!s.pinned || s.openedAt === null) return s;
  if (now - s.lastGrowthAt >= PIN_QUIET_MS || now - s.openedAt >= PIN_MAX_MS) return { ...s, pinned: false };
  return s;
}

/** Milliseconds until the pin may end; null when it is not pinned or has no rows yet. */
export function pinDeadline(s: FollowState, now: number): number | null {
  if (!s.pinned || s.openedAt === null) return null;
  return Math.max(0, Math.min(s.lastGrowthAt + PIN_QUIET_MS, s.openedAt + PIN_MAX_MS) - now);
}

/** A scroll event. Growth, a window resize and our own scroll do not move `atBottom`; the human's scrolling and any other position change do. */
export function scrolled(s: FollowState, m: ScrollMetrics, now: number, keys: readonly string[]): FollowState {
  const grown = s.scrollContent === null || m.content !== s.scrollContent || m.viewport !== s.scrollViewport;
  const movedUp = s.scrollOffset !== null && m.offset < s.scrollOffset - 1;
  const next = { ...s, scrollContent: m.content, scrollViewport: m.viewport, scrollOffset: m.offset };
  if (humanBusy(next)) return evaluate(next, m, keys);
  // Our own scrolls and the echo of growth never move the feed UP: an upward move far from the end with the same
  // content height is someone else's (VoiceOver, a status-bar tap), even inside the echo window (critic A44 N6).
  if (!grown && movedUp && !nearBottom(m) && !next.pinned) return evaluate(next, m, keys);
  if (next.pinned || grown || now < next.echoUntil || own(next, now)) return next;
  return evaluate(next, m, keys);
}

/** A finger went down: the pin ends and nothing scrolls the feed until it lifts. */
export function dragBegan(s: FollowState): FollowState {
  return { ...s, pinned: false, revealed: true, touching: true, momentum: false };
}

/** The finger lifted. With momentum the human's scroll goes on until `momentumEnded`. */
export function dragEnded(s: FollowState, m: ScrollMetrics, now: number, keys: readonly string[], willDecelerate: boolean): Step {
  const next = evaluate({ ...s, touching: false, momentum: willDecelerate }, m, keys);
  if (willDecelerate) return { state: next, scroll: 'none' };
  const settled = { ...next, pendingGrowth: false };
  return next.atBottom && s.pendingGrowth ? issue(settled, now, 'instant') : { state: settled, scroll: 'none' };
}

/** A momentum begin: the human's flick, unless it is the echo of our own scroll. */
export function momentumBegan(s: FollowState, now: number): FollowState {
  if (s.touching || own(s, now)) return s;
  return { ...s, pinned: false, momentum: true };
}

/** A momentum end. While a finger is down it is ignored (iOS reports it for programmatic scrolls too); after our own scroll it only clears the flag. */
export function momentumEnded(s: FollowState, m: ScrollMetrics, now: number, keys: readonly string[]): Step {
  if (s.touching) return { state: s, scroll: 'none' };
  if (own(s, now) && !s.momentum) return { state: { ...s, ownUntil: 0 }, scroll: 'none' };
  const next = evaluate({ ...s, momentum: false, ownUntil: 0 }, m, keys);
  if (next.atBottom && s.pendingGrowth) return issue({ ...next, pendingGrowth: false }, now, 'instant');
  return { state: { ...next, pendingGrowth: next.atBottom ? next.pendingGrowth : false }, scroll: 'none' };
}

/** The window of the list changed height (keyboard, multi-line draft, reply plate, Sleeping row, cards, mention menu). */
export function viewportChanged(s: FollowState, height: number, now: number): Step {
  const shrunk = s.layoutHeight !== null && height < s.layoutHeight;
  const next = { ...s, layoutHeight: height, echoUntil: now + GROWTH_ECHO_MS };
  if (shrunk && next.atBottom && !humanBusy(next)) return issue(next, now, 'instant');
  return { state: next, scroll: 'none' };
}

/** The human is at the end and something moved it (a strip, a repeat after growth): put the end back in view. */
export function keepEnd(s: FollowState, now: number): Step {
  if (s.atBottom && !humanBusy(s)) return issue(s, now, 'instant');
  return { state: s, scroll: 'none' };
}

/** The feed leaves the end by something other than a drag: a quote jump, a status-bar tap, an expanded group. */
export function left(s: FollowState, keys: readonly string[]): FollowState {
  return { ...s, atBottom: false, pinned: false, seenKey: last(keys) };
}

/** "Jump to latest" or the strip's tap: go to the end and follow again. */
export function jumped(s: FollowState, now: number, keys: readonly string[]): Step {
  return issue({ ...s, atBottom: true, pinned: false, touching: false, momentum: false, pendingGrowth: false, seenKey: last(keys), away: 0 }, now, 'animated');
}

/** Developer preview only (screenshots): the state of a person who scrolled up while `away` items arrived. */
export function previewAway(s: FollowState, keys: readonly string[], away: number): FollowState {
  return { ...s, pinned: false, atBottom: false, seenKey: keys[Math.max(0, keys.length - 1 - away)] ?? null, away };
}
