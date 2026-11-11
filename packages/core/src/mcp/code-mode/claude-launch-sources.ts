// The launcher's half of the Claude source row (plan T12a-Claude, slice C2a; lead m-7557/m-7560/m-7563, s-296 m-7559/m-7561). Facts that only
// the launcher has, and that cannot change during the session, are decided here once: the argv template, the environment the PTY gets, and a
// second MCP server named `parley`. The launcher also records the identities the session process needs (config root, cwd, git root, the
// `--settings` file) and runs the same settings class once, so a dirty state refuses at launch.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROVIDERS, type ProviderEntry } from '../../providers.js';
import type { DetectorVerdict } from '../../work/launch-exposure.js';
import { CLAUDE_ENV_ALLOWED, type ManagedLayer, claudeSettingsClass, realManagedLayer } from './claude-settings.js';
import type { LaunchIdentities } from './launch-decision.js';

export { CLAUDE_ENV_ALLOWED };

/** The launch env (s-296 E1, lead m-7563): a `CLAUDE_*` or `ANTHROPIC_*` name outside `CLAUDE_ENV_ALLOWED` is `uninspected:env`. */
export function claudeEnvVerdict(env: NodeJS.ProcessEnv): DetectorVerdict {
  const named = Object.keys(env).some((name) => {
    const upper = name.toUpperCase();
    return (upper.startsWith('CLAUDE_') || upper.startsWith('ANTHROPIC_')) && !CLAUDE_ENV_ALLOWED.has(name);
  });
  return named ? { kind: 'uninspected', sourceClass: 'env' } : { kind: 'clear' };
}

/**
 * The runner is the built-in claude runner, exactly: the command, the new and the resume templates, the env and the config dir. Then every flag of
 * the final argv is Parley's own (`--settings` and `--mcp-config` are the paths it writes, `--disallowedTools` comes from its closed set), and
 * `--project-config-root`, `--setting-sources` or `--permission-prompt-tool` cannot appear. Anything else is `uninspected:argv`.
 */
export function claudeArgvVerdict(entry: ProviderEntry): DetectorVerdict {
  const shipped = PROVIDERS.claude.runner;
  const shape = (r: ProviderEntry['runner']): string => JSON.stringify([r.command, r.args ?? null, r.resumeArgs ?? null, r.env ?? null, r.configDir ?? null, r.secret ?? null]);
  return entry.id === 'claude' && shape(entry.runner) === shape(shipped) ? { kind: 'clear' } : { kind: 'uninspected', sourceClass: 'argv' };
}

/** Claude Code's global config file name. Parley only reads it (B2 below); only claude itself writes it. */
const GLOBAL_CONFIG_NAME = '.claude.json';

/** The config root claude will use, as the launcher sets the child's env, and its global config file. */
export function claudeConfigRoots(cwd: string, env: NodeJS.ProcessEnv): { readonly configRoot: string; readonly globalConfig: string } {
  const home = env['HOME'] ?? homedir();
  const dir = env['CLAUDE_CONFIG_DIR'];
  if (dir !== undefined && dir !== '') {
    const root = path.resolve(cwd, dir);
    return { configRoot: root, globalConfig: path.join(root, GLOBAL_CONFIG_NAME) };
  }
  return { configRoot: path.join(home, '.claude'), globalConfig: path.join(home, GLOBAL_CONFIG_NAME) };
}

const GIT_TIMEOUT_MS = 5_000;

/**
 * The canonical git root of cwd; undefined only when git itself says cwd is not in a repository; null for anything else (git missing, a
 * timeout, dubious ownership, any other failure), which the scan makes `uninspected:git-root` (s-296 G2).
 */
export function gitRootOf(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined | null> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 16, windowsHide: true,
      env: { PATH: env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', ...(env['HOME'] === undefined ? {} : { HOME: env['HOME'] }) },
    }, (error, out, err) => {
      if (error !== null) {
        const notRepo = typeof (error as { code?: unknown }).code === 'number' && (error as { killed?: boolean }).killed !== true && /not a git repository/.test(String(err));
        resolve(notRepo ? undefined : null);
        return;
      }
      const top = out.trim();
      if (top === '' || !path.isAbsolute(top)) { resolve(null); return; }
      realpath(top).then((r) => resolve(r), () => resolve(null));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

/** The global config file grows with history: read it whole up to this, else uninspected. */
export const GLOBAL_CONFIG_MAX_BYTES = 64 * 1024 * 1024;
const MCP_JSON_MAX_BYTES = 1024 * 1024;

/**
 * One JSON object file, read without following a link and without blocking (O_NOFOLLOW|O_NONBLOCK), checked as a regular file on the fd, and
 * read at most `maxBytes + 1` bytes, so a FIFO or a file growing past the bound never stalls or overruns the launch (lead m-7588, s-296 O1).
 * The parse of up to 64 MiB is synchronous: a named limit.
 */
async function jsonObject(file: string, maxBytes: number): Promise<Record<string, unknown> | 'absent' | 'unreadable'> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return 'unreadable';
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > maxBytes) return 'unreadable';
    const data: unknown = JSON.parse(buf.subarray(0, got).toString('utf8'));
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : 'unreadable';
  } catch {
    return 'unreadable';
  } finally {
    await handle.close().catch(() => {});
  }
}
const namesParley = (servers: unknown): boolean =>
  typeof servers === 'object' && servers !== null && !Array.isArray(servers) && Object.keys(servers).some((name) => name.toLowerCase() === 'parley');

