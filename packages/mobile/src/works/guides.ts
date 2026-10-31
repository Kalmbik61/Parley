// Tree-line geometry of D1 §8.2 (the window's `TreeGuides`): for each row of a tree given by relative depths, which
// ancestor trunks pass through it and whether it ends its parent's list (corner) or not (tee). Pure.
export interface GuideSpec {
  depth: number;
  /** `continues[k - 1]`: the trunk of level `k` (1 ≤ k < depth) keeps going past this row. */
  continues: boolean[];
  /** Last child of its parent: the trunk ends in a rounded corner instead of a tee. */
  last: boolean;
}

/** `depths` — relative depth of every row in order (≥ 1). */
export function computeGuides(depths: readonly number[]): GuideSpec[] {
  // Rows after `i` that are `d` deep, reached before any shallower row, are later siblings of level `d`.
  const hasLater = (i: number, d: number): boolean => {
    for (let j = i + 1; j < depths.length; j++) {
      const dj = depths[j]!;
      if (dj < d) return false;
      if (dj === d) return true;
    }
    return false;
  };
  return depths.map((depth, i) => ({
    depth,
    continues: Array.from({ length: Math.max(0, depth - 1) }, (_, k) => hasLater(i, k + 1)),
    last: !hasLater(i, depth),
  }));
}

export const STUB = 14;
/** Trunk x of level `k` (1-based): under the centre of the 36 pt avatar, then one indent per level. */
export const trunkX = (k: number, indent: number): number => 30 + (k - 1) * indent;
/** Left edge of a row's content at depth `d`: past the trunk and its stub. */
export const contentLeft = (d: number, indent: number): number => trunkX(d, indent) + STUB + 2;
/** D1 §18: from accessibility1 the indent shrinks to 16 pt. */
export const indentFor = (fontScale: number): number => (fontScale >= 1.35 ? 16 : 28);
