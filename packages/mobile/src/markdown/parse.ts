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

/** A quote or list marker; `>` needs no space after it (CommonMark), a list marker does. */
const MARKER = '(?:>|(?:[-+*]|\\d{1,9}[.)])(?=[ \\t]|$))';
/** Quote and list markers on one line, counted together (`- - - …`, `>- >- …`): they hang the parse itself. */
const MARKERS_TOO_DEEP = new RegExp(`^(?:[ \\t]*${MARKER}){${MD_NEST_MAX + 1}}`);
const BLOCK_MARKER = new RegExp(`^[ \\t]*(?:${MARKER}|#{1,6}(?:[ \\t]|$))`);
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Pre-parse guards (A40 critic M2, M3, M5): text that would hang the parser is shown raw. One pass over the lines, with
 * fenced code skipped (code is not parsed, so its `[`, `*` and markers cost nothing and must not count):
 *  - more than 64 KB; more than 2000 `*`, `_`, `~`; more than 2000 `[` or `[` nested deeper than 32 (an ESC `[` of an
 *    ANSI colour does not count);
 *  - 25 quote/list markers on one line (not a thematic break such as `- - - …`);
 *  - a run of more than 500 lines without a block marker after a quote/list line (lazy continuation is quadratic), and,
 *    as a backstop, more than 5000 non-empty lines outside fenced code.
 */
export const tooHeavy = (text: string): boolean => {
  if (text.length > MD_BYTES_MAX) return true;
  let emphasis = 0;
  let brackets = 0;
  let depth = 0;
  let lines = 0;
  let lazy = 0;
  let inBlock = false;
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const open = FENCE.exec(line);
    if (fence !== null) {
      if (open !== null && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.trim().length === open[1]!.length) fence = null;
      continue;
    }
    if (open !== null) {
      fence = open[1]!;
      continue;
    }
    if (line.trim() === '') {
      inBlock = false;
      lazy = 0;
      continue;
    }
    if (++lines > MD_LINES_MAX) return true;
    if (!THEMATIC_BREAK.test(line) && MARKERS_TOO_DEEP.test(line)) return true;
    if (BLOCK_MARKER.test(line)) {
      inBlock = true;
      lazy = 0;
    } else if (inBlock && ++lazy > MD_LAZY_RUN_MAX) return true;
    for (let i = 0; i < line.length; i++) {
      const ch = line.charCodeAt(i);
      if ((ch === 42 || ch === 95 || ch === 126) && ++emphasis > MD_EMPHASIS_MAX) return true;
      // `[` bombs: unmatched or deeply nested brackets make link resolution quadratic.
      if (ch === 91 && (i === 0 || line.charCodeAt(i - 1) !== 27)) {
        if (++brackets > MD_BRACKETS_MAX || ++depth > MD_BRACKET_DEPTH_MAX) return true;
      } else if (ch === 93 && depth > 0) depth--;
    }
  }
  return false;
};

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
