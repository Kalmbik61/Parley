/**
 * Per-session Qwen Code system settings file (spec 2026-11-11, 3.3). Qwen Code has no `--settings` flag: the Parley
 * MCP server and hooks reach it through `QWEN_CODE_SYSTEM_SETTINGS_PATH`, which **replaces** the system file Qwen
 * would otherwise read. So the file starts from that original system file (the administrator's policy), keeps all of
 * its keys, refuses the launch when the policy makes integration impossible, appends Parley's additions and sets
 * Parley's defaults only where the policy is silent. Nothing in `~/.qwen` is written; `QWEN_HOME`, `OPENAI_*` and
 * keys are never set.
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { MCP_SERVER_NAME } from '../names.js';
import { ensureStateDir } from './state-dir.js';
import { CODEX_MCP_TOOL_TIMEOUT_SEC, mcpConfig, type McpConfigParams } from './mcp-config.js';
import {
  BROWSER_PERMISSIONS,
  CLOSE_SESSION_PERMISSION,
  HOOK_COMMAND,
  HOOK_TOKEN_ENV,
  feedHook,
  writeSessionSettings,
  type HookCommand,
  type HookHttp,
} from './settings-file.js';
import { workPaths } from './store.js';

/** The variable Qwen Code reads its system settings file from (Q1, Q2). */
export const QWEN_SYSTEM_SETTINGS_ENV = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

/** Events that get the journal command hook and the HTTP feed hook (spec 3.3, step 3). */
export const QWEN_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
] as const;

/**
 * The journal hook for Qwen Code. Unlike Claude Code, Qwen sends the hook JSON without a trailing newline (mock lab,
 * qwen 0.27.2), so `cat >>` would glue records into one line the line-based journal reader cannot parse. `$(cat)`
 * drops trailing newlines and `printf` appends the record plus one newline in one write; `|| true` keeps exit 0.
 */
export const QWEN_HOOK_COMMAND = HOOK_COMMAND.replace(/^cat >> /, `printf '%s\\n' "$(cat)" >> `);

/** `SessionEnd` holds the process exit, as with Claude Code. */
const COMMAND_TIMEOUT_SEC: Readonly<Record<string, number>> = { SessionEnd: 5 };

/**
 * Parley's defaults, set only when the base does not set them (spec 3.3, step 4): no startup update check
 * (Q23), MCP tools declared directly instead of `tool_search` → `tool_call` (D8), no background memory extractor (D9).
 */
export const QWEN_DEFAULTS: ReadonlyArray<{ key: readonly string[]; value: unknown }> = [
  { key: ['general', 'enableAutoUpdate'], value: false },
  { key: ['tools', 'toolSearch', 'enabled'], value: false },
  { key: ['memory', 'enableManagedAutoMemory'], value: false },
  { key: ['memory', 'enableManagedAutoDream'], value: false },
];

/** A launch refused because of the effective system settings file; the message names the file or the key. */
export class QwenSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QwenSettingsError';
  }
}

type Json = Record<string, unknown>;

/**
 * Qwen's `security.allowedHttpHookUrls` match (UrlValidator, qwen 0.27.2): the whole URL, case-insensitive, `*` matching
 * any run of characters; a pattern that already contains `\\.` is taken as a regular expression with only `*` expanded.
 */
