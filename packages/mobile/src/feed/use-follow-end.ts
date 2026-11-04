// The hook over the follow-the-end controller (A44): the same wiring for the session feed and the room feed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
export function useFollowEnd<T>(list: React.RefObject<FlatList<T> | null>, keys: readonly string[], onReopen: () => void) {
  const [away, setAway] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const listRef = useRef(list);
  listRef.current = list;
  const reopenRef = useRef(onReopen);
  reopenRef.current = onReopen;
  const ctl = useMemo(
    () =>
      createFollowController({
        scrollToEnd: (animated) => scrollToEnd(listRef.current.current as FlatList<never> | null, animated),
        onAway: setAway,
        onReveal: () => setRevealed(true),
        onConceal: () => setRevealed(false),
        onReopen: () => reopenRef.current(),
        now: Date.now,
      }),
    [],
  );
  // A44c: the second and later instances of the list are a remount (a skeleton replaced the screen).
  const mounted = useRef(false);
  const attach = useCallback(
    (instance: FlatList<T> | null) => {
      (list as { current: FlatList<T> | null }).current = instance;
      if (instance === null) return;
      if (mounted.current) ctl.remounted();
      mounted.current = true;
    },
    [ctl, list],
  );
  ctl.setKeys(keys);
  useEffect(() => () => ctl.dispose(), [ctl]);

  return {
    away,
    /** A44b: false while the pin brings the list to the end; the screen draws it with opacity 0 until then. */
    revealed,
    /** The `ref` of the list. */
    attach,
    /** A44c: the feed was read again; call from a layout effect after the render with the new rows. */
    reread: ctl.reread,
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
