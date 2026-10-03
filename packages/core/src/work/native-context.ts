import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './state-dir.js';
import { tomlString } from './mcp-config.js';

/** LOCAL-only launch projection. No prompts, raw config, secrets or computed model defaults. */
export interface NativeContextDescriptor {
  version: 1;
  revision: string;
  provider: string;
  cwd: string;
  verified: boolean;
  command?: string;
  configArgs: string[];
  roots: { homeDir: string; codexHome?: string; claudeConfigDir?: string };
  process?: { pid: number; startedAtProcess: string };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Re-serialize only approved human selectors/root markers; never retain raw -c text/comments. */
export function projectNativeSkillConfigArgs(args: readonly string[]): string[] | null {
  if (args.length > 128 || args.length % 2 !== 0) return null;
  const projected: string[] = [];
  const quote = tomlString;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '-c' || typeof args[i + 1] !== 'string') return null;
    const text = args[i + 1]!;
    const key = text.slice(0, text.indexOf('=')).trim();
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(text); } catch { return null; }
    if (key === 'project_root_markers') {
      const markers = parsed.project_root_markers;
      if (!Array.isArray(markers) || markers.length > 128 || !markers.every(value => typeof value === 'string' && value.length > 0 &&
        !path.isAbsolute(value) && !value.replaceAll(String.fromCharCode(92), '/').split('/').includes('..'))) return null;
      projected.push('-c', `project_root_markers=[${markers.map(value => quote(value as string)).join(',')}]`);
    } else if (key === 'skills.config') {
      if (!record(parsed.skills) || !Array.isArray(parsed.skills.config) || parsed.skills.config.length > 2000) return null;
      const entries: string[] = [];
      for (const entry of parsed.skills.config) {
        if (!record(entry) || typeof entry.enabled !== 'boolean' ||
          Object.keys(entry).some(key => !['name', 'path', 'enabled'].includes(key)) ||
          (Object.hasOwn(entry, 'name') === Object.hasOwn(entry, 'path'))) return null;
        const selector = Object.hasOwn(entry, 'name') ? 'name' : 'path';
        const value = entry[selector];
        if (typeof value !== 'string' || !value || (selector === 'path' && !path.isAbsolute(value))) return null;
        entries.push(`{${selector}=${quote(value)},enabled=${entry.enabled}}`);
      }
      projected.push('-c', `skills.config=[${entries.join(',')}]`);
    } else return null;
  }
  return projected;
}
function valid(value: unknown): value is NativeContextDescriptor {
  if (!record(value) || value.version !== 1 || typeof value.revision !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.revision) || typeof value.provider !== 'string' ||
    typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.verified !== 'boolean' ||
    (value.command !== undefined && (typeof value.command !== 'string' || !path.isAbsolute(value.command))) ||
    !Array.isArray(value.configArgs) || value.configArgs.length > 128 || !value.configArgs.every(arg => typeof arg === 'string') ||
    !record(value.roots) || typeof value.roots.homeDir !== 'string' || !path.isAbsolute(value.roots.homeDir)) return false;
  for (const key of ['codexHome', 'claudeConfigDir']) if (value.roots[key] !== undefined &&
    (typeof value.roots[key] !== 'string' || !path.isAbsolute(value.roots[key]))) return false;
  if (Object.keys(value).some(key => !['version', 'revision', 'provider', 'cwd', 'verified', 'command', 'configArgs', 'roots', 'process'].includes(key)) ||
    Object.keys(value.roots).some(key => !['homeDir', 'codexHome', 'claudeConfigDir'].includes(key))) return false;
  if (value.configArgs.length % 2 !== 0) return false;
  if (JSON.stringify(projectNativeSkillConfigArgs(value.configArgs as string[])) !== JSON.stringify(value.configArgs)) return false;
  if (value.process !== undefined && (!record(value.process) || !Number.isSafeInteger(value.process.pid) ||
    Number(value.process.pid) < 1 || typeof value.process.startedAtProcess !== 'string' || !value.process.startedAtProcess)) return false;
  return true;
}
function location(projectPath: string, workId: string, sessionId: string): string {
  if (!/^w-\d+$/.test(workId) || !/^s-\d+$/.test(sessionId)) throw new Error('context-unverified');
  return path.join(stateDir(projectPath), 'local', 'native-context', workId, `${sessionId}.json`);
}
async function directory(file: string, create: boolean): Promise<void> {
  const dir = path.dirname(file);
  // Check each parent before making its child; never mkdir through an occupied symlink.
  const parents: string[] = [];
  let current = dir;
  for (let i = 0; i < 4; i++) { parents.unshift(current); current = path.dirname(current); }
  for (const parent of parents) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('context-unverified');
    } catch (error) {
      if (!create || !record(error) || error.code !== 'ENOENT') throw error;
      try { await mkdir(parent, { mode: 0o700 }); }
      catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('context-unverified');
    }
  }
}
/** A failed descriptor write never blocks a plain provider launch. Own env revision prevents stale reuse. */
export async function writeNativeContext(projectPath: string, workId: string, sessionId: string, value: NativeContextDescriptor): Promise<boolean> {
  let temporary: string | undefined;
  try {
    if (!valid(value)) return false;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 32768) return false;
    const file = location(projectPath, workId, sessionId);
    await directory(file, true);
    temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body, 'utf8'); } finally { await handle.close(); }
    await rename(temporary, file);
    return true;
  } catch { return false; }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
}
export async function readNativeContext(projectPath: string, workId: string, sessionId: string): Promise<NativeContextDescriptor | null> {
  try {
    const file = location(projectPath, workId, sessionId);
    await directory(file, false);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32768 || (info.mode & 0o077) !== 0) return null;
      const bytes = Buffer.alloc(32769);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 32768) return null;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
      return valid(value) ? value : null;
    } finally { await handle.close(); }
  } catch { return null; }
}
/** Bind only a new unbound descriptor. A previous launch's stamp must never be rewritten. */
export async function stampNativeContext(projectPath: string, workId: string, sessionId: string,
  process: { pid: number; startedAtProcess: string | null }, revision?: string): Promise<void> {
  if (process.startedAtProcess === null || revision === undefined) return;
  const current = await readNativeContext(projectPath, workId, sessionId);
  if (current === null || current.process !== undefined || current.revision !== revision) return;
  await writeNativeContext(projectPath, workId, sessionId, { ...current, process: { pid: process.pid, startedAtProcess: process.startedAtProcess } });
}
export async function nativeContextMatches(value: NativeContextDescriptor, provider: string, cwd: string,
  revision?: string, process?: { pid: number | null; startedAtProcess: string | null; lifecycle?: string }): Promise<boolean> {
  try {
    if (value.provider !== provider || value.cwd !== await realpath(cwd)) return false;
    if (revision !== undefined) return value.revision === revision;
    return value.process !== undefined && process !== undefined && (value.process.pid === process.pid || (process.pid === null && process.lifecycle === 'closed')) &&
      value.process.startedAtProcess === process.startedAtProcess;
  } catch { return false; }
}
