// The tail window of a feed (A44b, third round). No React.
//
// A virtualized list draws the first `initialNumToRender` rows first and learns the rest of its height later, so a long
// feed of short rows looked "short" at the open, was revealed at its top and then scrolled. The list is therefore given
// only the LAST `size` rows (folding happens first, so a group never splits at the window's edge), all drawn and measured
// in one pass; older rows are added from the top when the person reads towards the start.

/** Rows in the first window. Equals `initialNumToRender` and `maxToRenderPerBatch` of the lists. */
export const WINDOW_ROWS = 30;

/** `spanAt(i)`: how many rows right after row `i` belong to it (an opened group: its items); 0 for a plain row. */
export type SpanAt = (index: number) => number;

/** Index of the first row of the window: the last `size` of `length` rows, moved up to the start of a block it would cut. */
export function windowStart(length: number, size: number, spanAt: SpanAt): number {
  let start = Math.max(0, length - size);
  for (let i = 0; i < start; i++) {
    if (i + spanAt(i) >= start) {
      start = i;
      break;
    }
  }
  return start;
}

/** One more page of older rows. */
export const widened = (length: number, size: number, by = WINDOW_ROWS): number => Math.min(length, size + by);

/** A size that contains the row at `index` (a quote jump), with a little context above it. */
export const sizeToInclude = (length: number, size: number, index: number, context = 3): number => Math.min(length, Math.max(size, length - index + context));