function urlMatches(pattern: string, url: string): boolean {
  const source = pattern.includes('\\.')
    ? pattern.replace(/\*/g, '.*')
    : pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${source}$`, 'i').test(url);
  } catch {
    return false;
  }
}
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file Qwen would read without Parley: an inherited `QWEN_CODE_SYSTEM_SETTINGS_PATH`, else the platform default. */
export function qwenSystemSettingsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env[QWEN_SYSTEM_SETTINGS_ENV];
  if (configured) return configured;
  if (platform === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  return '/etc/qwen-code/settings.json';
}

/**
 * The base: `null` when the file is absent. A file that exists but is a symlink, a hard link, not a regular file,
 * unreadable or not a JSON object refuses the launch: nothing of the administrator's policy is silently dropped.
 */
export async function readQwenBase(file: string): Promise<Json | null> {
  const refuse = (reason: string): QwenSettingsError =>
    new QwenSettingsError(`Qwen system settings file ${file} ${reason}; Parley cannot start Qwen Code without dropping it.`);
  let link;
  try {
    link = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw refuse(`cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (link.isSymbolicLink()) throw refuse('is a symbolic link');
  if (!link.isFile()) throw refuse('is not a regular file');
  if (link.nlink > 1) throw refuse('is a hard link');
  let text: string;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== link.dev || opened.ino !== link.ino || opened.nlink > 1) throw refuse('changed while being read');
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof QwenSettingsError) throw error;
    throw refuse(`is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse('is not valid JSON');
  }
  if (!isObject(parsed)) throw refuse('is not a JSON object');
  return parsed;
}

export interface QwenSettingsOptions {
  /** The Parley MCP server: the same stdio command and env Claude gets (`mcpConfig`). */
  mcp: McpConfigParams;
  /** Host hook receiver; without it only the journal command hook is written. */
  hookUrl?: string;
  /** The session has an agent channel: browser tools and `close_session` run without a question (D7). */
  allowBrowser?: boolean;
}

export interface QwenSettings {
  settings: Json;
  /** Dotted keys of Parley's defaults that the base sets itself; the base value is kept. */
  kept: string[];
}

/**
 * Builds the file from the base (spec 3.3, steps 2–4). The base is deep-copied and never relaxed: Parley only adds
 * its server, appends its hook groups and permission rules, and fills defaults the base leaves unset.
 */
export function qwenSettings(base: Json | null, options: QwenSettingsOptions): QwenSettings {
  const settings: Json = base === null ? {} : structuredClone(base);
  const refuse = (key: string, reason: string): QwenSettingsError =>
    new QwenSettingsError(`Qwen system settings key ${key} ${reason}; Parley cannot connect its MCP server or hooks.`);

  // Step 2: required keys.
  const servers = settings['mcpServers'];
  if (servers !== undefined && !isObject(servers)) throw refuse('mcpServers', 'is not an object');
  if (isObject(servers) && Object.hasOwn(servers, MCP_SERVER_NAME)) throw refuse(`mcpServers.${MCP_SERVER_NAME}`, 'is already defined');
  const mcp = settings['mcp'];
  if (isObject(mcp)) {
    if (mcp['allowed'] !== undefined && (!Array.isArray(mcp['allowed']) || !mcp['allowed'].includes(MCP_SERVER_NAME))) {
      throw refuse('mcp.allowed', `does not include ${MCP_SERVER_NAME}`);
    }
    if (Array.isArray(mcp['excluded']) && mcp['excluded'].includes(MCP_SERVER_NAME)) throw refuse('mcp.excluded', `includes ${MCP_SERVER_NAME}`);
  }
  if (settings['disableAllHooks'] === true) throw refuse('disableAllHooks', 'turns hooks off');
  const hooks = settings['hooks'];
  if (hooks !== undefined && !isObject(hooks)) throw refuse('hooks', 'is not an object');
  for (const event of QWEN_HOOK_EVENTS) {
    const groups = isObject(hooks) ? hooks[event] : undefined;
    if (groups !== undefined && !Array.isArray(groups)) throw refuse(`hooks.${event}`, 'is not a list');
  }
  // The HTTP hook is the required route for state and Chat (spec 3.3): an administrator allow list that leaves out the
  // host's hook URL would make Qwen drop every HTTP hook silently.
  if (options.hookUrl !== undefined) {
    const security = settings['security'];
    const allowed = isObject(security) ? security['allowedHttpHookUrls'] : undefined;
    if (allowed !== undefined && !Array.isArray(allowed)) throw refuse('security.allowedHttpHookUrls', 'is not a list');
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((pattern) => typeof pattern === 'string' && urlMatches(pattern, options.hookUrl!))) {
      throw refuse('security.allowedHttpHookUrls', `does not allow the Parley hook URL ${options.hookUrl}`);
    }
  }
  const permissions = settings['permissions'];
  if (permissions !== undefined && !isObject(permissions)) throw refuse('permissions', 'is not an object');
  if (isObject(permissions) && permissions['allow'] !== undefined && !Array.isArray(permissions['allow'])) throw refuse('permissions.allow', 'is not a list');

  // Step 3: Parley's additions.
  const { type: _type, ...server } = mcpConfig(options.mcp).mcpServers[MCP_SERVER_NAME]!;
  void _type;
  settings['mcpServers'] = {
    ...(isObject(servers) ? servers : {}),
    // Qwen's MCP call timeout is in milliseconds; a `wait_for` may take 30 minutes (as for Codex).
    [MCP_SERVER_NAME]: { ...server, timeout: CODEX_MCP_TOOL_TIMEOUT_SEC * 1000 },
  };
  const merged: Json = isObject(hooks) ? hooks : {};
  for (const event of QWEN_HOOK_EVENTS) {
    const command: HookCommand = { type: 'command', command: QWEN_HOOK_COMMAND };
    const timeout = COMMAND_TIMEOUT_SEC[event];
    if (timeout !== undefined) command.timeout = timeout;
    const group: { hooks: (HookCommand | HookHttp)[] } = { hooks: [command] };
    if (options.hookUrl !== undefined) group.hooks.push(feedHook(options.hookUrl, event, HOOK_TOKEN_ENV));
    merged[event] = [...((merged[event] as unknown[] | undefined) ?? []), group];
  }
  settings['hooks'] = merged;
  // D7: the same pre-allowed tools as an ordinary Claude session; every other Parley tool asks.
  if (options.allowBrowser === true) {
    const rules = [...BROWSER_PERMISSIONS, CLOSE_SESSION_PERMISSION];
    const current = isObject(permissions) ? permissions : {};
    const allow = (current['allow'] as unknown[] | undefined) ?? [];
    settings['permissions'] = { ...current, allow: [...allow, ...rules.filter((rule) => !allow.includes(rule))] };
  }

  // Step 4: defaults only where the base is silent.
  const kept: string[] = [];
  for (const { key, value } of QWEN_DEFAULTS) {
    let node: Json = settings;
    let set = true;
    for (const part of key.slice(0, -1)) {
      const next = node[part];
      if (next === undefined) node[part] = {};
      else if (!isObject(next)) { set = false; break; }
      node = node[part] as Json;
    }
    const leaf = key[key.length - 1]!;
    if (!set || node[leaf] !== undefined) kept.push(key.join('.'));
    else node[leaf] = value;
  }
  return { settings, kept };
}

/**
 * Reads the base, builds the file and writes it as `settings/<session>-qwen.json` of the work with the protected writer
 * of `settings-file.ts` (redirect checks, 0600). Also creates `events/` for the journal hook.
 */
export async function writeQwenSettings(
  projectPath: string,
  workId: string,
  sessionId: string,
  options: QwenSettingsOptions & { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<{ file: string; kept: string[] }> {
  if (!/^s-\d+$/.test(sessionId)) throw new Error('invalid-session-id');
  const base = await readQwenBase(qwenSystemSettingsPath(options.env, options.platform));
  const { settings, kept } = qwenSettings(base, options);
  const paths = workPaths(projectPath, workId);
  const file = path.join(paths.dir, 'settings', `${sessionId}-qwen.json`);
  const root = await ensureStateDir(projectPath);
  await writeSessionSettings(root, paths.dir, file, `${JSON.stringify(settings, null, 2)}\n`);
  await mkdir(paths.events, { recursive: true });
  return { file, kept };
}
