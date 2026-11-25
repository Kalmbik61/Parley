import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './state-dir.js';

function absent(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  return undefined;
}

/** Resolve only real archive directories under the owning project's canonical work state. */
export async function kimiArchiveDirectory(
  projectPath: string, workId: string, sessionId: string, create = false,
): Promise<string | undefined> {
  if (!/^w-\d+$/.test(workId) || !/^s-\d+$/.test(sessionId)) return undefined;
  const project = await realpath(projectPath).catch(absent);
  if (project === undefined) return undefined;
  const parts = [path.basename(stateDir(project)), 'works', workId, 'kimi-history', sessionId];
  let dir = project;
  for (const [index, part] of parts.entries()) {
    const parent = dir;
    dir = path.join(parent, part);
    let info = await lstat(dir).catch(absent);
    if (info === undefined && create && index >= 3) {
      if (await realpath(parent).catch(absent) !== parent) return undefined;
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      info = await lstat(dir).catch(absent);
    }
    if (info?.isDirectory() !== true) return undefined;
  }
  return await realpath(dir).catch(absent) === dir ? dir : undefined;
}
