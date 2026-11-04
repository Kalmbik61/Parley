// A quote for display (D1 §9.2: raw Markdown is shown nowhere except the Select Text sheet): the text of the Markdown
// source without its marks. The source itself is what goes to the agent. Uses the feed's own parser; the input is capped.
import { linkTarget, plainText } from '../markdown/helpers';
import { definitionsOf, hostOf, parseMarkdown, type MdNode } from '../markdown/parse';

export const QUOTE_PREVIEW_INPUT_MAX = 1000;

const BLOCKS = new Set(['root', 'blockquote', 'list', 'listItem', 'table']);

function flat(n: MdNode): string {
  if (n.type === 'definition' || n.type === 'thematicBreak') return '';
  if (n.type === 'code') return n.value ?? '';
  if (n.type === 'html') return n.value ?? '';
  if (n.type === 'tableRow') return (n.children ?? []).map(flat).join(' ');
  if (BLOCKS.has(n.type)) return (n.children ?? []).map(flat).filter((x) => x !== '').join('\n');
  return plainText(n);
}

export function quotePreview(md: string): string {
  return flat(parseMarkdown(md.slice(0, QUOTE_PREVIEW_INPUT_MAX))).trim();
}

/** The whole text without markup, no cut: the VoiceOver label of a reply (critic A42 M7). The parser's own size guards apply. */
export function plainOf(md: string): string {
  return flat(parseMarkdown(md)).trim();
}

export interface ReplyExtras {
  /** Openable links of the reply (strict http(s)); `host` for the action's name. */
  links: Array<{ url: string; host: string }>;
  /** Code blocks, in order: "Copy code N". */
  codes: string[];
}

export const EXTRAS_MAX = 10;

/** Links and code blocks of a reply: with the reply one accessible element, they become actions of it. */
export function replyExtras(md: string): ReplyExtras {
  const root = parseMarkdown(md);
  const defs = definitionsOf(root);
  const links: ReplyExtras['links'] = [];
  const codes: string[] = [];
  const walk = (n: MdNode): void => {
    if (n.type === 'code') {
      if (codes.length < EXTRAS_MAX) codes.push(n.value ?? '');
      return;
    }
    if (n.type === 'link' || n.type === 'linkReference') {
      const url = linkTarget(n, defs);
      if (url !== null && links.length < EXTRAS_MAX && !links.some((l) => l.url === url)) links.push({ url, host: hostOf(url) ?? url });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return { links, codes };
}

/** The VoiceOver label of an own prompt (D1 §9.2): "You: Quote: …. <text>". */
export const promptLabel = (quote: string | null, body: string): string => `You: ${quote === null ? '' : `Quote: ${quotePreview(quote)}. `}${body}`;
