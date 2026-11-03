// Markdown of model replies, plans and letters (D1 §9.2, A40). The text is parsed with micromark + GFM (the same
// grammar as the window's remark-parse 11 / remark-gfm 4) into an mdast tree; pure transforms then port the window's
// `room-remark.ts` (`remarkReveal`, `remarkMentions`, line breaks) so the phone shows what the Mac window shows.
// Nothing here loads anything: a raw HTML node stays literal text and an image keeps only its host.
import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/** mdast node as the transforms and the renderer read it (own shape: the transforms add `literal`, `caption`, mentions). */
export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  /** Text inserted as it is (source, title): mentions and line breaks are not parsed in it. */
  literal?: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
  title?: string | null;
  alt?: string | null;
  url?: string;
  identifier?: string;
  label?: string | null;
  lang?: string | null;
  meta?: string | null;
  align?: (string | null)[];
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  depth?: number;
  /** `code`: the caption above the block (the info string after the fence). */
  caption?: string;
  /** `mention`: the session id and the token as written. `humanMention`: the token as written. */
  sessionId?: string;
  raw?: string;
}

/**
 * Strict shape of a link we will open: `http(s)://host[:port][/path…]` with no userinfo, no backslash and no whitespace.
 * `https://evil.com\@good.com/` is read differently by the dialog and by Safari (WHATWG treats `\` as `/`), so such
 * links are refused outright and shown as text.
 */
const SAFE_URL = /^https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;

