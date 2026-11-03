// A quote for display (D1 §9.2: raw Markdown is shown nowhere except the Select Text sheet): the text of the Markdown
// source without its marks. The source itself is what goes to the agent. Uses the feed's own parser; the input is capped.
import { plainText } from '../markdown/helpers';
import { parseMarkdown, type MdNode } from '../markdown/parse';

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
