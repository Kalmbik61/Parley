import { TextDecoder } from 'node:util';
import { parseMarkdownFrontmatter } from '../skills/frontmatter.js';

/** Legacy agent-head bound; skill/command documents use the full native resolver. */
export const FRONTMATTER_BYTES = 4096;

export interface Frontmatter {
  name: string | null;
  description: string | null;
}

/** Keep the old nullable projection while delegating all YAML syntax to the shared parser. */
export function parseFrontmatter(text: string): Frontmatter {
  const empty: Frontmatter = { name: null, description: null };
  let head: string;
  try {
    const bytes = Buffer.from(text).subarray(0, FRONTMATTER_BYTES);
    head = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: bytes.length === FRONTMATTER_BYTES });
  } catch {
    return empty;
  }
  const metadata = parseMarkdownFrontmatter(head);
  if (metadata.status !== 'valid') return empty;
  const string = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  return { name: string(metadata.data.name), description: string(metadata.data.description) };
}
