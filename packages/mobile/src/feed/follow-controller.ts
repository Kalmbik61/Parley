// The imperative side of "follow the end" (A44): timers, the repeat after growth, and the calls into the list. No React,
// so it is tested with fake timers; `use-follow-end.ts` only binds it to a FlatList.
import * as fe from './follow-end';

/** The size callback runs before the native side applies the new size: scroll once more when it has settled. */
export const SETTLE_MS = 80;

export interface FollowIo {
  scrollToEnd(animated: boolean): void;
  onAway(away: number): void;
  /** A44b: the list became visible (once per open). */
  onReveal(): void;
  now(): number;
}

export function createFollowController(io: FollowIo) {
  let state = fe.open();
  let keys: readonly string[] = [];
  let pinTimer: ReturnType<typeof setTimeout> | null = null;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const commit = (next: fe.FollowState): void => {
    const away = state.away;
    const shown = state.revealed;
    state = next;
    if (next.away !== away) io.onAway(next.away);
    if (next.revealed && !shown) io.onReveal();
  };
  const run = (step: fe.Step): void => {
    commit(step.state);
    if (step.scroll !== 'none') {
      io.scrollToEnd(step.scroll === 'animated');
      settle();
    }
  };
  /** One repeat while the human is still at the end and not touching the feed. */
  const settle = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const step = fe.keepEnd(state, io.now());
      commit(step.state);
      if (step.scroll !== 'none') io.scrollToEnd(false);
    }, SETTLE_MS);
  };
  const armPin = (): void => {
    if (pinTimer !== null) clearTimeout(pinTimer);
    pinTimer = null;
    const wait = fe.pinDeadline(state, io.now());
    if (wait === null) return;
    pinTimer = setTimeout(() => {
      pinTimer = null;
      commit(fe.tick(state, io.now()));
      armPin();
    }, wait + 1);
  };

  /** The reveal check: one frame after the last growth, or at the cap since the first rows. */
  const armReveal = (): void => {
    if (revealTimer !== null) clearTimeout(revealTimer);
    revealTimer = null;
    const wait = fe.revealDeadline(state, io.now());
    if (wait === null) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      commit(fe.revealCheck(state, io.now()));
      armReveal();
    }, wait + 1);
  };

  return {
    /** Called on every render with the current item keys (the order of the list). */
    setKeys(next: readonly string[]): void {
      keys = next;
    },
    contentSizeChanged(content?: number): void {
      run(fe.contentChanged(state, io.now(), keys, content));
      armPin();
      armReveal();
    },
    layout(height: number): void {
      run(fe.viewportChanged(state, height, io.now()));
    },
    scroll(m: fe.ScrollMetrics): void {
      commit(fe.scrolled(state, m, io.now(), keys));
    },
    beginDrag(): void {
      commit(fe.dragBegan(state));
    },
    endDrag(m: fe.ScrollMetrics, willDecelerate: boolean): void {
      run(fe.dragEnded(state, m, io.now(), keys, willDecelerate));
    },
    momentumBegin(): void {
      commit(fe.momentumBegan(state, io.now()));
    },
    momentumEnd(m: fe.ScrollMetrics): void {
      run(fe.momentumEnded(state, m, io.now(), keys));
    },
    /** A quote jump, a status-bar tap or an expanded group: not at the end any more. */
    leave(): void {
      commit(fe.left(state, keys));
    },
    jump(): void {
      run(fe.jumped(state, io.now(), keys));
    },
    /** The strip stack changed height. */
    keepEnd(): void {
      run(fe.keepEnd(state, io.now()));
    },
    isPinned: (): boolean => state.pinned,
    state: (): fe.FollowState => state,
    devAway(n: number): void {
      commit(fe.previewAway(state, keys, n));
    },
    dispose(): void {
      if (pinTimer !== null) clearTimeout(pinTimer);
      if (revealTimer !== null) clearTimeout(revealTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      pinTimer = settleTimer = revealTimer = null;
    },
  };
}