export function hostOf(url: string): string | null {
  const m = SAFE_URL.exec(url.trim());
  if (m !== null) return m[1]!.toLowerCase();
  // Placeholder text for an image: the host of any URL-looking string, same rules.
  const loose = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\\s]*@)?([^/?#@\\\s:]+)/i.exec(url.trim());
  return loose?.[1]?.toLowerCase() ?? null;
}

/** Only strict `http(s)` links open (after a confirmation); anything else renders as plain text. */
export function isOpenableUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

/** More nested quotes than this is not Markdown (window: `lib/markdown-depth.ts`). */
export const QUOTE_DEPTH_MAX = 100;
const TOO_DEEP = new RegExp(`^(?:[ \\t]*>){${QUOTE_DEPTH_MAX + 1}}`, 'm');
export const markdownTooDeep = (text: string): boolean => TOO_DEEP.test(text);

/** Pathological input limits (A40 critic M2, M3): beyond them the text is shown raw / a table as its source. */
export const MD_BYTES_MAX = 64 * 1024;
export const MD_EMPHASIS_MAX = 2000;
export const MD_TABLE_ROWS_MAX = 200;
export const MD_TABLE_CELLS_MAX = 2000;
export const MD_NEST_MAX = 24;
export const MD_BRACKETS_MAX = 2000;
export const MD_BRACKET_DEPTH_MAX = 32;
export const MD_LAZY_RUN_MAX = 500;
export const MD_LINES_MAX = 5000;
/** The counts over the whole text (code not skipped) may reach this many times a limit. */
const BACKSTOP = 2;
/** `[` nesting over the whole text (the backstop); ESC-prefixed `[` of ANSI colours do not count. */
const BACKSTOP_DEPTH_MAX = 64;
/** A list with more items than this is shown as its source, like a table over its limit (`MD_TABLE_*`): ~5 native views per item. */
export const MD_LIST_ITEMS_MAX = 300;
/** Message-wide budgets (M7): extra markers before parsing; list items + table cells, and block nodes, after it. */
export const MD_EXTRA_MARKERS_MAX = 300;
export const MD_ITEMS_CELLS_MAX = 2000;
export const MD_BLOCKS_MAX = 3000;
/** Every mdast node (inline ones too: a paragraph of 30 000 nested emphasis is 30 000 React nodes). */
export const MD_NODES_MAX = 12000;

/** A quote or list marker; `>` needs no space after it (CommonMark), a list marker does. */
const MARKER = '(?:>|(?:[-+*]|\\d{1,9}[.)])(?=[ \\t]|$))';
/** Quote and list markers on one line, counted together (`- - - …`, `>- >- …`): they hang the parse itself. */
const markersRe = (n: number): RegExp => new RegExp(`^(?:[ \\t]*${MARKER}){${n}}`);
const MARKERS_TOO_DEEP = markersRe(MD_NEST_MAX + 1);
/** The same count over every line, thematic breaks and code included: the backstop (2× the limit, lines 4×). */
const MARKERS_TOO_DEEP_RAW = markersRe(MD_NEST_MAX * BACKSTOP + 1);
const BLOCK_MARKER = new RegExp(`^[ \\t]*${MARKER}`);
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/**
 * Only a fence at column 0 is skipped: nothing in front (no spaces, tabs or `>`), so it cannot sit in a quote, a list
 * item or indented code, and a lazy line never is one. A backtick fence has no backtick in its info string. Fences in
 * quotes and list items are counted like the rest (a rare false positive, the safe side).
 */
const FENCE_OPEN = /^(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** Closed as CommonMark: up to 3 spaces, the same character, then spaces or tabs only (no `>`, no tab in front). */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A line that may open an HTML block (up to 3 spaces, then `<`): no fence counts in it up to the next blank line. */
const HTML_START = /^ {0,3}</;
/** HTML blocks of types 1–5 run to a closing marker, not to a blank line: no code is skipped from here on. */
const HTML_LONG = /^ {0,3}<(?:(?:script|pre|style|textarea)(?:[ \t>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

/**
 * Pre-parse guards (A40 critic M2, M3, M5, M6): text that would hang the parser is shown raw. One pass over the lines;
 * fenced code is skipped (code is not parsed, so its `[`, `*` and markers cost nothing and must not count), but the
 * skip is only a convenience: every count is ALSO kept over the whole text with nothing skipped, and any of them over
 * 2× its limit shows raw text, so a fence the parser does not agree with can never hide a bomb.
 *  - more than 64 KB; more than 2000 `*`, `_`, `~`; more than 2000 `[` or `[` nested deeper than 32 (an ESC `[` of an
 *    ANSI colour does not count);
 *  - 25 quote/list markers on one line (not a thematic break such as `- - - …`);
 *  - a run of more than 500 lines without a block marker after a quote/list line (lazy continuation is quadratic; a
 *    heading ends it), and, as a backstop, more than 5000 non-empty lines.
 */
export const tooHeavy = (text: string): boolean => {
  if (text.length > MD_BYTES_MAX) return true;
  // Counts with the code skipped (limit) and over everything (BACKSTOP × limit).
  const skip = { emphasis: 0, brackets: 0, depth: 0, lines: 0, lazy: 0, inBlock: false, extraMarkers: 0 };
  const all = { emphasis: 0, brackets: 0, depth: 0, lines: 0, lazy: 0, inBlock: false };
  // Skipped code: a coarse backstop (4×, no depth limit), so a fence the guard misreads can never hide a bomb (M8).
  const code = { emphasis: 0, brackets: 0, depth: 0 };
  let fence: string | null = null;
  let html = false;
  let codeSkipOff = false;
  for (const line of text.split('\n')) {
    const blank = line.trim() === '';
    const inCode: boolean = fence !== null;
    const opener: RegExpExecArray | null = !inCode && !blank && !html && !codeSkipOff ? FENCE_OPEN.exec(line) : null;
    // Over everything, nothing skipped (the backstop). Code the column-0 fence rule already skips counts its lines and
    // `*`, `_`, `~`, `[` only coarsely (4×, no depth): real code has many (m20) but never without bound.
    if (blank) {
      all.inBlock = false;
      all.lazy = 0;
    } else {
      // A long code block of short lines is legal, so lines have more room than the other counts.
      if (++all.lines > MD_LINES_MAX * BACKSTOP * 2) return true;
      if (opener !== null) {
        all.inBlock = false;
        all.lazy = 0;
      } else if (inCode) {
        if (count(line, code, BACKSTOP * 2, Infinity)) return true;
      } else {
        if (MARKERS_TOO_DEEP_RAW.test(line)) return true;
        if (HEADING.test(line)) {
          all.inBlock = false;
          all.lazy = 0;
        } else if (BLOCK_MARKER.test(line)) {
          all.inBlock = true;
          all.lazy = 0;
        } else if (all.inBlock && ++all.lazy > MD_LAZY_RUN_MAX * BACKSTOP) return true;
        if (count(line, all, BACKSTOP, BACKSTOP_DEPTH_MAX)) return true;
      }
    }
    // The fence / HTML state, as far as the guard can tell.
    if (inCode) {
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1]![0] === fence![0] && close[1]!.length >= fence!.length) fence = null;
      continue;
    }
    if (blank) {
      html = false;
      skip.inBlock = false;
      skip.lazy = 0;
      continue;
    }
    if (opener !== null) {
      fence = opener[1] ?? opener[2]!;
      skip.inBlock = false;
      skip.lazy = 0;
      continue;
    }
    if (HTML_START.test(line)) {
      html = true;
      if (HTML_LONG.test(line)) codeSkipOff = true;
    }
    if (++skip.lines > MD_LINES_MAX) return true;
    if (!THEMATIC_BREAK.test(line) && MARKERS_TOO_DEEP.test(line)) return true;
    // One message-wide budget for markers: a line with k markers adds k - 2 (M7).
    if ((skip.extraMarkers += Math.max(0, markersOn(line) - 2)) > MD_EXTRA_MARKERS_MAX) return true;
    if (HEADING.test(line)) {
      skip.inBlock = false;
      skip.lazy = 0;
    } else if (BLOCK_MARKER.test(line)) {
      skip.inBlock = true;
      skip.lazy = 0;
    } else if (skip.inBlock && ++skip.lazy > MD_LAZY_RUN_MAX) return true;
    if (count(line, skip, 1)) return true;
  }
  return false;
};

const MARKER_AT_START = new RegExp(`^[ \\t]*${MARKER}`);
/** How many quote/list markers a line starts with (at most 30: enough for the budget). */
function markersOn(line: string): number {
  let rest = line;
  let k = 0;
  for (let m = MARKER_AT_START.exec(rest); m !== null && k < 30; m = MARKER_AT_START.exec(rest)) {
    k++;
    rest = rest.slice(m[0].length);
  }
  return k;
}

/**
 * The budget of one message after parsing (M7): list items + table cells, block nodes, and all nodes (inline too), over their
 * limits show raw text. Every limit above is per structure; many structures (16 lists of 300, 14 tables of 2000 cells) are not covered
 * by them, and each costs ~5 native views per item, so the sum is bounded here.
 */
export function overBudget(root: MdNode): boolean {
  let cells = 0;
  let blocks = 0;
  let nodes = 0;
  const walk = (n: MdNode): void => {
    nodes++;
    if (n.type === 'listItem' || n.type === 'tableCell') cells++;
    if (BLOCK_TYPES.has(n.type)) blocks++;
    n.children?.forEach(walk);
  };
  walk(root);
  return cells > MD_ITEMS_CELLS_MAX || blocks > MD_BLOCKS_MAX || nodes > MD_NODES_MAX;
}
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'code', 'blockquote', 'list', 'listItem', 'table', 'thematicBreak', 'definition', 'footnoteDefinition']);

/** Emphasis and bracket counts of one line against `factor` × the limits; `[` nests, `]` closes. */
function count(line: string, c: { emphasis: number; brackets: number; depth: number }, factor: number, depthMax = MD_BRACKET_DEPTH_MAX): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if ((ch === 42 || ch === 95 || ch === 126) && ++c.emphasis > MD_EMPHASIS_MAX * factor) return true;
    // `[` bombs: unmatched or deeply nested brackets make link resolution quadratic.
    if (ch === 91 && (i === 0 || line.charCodeAt(i - 1) !== 27)) {
      if (++c.brackets > MD_BRACKETS_MAX * factor || ++c.depth > depthMax) return true;
    } else if (ch === 93 && c.depth > 0) c.depth--;
  }
  return false;
}

