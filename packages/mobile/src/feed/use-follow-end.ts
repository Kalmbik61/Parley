// The hook over the follow-the-end state machine (A44): the same wiring for the session feed and the room feed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import * as fe from './follow-end';

const SETTLE_MS = 80;

const metrics = (e: NativeSyntheticEvent<NativeScrollEvent>): fe.ScrollMetrics => ({
  offset: e.nativeEvent.contentOffset.y,
  content: e.nativeEvent.contentSize.height,
  viewport: e.nativeEvent.layoutMeasurement.height,
});

/** `count`: the number of feed items that can be "new" (anything prepended at the top must not be counted). */
export function useFollowEnd<T>(list: React.RefObject<FlatList<T> | null>, count: number) {
  const state = useRef<fe.FollowState>(fe.open(Date.now()));
  const countRef = useRef(count);
  countRef.current = count;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [away, setAway] = useState(0);

  const set = useCallback((next: fe.FollowState) => {
    state.current = next;
    setAway((a) => (a === next.away ? a : next.away));
  }, []);
  const scrollTo = (how: fe.ScrollTo): void => {
    if (how !== 'none') list.current?.scrollToEnd({ animated: how === 'animated' });
  };
  const arm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const wait = fe.pinDeadline(state.current, Date.now());
    if (wait === null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      set(fe.tick(state.current, Date.now()));
      arm();
    }, wait + 1);
  }, [set]);
  useEffect(() => {
    arm();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (settle.current !== null) clearTimeout(settle.current);
    };
  }, [arm]);

  const onContentSizeChange = useCallback((): void => {
    const step = fe.contentChanged(state.current, Date.now(), countRef.current);
    set(step.state);
    scrollTo(step.scroll);
    // The size callback runs before the native side has applied the new size, so the scroll above aims at a stale end:
    // once the growth settles, scroll again while the human is still at the end.
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = step.scroll === 'none' ? null : setTimeout(() => {
      settle.current = null;
      if (state.current.atBottom) list.current?.scrollToEnd({ animated: false });
    }, SETTLE_MS);
    arm();
  }, [set, arm]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>): void => set(fe.scrolled(state.current, metrics(e), countRef.current)), [set]);
  const onScrollBeginDrag = useCallback((): void => set(fe.gestureBegan(state.current)), [set]);
  // iOS also reports momentum begin/end for a programmatic scrollToEnd: only a momentum that follows a drag is the human's.
  const onMomentumScrollBegin = useCallback((): void => {
    if (state.current.gesture) set(fe.gestureBegan(state.current));
  }, [set]);
  const onScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const v = e.nativeEvent.velocity;
    set(fe.dragEnded(state.current, metrics(e), countRef.current, v !== undefined && Math.abs(v.y) > 0.01));
  }, [set]);
  const onMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (state.current.gesture) set(fe.momentumEnded(state.current, metrics(e), countRef.current));
  }, [set]);
  /** "Jump to latest" and the strip's tap. */
  const jump = useCallback((): void => {
    const step = fe.jumped(state.current, countRef.current);
    set(step.state);
    scrollTo(step.scroll);
  }, [set]);
  /** The strip stack changed height: keep the end in view when the human is there. */
  const keepEnd = useCallback((): void => {
    if (state.current.atBottom) list.current?.scrollToEnd({ animated: false });
  }, [list]);

  return {
    away,
    jump,
    keepEnd,
    isPinned: () => state.current.pinned,
    /** Developer preview only: show the capsule (a scroll-up in screenshots needs a finger). */
    devAway: (n: number): void => set(fe.previewAway(state.current, n)),
    handlers: { onContentSizeChange, onScroll, onScrollBeginDrag, onScrollEndDrag, onMomentumScrollBegin, onMomentumScrollEnd },
  };
}
