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

const LINE_BREAK = /\r\n|\r|\n/;

const literalParagraph = (value: string): MdNode => ({ type: 'paragraph', children: [{ type: 'text', value, literal: true }] });

const sourceOf = (node: MdNode, source: string): string => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? '' : source.slice(start, end);
};

/** A row with more cells than the header has columns: the extra cells would be dropped silently. */
const hasExcessCells = (table: MdNode): boolean => {
  const columns = table.align?.length;
  return columns !== undefined && (table.children ?? []).some((row) => (row.children?.length ?? 0) > columns);
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
    if (child.type === 'table' && raw !== '' && hasExcessCells(child)) {
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
      if (line !== '') out.push({ type: 'text', value: line });
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

function expandChildren(parent: MdNode): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Inside a link `@s02` is part of the address: text stays, only newlines turn into breaks.
      next.push(...expandText(child.value, child.literal === true || parent.type === 'link' || parent.type === 'linkReference'));
      continue;
    }
    expandChildren(child);
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
  if (markdownTooDeep(src)) return rawRoot(text);
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) satisfies Root;
  const root = tree as unknown as MdNode;
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
