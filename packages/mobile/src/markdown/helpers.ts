// Pure display rules of the Markdown renderer (kept out of Markdown.tsx so tests run without React Native).
import { hostOf, isOpenableUrl, type MdNode } from './parse';

export type Defs = Map<string, { url: string; title: string | null }>;

/** Inline code: no break at a hyphen (U+2060 word joiner after each `-`, display only); a path breaks at `/`. */
export const noHyphenBreak = (s: string): string => s.replace(/-/g, '-\u2060');

/**
 * Inline code as shown: a newline inside it is a space (CommonMark, the window's `<code>`), hyphens do not break.
 * `noWrap` (short code that keeps its fill): it does not wrap at all, a U+2060 after `/` and a no-break space instead
 * of a space, because iOS stretches the fill of a wrapped nested Text to the line end.
 */
export const codeText = (value: string, noWrap = false): string => {
  const text = noHyphenBreak(value.replace(/\r\n|\r|\n/g, ' '));
  return noWrap ? text.replace(/\//g, '/\u2060').replace(/ /g, '\u00A0') : text;
};

/** The address of a `link`/`image` or, for a reference, of its definition; '' when there is none. */
export function addressOf(node: MdNode, defs: Defs): string {
  if (node.type === 'link' || node.type === 'image') return node.url ?? '';
  return defs.get(node.identifier ?? '')?.url ?? '';
}

/** The address a tap may open: strict http(s) only (javascript:, file:, data:, mailto:, `//host`, backslash, userinfo → null). */
export function linkTarget(node: MdNode, defs: Defs): string | null {
  const url = addressOf(node, defs).trim();
  return isOpenableUrl(url) ? url : null;
}

/** A link with an empty (or blank) label shows its address, so the human sees what the agent wrote (window: `components.a`). */
export function linkLabelIsEmpty(node: MdNode): boolean {
  return (node.children ?? []).every((c) => plainText(c).trim() === '');
}

/** The line that stands for an image: never a load. `[Image not loaded · host] alt`, without `alt` its full address. */
export function imageLine(node: MdNode, defs: Defs): string {
  const url = addressOf(node, defs).trim();
  const host = hostOf(url);
  const alt = (node.alt ?? '').trim();
  return `[Image not loaded${host === null ? '' : ` · ${host}`}]${alt !== '' ? ` ${alt}` : url !== '' ? ` ${url}` : ''}`;
}

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
/** `scale` is the font scale (Dynamic Type): widths and the clamps grow with the text. */
export function columnWidths(rows: MdNode[], scale = 1): number[] {
  const count = Math.max(0, ...rows.map((r) => r.children?.length ?? 0));
  return Array.from({ length: count }, (_, col) => {
    const longest = Math.max(0, ...rows.map((r) => weight(r.children?.[col] ?? { type: 'text', value: '' })));
    return Math.round(Math.min(COL_MAX * scale, Math.max(COL_MIN * scale, longest * COL_CHAR * scale + COL_PAD)));
  });
}

