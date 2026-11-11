import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { qwenHome } from './home.js';

/** History root of Qwen Code: `<qwenHome>/projects`. Read-only; `<qwenHome>/oauth_creds.json` next to it is never read. */
export function defaultQwenRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(qwenHome(env), 'projects');
}

export interface DiscoveredQwenSession {
  file: string;
  /** Native session id: the file name without `.jsonl`. Checked against the records' `sessionId` when indexing. */
  id: string;
}

const ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Session id of a transcript file name; `null` when the name is not `<uuid>.jsonl`. */
export const qwenLogId = (fileName: string): string | null => ID.exec(fileName)?.[1]?.toLowerCase() ?? null;

async function dirs(parent: string): Promise<string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Walks `<root>/<encoded-cwd>/chats/<uuid>.jsonl`. The directory name is a lossy encoding of the cwd (spec Q16) and is
 * never decoded: the cwd comes from the records.
 */
export async function discoverQwenSessions(root: string = defaultQwenRoot()): Promise<DiscoveredQwenSession[]> {
  const found: DiscoveredQwenSession[] = [];
  for (const project of await dirs(root)) {
    const chats = path.join(root, project, 'chats');
    let names: string[];
    try {
      names = await readdir(chats);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = qwenLogId(name);
      if (id !== null) found.push({ file: path.join(chats, name), id });
    }
  }
  return found;
}

/** Whether `file` has the shape `<root>/<project>/chats/<uuid>.jsonl`. */
export function isQwenTranscriptPath(file: string, root: string = defaultQwenRoot()): boolean {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  return parts.length === 3 && parts[1] === 'chats' && qwenLogId(parts[2] as string) !== null;
}