/**
 * B2 (lead m-7557, s-296 m-7561): another server named `parley` would also serve `mcp__parley__*` tools, because a non-lean launch has no
 * `--strict-mcp-config`. Looked for at user scope and under this project's entries in the global config file, and in `.mcp.json` at cwd and at the
 * git root. Found: trigger. A file that cannot be read or parsed: uninspected. It cannot change the MCP set of a running client.
 */
export async function parleyServerElsewhere(globalConfig: string, projectDirs: readonly string[]): Promise<DetectorVerdict> {
  const global = await jsonObject(globalConfig, GLOBAL_CONFIG_MAX_BYTES);
  if (global === 'unreadable') return { kind: 'uninspected', sourceClass: 'claude-json' };
  if (global !== 'absent') {
    if (namesParley(global['mcpServers'])) return { kind: 'trigger' };
    const projects = global['projects'];
    if (typeof projects === 'object' && projects !== null && !Array.isArray(projects)) {
      for (const dir of projectDirs) {
        const entry = (projects as Record<string, unknown>)[dir];
        if (typeof entry === 'object' && entry !== null && namesParley((entry as Record<string, unknown>)['mcpServers'])) return { kind: 'trigger' };
      }
    }
  }
  for (const dir of projectDirs) {
    const project = await jsonObject(path.join(dir, '.mcp.json'), MCP_JSON_MAX_BYTES);
    if (project === 'unreadable') return { kind: 'uninspected', sourceClass: 'mcp-json' };
    if (project !== 'absent' && namesParley(project['mcpServers'])) return { kind: 'trigger' };
  }
  return { kind: 'clear' };
}

export interface ClaudeLaunchInput {
  readonly entry: ProviderEntry;
  readonly cwd: string;
  /** The environment the claude PTY gets. */
  readonly env: NodeJS.ProcessEnv;
  /** The `--settings` file Parley writes for this launch. */
  readonly settings?: { readonly path: string; readonly sha256: string };
  /** Tests only. */
  readonly managed?: ManagedLayer;
}

/**
 * The launch scan and the identities it records. argv and env come first and decide alone when they are not clear: a relocated source makes
 * every read at a fixed path meaningless. Then the second `parley` server and the settings class: any trigger wins; otherwise the first
 * uninspected; otherwise clear.
 */
export async function claudeLaunchScan(input: ClaudeLaunchInput): Promise<{ readonly verdict: DetectorVerdict; readonly identities: LaunchIdentities }> {
  const { configRoot, globalConfig } = claudeConfigRoots(input.cwd, input.env);
  const git = await gitRootOf(input.cwd, input.env);
  const identities: LaunchIdentities = {
    cwd: input.cwd, configRoot,
    ...(git === undefined || git === null ? {} : { gitRoot: git }),
    ...(input.settings === undefined ? {} : { settings: input.settings }),
  };
  let first: DetectorVerdict = { kind: 'clear' };
  const take = (v: DetectorVerdict): boolean => {
    if (v.kind === 'trigger') { first = v; return true; }
    if (v.kind === 'uninspected' && first.kind === 'clear') first = v;
    return false;
  };
  for (const fixed of [claudeArgvVerdict(input.entry), claudeEnvVerdict(input.env)]) {
    if (fixed.kind !== 'clear') return { verdict: fixed, identities };
  }
  if (git === null) take({ kind: 'uninspected', sourceClass: 'git-root' });
  const dirs = [...new Set([input.cwd, ...(identities.gitRoot === undefined ? [] : [identities.gitRoot])])];
  if (take(await parleyServerElsewhere(globalConfig, dirs))) return { verdict: first, identities };
  const settings = claudeSettingsClass(identities, input.managed ?? realManagedLayer()).check();
  take(settings.kind === 'trigger' ? { kind: 'trigger' } : settings);
  return { verdict: first, identities };
}
