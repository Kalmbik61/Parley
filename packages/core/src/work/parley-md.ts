import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export type LayerWarningCode =
  | 'parley-md-unreadable'
  | 'parley-md-truncated'
  | 'provider-override-gap'
  | 'role-truncated'
  | 'recipe-playbook-truncated';

export interface LayerWarning {
  code: LayerWarningCode;
  /** Fixed English text, without file contents, machine paths or config values. */
  message: string;
}

export interface ParleyMdResult {
  text: string;
  warnings: LayerWarning[];
}
export const BLOCK_MAX_BYTES = 32768;
export const PARLEY_MD_MARKER = '[PARLEY.md is cut at 32 KB by Parley]';

/** Keep complete lines; the explicit marker itself is part of the byte budget. */
export function truncateMarked(text: string, marker: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= BLOCK_MAX_BYTES) return { text, truncated: false };
  const source = Buffer.from(text, 'utf8');
  const available = BLOCK_MAX_BYTES - Buffer.byteLength(marker, 'utf8') - 1;
  const lastLine = source.subarray(0, available + 1).lastIndexOf(10);
  const prefix = lastLine < 0 ? '' : source.subarray(0, lastLine).toString('utf8').trimEnd();
  return { text: prefix === '' ? marker : `${prefix}\n${marker}`, truncated: true };
}

interface Line {
  text: string;
  fenced: boolean;
}

function visibleLines(source: string): Line[] {
  const result: Line[] = [];
  let comment = false;
  let pending = '';
  let fence: { character: string; length: number } | null = null;
  for (const original of source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(original);
    if (fence !== null) {
      result.push({ text: original, fenced: true });
      if (
        match !== null &&
        match[1]?.[0] === fence.character &&
        (match[1]?.length ?? 0) >= fence.length &&
        match[2]?.trim() === ''
      )
        fence = null;
      continue;
    }
    if (!comment && match !== null && !(match[1]?.[0] === '`' && match[2]?.includes('`'))) {
      fence = { character: match[1]?.[0] as string, length: match[1]?.length as number };
      result.push({ text: original, fenced: true });
      continue;
    }
    let text = pending;
    pending = '';
    let cursor = 0;
    while (cursor < original.length) {
      if (comment) {
        const end = original.indexOf('-->', cursor);
        if (end < 0) break;
        comment = false;
        cursor = end + 3;
      } else {
        const start = original.indexOf('<!--', cursor);
        if (start < 0) {
          text += original.slice(cursor);
          break;
        }
        text += original.slice(cursor, start);
        comment = true;
        cursor = start + 4;
      }
    }
    if (comment) pending = text;
    else result.push({ text, fenced: false });
  }
  if (pending !== '') result.push({ text: pending, fenced: false });
  return result;
}

export function processParleyMd(source: string): ParleyMdResult {
  const lines = visibleLines(source);
  const emptyHeadings = new Set<number>();
  const headings: Array<{ index: number; level: number; content: boolean }> = [];
  const close = (): void => {
    const heading = headings.pop();
    if (heading === undefined) return;
    if (!heading.content) emptyHeadings.add(heading.index);
    else if (headings.length > 0) (headings[headings.length - 1] as typeof heading).content = true;
  };
  for (const [index, line] of lines.entries()) {
    const heading = line.fenced ? null : /^ {0,3}(#{1,6})(?:\s+|$)/.exec(line.text);
    if (heading !== null) {
      const level = heading[1]?.length as number;
      while (headings.length > 0 && (headings[headings.length - 1]?.level ?? 0) >= level) close();
      headings.push({ index, level, content: false });
    } else if (line.text.trim() !== '' && headings.length > 0) {
      (headings[headings.length - 1] as { content: boolean }).content = true;
    }
  }
  while (headings.length > 0) close();
  const kept: Line[] = [];
  for (const [index, line] of lines.entries()) {
    if (emptyHeadings.has(index)) continue;
    const previous = kept.at(-1);
    if (
      !line.fenced &&
      line.text.trim() === '' &&
      (previous === undefined || (!previous.fenced && previous.text.trim() === ''))
    )
      continue;
    kept.push(line);
  }
  while (kept.at(-1)?.text.trim() === '' && kept.at(-1)?.fenced === false) kept.pop();
  const processed = truncateMarked(kept.map((line) => line.text).join('\n'), PARLEY_MD_MARKER);
  return {
    text: processed.text,
    warnings: processed.truncated
      ? [
          {
            code: 'parley-md-truncated',
            message:
              'Parley cut PARLEY.md at 32 KB; shorten the project rules to include the remainder.',
          },
        ]
      : [],
  };
}

export async function readParleyMd(projectPath: string): Promise<ParleyMdResult> {
  const file = path.join(projectPath, 'PARLEY.md');
  try {
    // lstat distinguishes an absent file from an existing broken symlink.
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', warnings: [] };
    return unreadable();
  }
  try {
    // A FIFO, device or link to one must not block launch; fstat checks the opened object.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return unreadable();
      return processParleyMd(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return unreadable();
  }
}

function unreadable(): ParleyMdResult {
  return {
    text: '',
    warnings: [
      {
        code: 'parley-md-unreadable',
        message: 'Parley could not read PARLEY.md; this session starts without its project rules.',
      },
    ],
  };
}