/** Lists and quotes nested inside each other, counted together. */
export const nestDepth = (n: MdNode): number => {
  const own = n.type === 'list' || n.type === 'blockquote' ? 1 : 0;
  return own + Math.max(0, ...(n.children ?? []).map(nestDepth));
};

const LINE_BREAK = /\r\n|\r|\n/;

const literalParagraph = (value: string): MdNode => ({ type: 'paragraph', children: [{ type: 'text', value, literal: true }] });

const sourceOf = (node: MdNode, source: string): string => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? '' : source.slice(start, end);
};

/** A row with more cells than the header has columns (the extra cells would be dropped silently), or a table too big to lay out. */
const showTableAsSource = (table: MdNode): boolean => {
  const rows = table.children ?? [];
  const columns = table.align?.length;
  if (columns !== undefined && rows.some((row) => (row.children?.length ?? 0) > columns)) return true;
  return rows.length > MD_TABLE_ROWS_MAX || rows.reduce((sum, row) => sum + (row.children?.length ?? 0), 0) > MD_TABLE_CELLS_MAX;
};

/** What Markdown hides while rendering and the agent reads: see `remarkReveal` in the window's `room-remark.ts`. */
function revealHidden(parent: MdNode, source: string): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    const raw = sourceOf(child, source);
    if (child.type === 'definition' && raw !== '') {
      // The node stays: `[text][label]` resolves its address from it.
      next.push(child, literalParagraph(raw));
      continue;
    }
    if (child.type === 'footnoteDefinition' && raw !== '') {
      next.push(literalParagraph(raw));
      continue;
    }
    if (child.type === 'table' && raw !== '' && showTableAsSource(child)) {
      next.push({ type: 'code', value: raw });
      continue;
    }
    // A long list: ~5 native views per item, so over the limit it is shown as its source (like a table).
    if (child.type === 'list' && raw !== '' && (child.children?.length ?? 0) > MD_LIST_ITEMS_MAX) {
      next.push({ type: 'code', value: raw });
      continue;
    }
    if (child.type === 'code') {
      const info = [child.lang, child.meta].filter((part) => part !== null && part !== undefined && part !== '').join(' ');
      next.push(info === '' ? child : { ...child, caption: info });
      continue;
    }
    if (child.type === 'footnoteReference') {
      next.push({ type: 'text', value: `[^${child.label ?? child.identifier ?? ''}]`, literal: true });
      continue;
    }
    revealHidden(child, source);
    next.push(child);
    if ((child.type === 'link' || child.type === 'image') && typeof child.title === 'string' && child.title !== '') {
      next.push({ type: 'text', value: ` (${child.title})`, literal: true });
    }
  }
  parent.children = next;
}

