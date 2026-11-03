// The hook over the follow-the-end controller (A44): the same wiring for the session feed and the room feed.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { createFollowController } from './follow-controller';
import type { ScrollMetrics } from './follow-end';

const metrics = (e: NativeSyntheticEvent<NativeScrollEvent>): ScrollMetrics => ({
  offset: e.nativeEvent.contentOffset.y,
  content: e.nativeEvent.contentSize.height,
  viewport: e.nativeEvent.layoutMeasurement.height,
});

/** The native scroll view takes the real content size (with the container's bottom padding); the list estimates it. */
function scrollToEnd(list: FlatList<never> | null, animated: boolean): void {
  if (list === null) return;
  const native = list.getNativeScrollRef() as { scrollToEnd?: (o: { animated: boolean }) => void } | null;
  if (typeof native?.scrollToEnd === 'function') native.scrollToEnd({ animated });
  else list.scrollToEnd({ animated });
}

/** `keys`: the item keys in list order; "new" is whatever comes after the last item the human has seen. */
export function useFollowEnd<T>(list: React.RefObject<FlatList<T> | null>, keys: readonly string[]) {
  const [away, setAway] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const listRef = useRef(list);
  listRef.current = list;
  const ctl = useMemo(
    () => createFollowController({ scrollToEnd: (animated) => scrollToEnd(listRef.current.current as FlatList<never> | null, animated), onAway: setAway, onReveal: () => setRevealed(true), now: Date.now }),
    [],
  );
  ctl.setKeys(keys);
  useEffect(() => () => ctl.dispose(), [ctl]);

  return {
    away,
    /** A44b: false while the pin brings the list to the end; the screen draws it with opacity 0 until then. */
    revealed,
    jump: ctl.jump,
    keepEnd: ctl.keepEnd,
    leave: ctl.leave,
    isPinned: ctl.isPinned,
    devAway: ctl.devAway,
    handlers: useMemo(
      () => ({
        onContentSizeChange: (_w: number, h: number) => ctl.contentSizeChanged(h),
        onLayout: (e: LayoutChangeEvent) => ctl.layout(e.nativeEvent.layout.height),
        onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => ctl.scroll(metrics(e)),
        onScrollBeginDrag: () => ctl.beginDrag(),
        onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const v = e.nativeEvent.velocity;
          ctl.endDrag(metrics(e), v !== undefined && Math.abs(v.y) > 0.01);
        },
        onMomentumScrollBegin: () => ctl.momentumBegin(),
        onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) => ctl.momentumEnd(metrics(e)),
        // The status-bar tap scrolls to the start without a drag: the feed has left the end.
        onScrollToTop: () => ctl.leave(),
      }),
      [ctl],
    ),
  };
}
