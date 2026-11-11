// The Claude client of a launch (plan T12a-Claude, slice C1; lead m-7515, s-296 R1 m-7516).
//
// At launch, the host resolves `claude`, takes its REALPATH, runs `--version` on exactly that file and then spawns exactly that file, with no PATH
// lookup in between. The version and the file's inode go into the launch decision. A version outside the reviewed set keeps the launch classic
// with `client-version`: exact versions only, so every new Claude release puts NEW launches on classic until it is reviewed (C1-b, fail-closed).
//
// In the session process the check is on the CLIENT PROCESS, the parent of this MCP server, never on the PATH binary: a running claude keeps the
// image it was started from, and an auto-update that moves a symlink or swaps a file on disk changes nothing about it. At the first check the
// parent's executable text (path and inode, from lsof) must be the recorded one; at every later check its accounting name (ps comm) must be what
// the first check saw, so an exec in place is caught. Named residual: a swap of the file between the launcher's `--version` and its spawn.

import { execFile, spawnSync } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { SourceClass, SourceVerdict } from './detector.js';
import type { LaunchIdentities } from './launch-decision.js';

/** Claude Code versions whose Code Mode behaviour was reviewed (C2 positive controls ran on each). Exact versions, no ranges. */
export const REVIEWED_CLAUDE_VERSIONS: readonly string[] = Object.freeze(['2.1.322']);

export type ClaudeClient = NonNullable<LaunchIdentities['client']>;

export type ClientProbe = { readonly ok: true; readonly client: ClaudeClient } | { readonly ok: false; readonly reason: 'not-a-file' | 'no-version' };

const VERSION = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * The realpath, its inode and the version it prints. Asynchronous, like the host's other `--version` probes, so a slow or hung binary never
 * blocks the host's event loop; it is cut at the bound with SIGKILL. Never rejects: anything unexpected is a refusal reason, so the launch
 * stays classic.
 */
export async function probeClaudeClient(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<ClientProbe> {
  let path: string;
  let inode: string;
  try {
    path = await realpath(binary);
    const st = await stat(path, { bigint: true });
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
    inode = st.ino.toString();
  } catch {
    return { ok: false, reason: 'not-a-file' };
  }
  const stdout = await new Promise<string | null>((resolve) => {
    const child = execFile(path, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      windowsHide: true,
      env: { PATH: env['PATH'] ?? '/usr/bin:/bin', ...(env['HOME'] === undefined ? {} : { HOME: env['HOME'] }) },
    }, (error, out) => resolve(error === null ? out : null));
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
  const m = stdout === null ? null : VERSION.exec(stdout.trim());
  if (m === null) return { ok: false, reason: 'no-version' };
  return { ok: true, client: Object.freeze({ path, version: m[1]!, inode }) };
}

export const clientVersionReviewed = (probe: ClientProbe | undefined): boolean =>
  probe !== undefined && probe.ok && REVIEWED_CLAUDE_VERSIONS.includes(probe.client.version);

// ----- the client process, in the session process -----

/** How this process reads its parent. Tests only replace it. */
export interface ParentReader {
  /** The parent's executable text: path and inode, or null when it cannot be read. */
  text(ppid: number): { readonly path: string; readonly inode: string } | null;
  /** The parent's accounting name, or null. */
  comm(ppid: number): string | null;
  ppid(): number;
}

export const REAL_PARENT: ParentReader = Object.freeze({
  text(ppid: number) {
    const r = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(ppid), '-d', 'txt', '-Fin'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin' } });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    // The first txt entry of a process is its executable image; later ones are mapped libraries.
    const lines = r.stdout.split('\n');
    const i = lines.findIndex((l) => l.startsWith('i'));
    const n = i < 0 ? undefined : lines[i + 1];
    if (i < 0 || n === undefined || !n.startsWith('n')) return null;
    return { inode: lines[i]!.slice(1), path: n.slice(1) };
  },
  comm(ppid: number) {
    const r = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8', timeout: 1_000, maxBuffer: 1 << 16, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
    return out === '' ? null : out;
  },
  ppid: () => process.ppid,
});

/**
 * The detector's `client` class for one launch. No recorded client: uninspected. First check: the parent's executable must be the recorded
 * file (path and inode). Later checks: the same parent pid with the same accounting name. A different executable, or a parent that changed, is
 * a trigger; a parent that cannot be read is uninspected.
 */
export function clientClass(recorded: ClaudeClient | undefined, reader: ParentReader = REAL_PARENT): SourceClass {
  let seen: { readonly ppid: number; readonly comm: string } | null = null;
  return Object.freeze({
    name: 'client',
    check(): SourceVerdict {
      if (recorded === undefined) return Object.freeze({ kind: 'uninspected', sourceClass: 'client' });
      const ppid = reader.ppid();
      if (seen === null) {
        const text = reader.text(ppid);
        const comm = reader.comm(ppid);
        if (text === null || comm === null) return Object.freeze({ kind: 'uninspected', sourceClass: 'client' });
        if (text.path !== recorded.path || text.inode !== recorded.inode) return Object.freeze({ kind: 'trigger', reason: 'client-process' });
        seen = Object.freeze({ ppid, comm });
        return Object.freeze({ kind: 'clear' });
      }
      if (ppid !== seen.ppid) return Object.freeze({ kind: 'trigger', reason: 'client-process' });
      const comm = reader.comm(ppid);
      if (comm === null) return Object.freeze({ kind: 'uninspected', sourceClass: 'client' });
      return comm === seen.comm ? Object.freeze({ kind: 'clear' }) : Object.freeze({ kind: 'trigger', reason: 'client-process' });
    },
  });
}
