// The hook over the tail window (A44b): the same wiring for the session feed and the room feed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { anchorAt, anchorStart, startToInclude, TAIL, widenedStart, type Anchor, type SpanAt } from './window';

/** `keys`: the item keys, oldest first. */
export function useTailWindow(keys: readonly string[], spanAt: SpanAt) {
  const [anchor, setAnchor] = useState<Anchor>(TAIL);
  const start = useMemo(() => anchorStart(keys, anchor, spanAt), [keys, anchor, spanAt]);
  // The window is chosen once, at the open, from the rows there are by then.
  const hasRows = keys.length > 0;
  useEffect(() => {
    if (anchor === TAIL && hasRows) setAnchor(anchorAt(keys, start));
  }, [anchor, hasRows]);

  const latest = useRef({ keys, spanAt, start });
  latest.current = { keys, spanAt, start };
  const nearStart = useRef(false);

  /** A44c: the feed starts over like the first open: the last rows again, the anchor is chosen anew. */
  const reset = useCallback(() => setAnchor(TAIL), []);
  /** One more page of older rows. */
  const widen = useCallback(() => {
    const l = latest.current;
    setAnchor(anchorAt(l.keys, widenedStart(l.start, l.spanAt)));
  }, []);
  /** A jump to the row at `index`: the window grows to contain it first. */
  const include = useCallback((index: number) => {
    const l = latest.current;
    setAnchor(anchorAt(l.keys, startToInclude(l.start, index, l.spanAt)));
  }, []);
  /** The list was just shown. If it stands at the start of the window it was told nothing while hidden: widen once here. */
  const onRevealed = useCallback(() => {
    if (nearStart.current && latest.current.start > 0) widen();
  }, [widen]);

  return {
    start,
    widen,
    reset,
    include,
    onRevealed,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      nearStart.current = e.nativeEvent.contentOffset.y <= e.nativeEvent.layoutMeasurement.height;
    },
  };
}
