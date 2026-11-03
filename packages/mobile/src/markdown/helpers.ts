// Pure display rules of the Markdown renderer (kept out of Markdown.tsx so tests run without React Native).
import type { MdNode } from './parse';

/** Inline code: no break at a hyphen (U+2060 word joiner after each `-`, display only); a path breaks at `/`. */
export const noHyphenBreak = (s: string): string => s.replace(/-/g, '-\u2060');

/** Plain text of inline nodes (width estimate of a table cell). */
export function plainText(n: MdNode): string {
  if (n.type === 'break') return ' ';
  if (n.type === 'mention' || n.type === 'humanMention') return n.raw ?? '';
  if (n.type === 'image' || n.type === 'imageReference') return '[Image not loaded]';
  if (n.value !== undefined) return n.value;
  return (n.children ?? []).map(plainText).join('');
}

/** Estimated width of a cell in characters: inline code counts 1.1 (Menlo is wider than the text face). */
function weight(n: MdNode): number {
  if (n.type === 'inlineCode') return (n.value ?? '').length * 1.1;
  if (n.children !== undefined) return n.children.reduce((sum, c) => sum + weight(c), 0);
  return plainText(n).length;
}

/** Table column width rule: longest cell × 8pt + 20pt padding, clamped to 64…200pt; longer cells wrap inside the column. */
export const COL_CHAR = 8;
export const COL_PAD = 20;
export const COL_MIN = 64;
export const COL_MAX = 200;
export function columnWidths(rows: MdNode[]): number[] {
  const count = Math.max(0, ...rows.map((r) => r.children?.length ?? 0));
  return Array.from({ length: count }, (_, col) => {
    const longest = Math.max(0, ...rows.map((r) => weight(r.children?.[col] ?? { type: 'text', value: '' })));
    return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(longest * COL_CHAR) + COL_PAD));
  });
}

