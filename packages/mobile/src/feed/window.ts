// The tail window of a feed (A44b, third round). No React.
//
// A virtualized list draws the first `initialNumToRender` rows first and learns the rest of its height later, so a long
// feed of short rows looked "short" at the open, was revealed at its top and then scrolled. The list is therefore given
// only the LAST rows (folding happens first, so a group never splits at the window's edge), all drawn and measured in
// one pass; older rows are added from the top when the person reads towards the start.
//
// The window is anchored by the KEY of its first row, chosen once at the open: new rows extend it at the bottom and never
// push its top away. Once it reaches the first row it stays "all": a page of older rows that arrives from the Mac is in
// the window at once.

/** Rows in the first window. Equals `initialNumToRender` of the lists and `maxToRenderPerBatch` while the list is hidden. */
export const WINDOW_ROWS = 30;

/** `spanAt(i)`: how many rows right after row `i` belong to it (an opened group: its items); 0 for a plain row. */
export type SpanAt = (index: number) => number;

/** `'tail'`: not chosen yet (the last WINDOW_ROWS); `'all'`: from the first row; otherwise the key of the first row. */
export type Anchor = 'tail' | 'all' | { readonly key: string };
export const TAIL: Anchor = 'tail';

/** `start` moved up to the start of a block it would cut. */
function blockStart(start: number, spanAt: SpanAt): number {
  for (let i = 0; i < start; i++) {
    if (i + spanAt(i) >= start) return i;
  }
  return start;
}

/** Index of the first row of the window. */
export function anchorStart(keys: readonly string[], anchor: Anchor, spanAt: SpanAt): number {
  if (anchor === 'all') return 0;
  if (anchor !== 'tail') {
    const at = keys.indexOf(anchor.key);
    if (at >= 0) return blockStart(at, spanAt);
  }
  return blockStart(Math.max(0, keys.length - WINDOW_ROWS), spanAt);
}

/** The anchor that keeps a window starting at `start`. */
export const anchorAt = (keys: readonly string[], start: number): Anchor => (start <= 0 || keys[start] === undefined ? 'all' : { key: keys[start]! });

/** The start after one more page of older rows. */
export const widenedStart = (start: number, spanAt: SpanAt, by = WINDOW_ROWS): number => blockStart(Math.max(0, start - by), spanAt);

/** The start that contains the row at `index` (a quote jump), with a little context above it; never lower than needed. */
export const startToInclude = (start: number, index: number, spanAt: SpanAt, context = 3): number => (index >= start ? start : blockStart(Math.max(0, index - context), spanAt));