const tokenSessionId = (digits: string): string => `s-${digits.padStart(2, '0')}`;
/** The window's token rule (`mention.ts` FEED_TOKEN): not glued to a letter, digit, `_` or `@` on either side. */
const FEED_TOKEN = /(?<![\p{L}\p{N}_@])@(?:s-?(\d+)|(human))(?![\p{L}\p{N}_])/giu;

/** A text node → text, mentions and a `break` at every newline (window: every text node does this). */
function expandText(value: string, literal: boolean): MdNode[] {
  const out: MdNode[] = [];
  const pushText = (text: string): void => {
    text.split(LINE_BREAK).forEach((line, index) => {
      if (index > 0) out.push({ type: 'break' });
      if (line !== '') out.push(literal ? { type: 'text', value: line, literal: true } : { type: 'text', value: line });
    });
  };
  if (literal) {
    pushText(value);
    return out;
  }
  let last = 0;
  for (const match of value.matchAll(FEED_TOKEN)) {
    if (match.index > last) pushText(value.slice(last, match.index));
    const digits = match[1];
    out.push(
      digits === undefined
        ? { type: 'humanMention', raw: match[0] }
        : { type: 'mention', sessionId: tokenSessionId(digits), raw: match[0] },
    );
    last = match.index + match[0].length;
  }
  if (last < value.length) pushText(value.slice(last));
  return out;
}

function spaceNewlines(n: MdNode): void {
  if (n.type === 'text' && n.value !== undefined) n.value = n.value.replace(/\r\n|\r|\n/g, ' ');
  n.children?.forEach(spaceNewlines);
}

function expandChildren(parent: MdNode): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value !== undefined) {
      next.push(...expandText(child.value, child.literal === true));
      continue;
    }
    // Like the window: a link is not entered (`@s02` is part of its address); a newline in its label reads as a space.
    if (child.type === 'link' || child.type === 'linkReference') spaceNewlines(child);
    else expandChildren(child);
    next.push(child);
  }
  parent.children = next;
}

/** Text shown as it is (a quote nested deeper than the limit, a parse failure). */
export function rawRoot(text: string): MdNode {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text, literal: true }] }] };
}

/** Text → mdast (GFM, positions) with the window's transforms applied. Never throws on ordinary input. */
export function parseMarkdown(text: string): MdNode {
  const src = text.replace(/\r\n?/g, '\n');
  if (markdownTooDeep(src) || tooHeavy(src)) return rawRoot(text);
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) satisfies Root;
  const root = tree as unknown as MdNode;
  if (nestDepth(root) > MD_NEST_MAX) return rawRoot(text);
  revealHidden(root, src);
  if (overBudget(root)) return rawRoot(text);
  expandChildren(root);
  return root;
}

/** Address and title of every link definition, by lower-cased identifier (for `[text][label]` and `![alt][label]`). */
export function definitionsOf(root: MdNode): Map<string, { url: string; title: string | null }> {
  const defs = new Map<string, { url: string; title: string | null }>();
  const walk = (n: MdNode): void => {
    if (n.type === 'definition' && n.identifier !== undefined && !defs.has(n.identifier)) defs.set(n.identifier, { url: n.url ?? '', title: n.title ?? null });
    n.children?.forEach(walk);
  };
  walk(root);
  return defs;
}
