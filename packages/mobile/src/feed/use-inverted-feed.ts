// The hook over the inverted feed (A44b): the same wiring for the session feed and the room feed.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { atBottom, NEAR_BOTTOM, start, trackAway, type AwayState } from './inverted';

/** `keys`: the item keys in list order, newest first. */
export function useInvertedFeed<T>(list: React.RefObject<FlatList<T> | null>, keys: readonly string[]) {
  const [state, setState] = useState<AwayState>(start);
  const bottom = useRef(true);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const step = (next: boolean): void => {
    bottom.current = next;
    setState((s) => {
      const n = trackAway(s, keysRef.current, next);
      return n.seenKey === s.seenKey && n.away === s.away ? s : n;
    });
  };
  useEffect(() => step(bottom.current), [keys]);

  return {
    away: state.away,
    /** The capsule: back to the latest message. */
    jump: () => list.current?.scrollToOffset({ offset: 0, animated: true }),
    // Native: new items stick at offset 0 only while the person is within the threshold; history never moves.
    maintainVisibleContentPosition: useMemo(() => ({ minIndexForVisible: 0, autoscrollToTopThreshold: NEAR_BOTTOM }), []),
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = atBottom(e.nativeEvent.contentOffset.y);
      if (next !== bottom.current) step(next);
    },
  };
}
