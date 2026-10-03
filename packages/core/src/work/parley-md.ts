import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureStateDir } from './state-dir.js';

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

const TEMPLATE = `# PARLEY.md

<!--
Team rules for agents working together in Parley. Every agent Parley launches in this
project gets this file on top of its own instructions (CLAUDE.md, AGENTS.md).
Comments like this one and empty sections are not sent to agents.
-->

## Roles
<!-- Who leads rooms by default; which provider or model takes which kind of work. -->

## Review
<!-- Who checks whose work before it reaches the human. -->

## Git and worktrees
<!-- Branches, commits and merges; what agents must never do (for example, push). -->

## Communication
<!-- Language of messages, report format, when to stop and ask the human. -->

## Definition of done
<!-- Checks that must pass before an agent reports done. -->
`;

export interface ParleyMdCreation {
  created: boolean;
  /** Accounting was retained conservatively; never expose raw filesystem errors in UI. */
  receiptError?: boolean;
}

/** Host-only automatic creation. Any receipt prevents resurrection of a deleted file. */
export function ensureParleyMd(projectPath: string): Promise<ParleyMdCreation> {
  return putParleyMd(projectPath, false);
}

/** Explicit human Create may create again even when an earlier receipt exists. */
export function createParleyMd(projectPath: string): Promise<ParleyMdCreation> {
  return putParleyMd(projectPath, true);
}

async function putParleyMd(projectPath: string, explicit: boolean): Promise<ParleyMdCreation> {
  const dir = await ensureStateDir(projectPath);
  const root = await realpath(projectPath);
  const relative = path.relative(root, await realpath(dir));
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('PARLEY.md accounting must stay inside the project.');
  }
  const receipt = path.join(dir, 'parley-md-receipt.json');
  const recordedAt = new Date().toISOString();
  const body = (created: boolean): string =>
    `${JSON.stringify({ version: 1, recordedAt, created })}\n`;
  let owner;
  if (explicit) {
    await writeReceipt(receipt, body(false));
    owner = await lstat(receipt);
  } else {
    let handle;
    try {
      handle = await open(receipt, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return {
        created: false,
        ...((await readReceipt(receipt)) !== null ? {} : { receiptError: true }),
      };
    }
    try {
      owner = await handle.stat();
      await handle.writeFile(body(false), 'utf8');
    } finally {
      await handle.close();
    }
  }
  const stillOwns = async (): Promise<boolean> => {
    try {
      const current = await lstat(receipt);
      return current.dev === owner.dev && current.ino === owner.ino;
    } catch {
      return false;
    }
  };
  let created = false;
  try {
    await writeFile(path.join(projectPath, 'PARLEY.md'), TEMPLATE, {
      encoding: 'utf8',
      flag: 'wx',
    });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      if ((await stillOwns()) && (await readReceipt(receipt))?.created === false) {
        await rm(receipt).catch(() => {});
      }
      throw error;
    }
  }
  if (!(await stillOwns())) return { created, receiptError: true };
  try {
    await writeReceipt(receipt, body(created));
    return { created };
  } catch {
    // The initial durable reservation remains, even if the user then deletes PARLEY.md.
    return { created, receiptError: true };
  }
}

async function writeReceipt(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface ParleyMdReceipt {
  version: 1;
  recordedAt: string;
  created: boolean;
}

async function readReceipt(file: string): Promise<ParleyMdReceipt | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) return null;
      const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
      return value?.version === 1 &&
        typeof value.recordedAt === 'string' &&
        Number.isFinite(Date.parse(value.recordedAt)) &&
        typeof value.created === 'boolean'
        ? { version: 1, recordedAt: value.recordedAt, created: value.created }
        : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
