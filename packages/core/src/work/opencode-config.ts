/**
 * Per-session OpenCode 2.x configuration (spec 2026-11-12 §4.3, §4.8, §4.10). The TUI has no `--model` flag and the
 * server owns MCP, so everything goes through two env documents of the `opencode serve` process:
 *
 * - `OPENCODE_CONFIG_CONTENT`: `mcp.parley` (absolute command), `permissions`, `model`, `autoupdate: false`;
 * - `OPENCODE_CLI_CONFIG_CONTENT`: `{"highlights": false}` (no release-highlights screen at an unattended start).
 *
 * Pure functions; the host sets the env (O5). The human's own config stays in effect: OpenCode merges these
 * documents after it.
 */

import path from 'node:path';
import { MCP_SERVER_NAME } from '../names.js';
import { mcpConfig, type McpConfigParams } from './mcp-config.js';

export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT';
export const OPENCODE_CLI_CONFIG_ENV = 'OPENCODE_CLI_CONFIG_CONTENT';
/** Switches off the update check of the server process (spike §11). */
export const OPENCODE_DISABLE_AUTOUPDATE_ENV = 'OPENCODE_DISABLE_AUTOUPDATE';
/** The server password: the server and the TUI read it from their env only (spike §5). */
export const OPENCODE_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';
/**
 * The `{serverUrl}` value of a launch plan: the host replaces this argument with the address of the session's server
 * once it answers (spec §4.2). An unreplaced slot is not a URL, so the TUI fails instead of reaching another server.
 */
export const OPENCODE_SERVER_URL_SLOT = 'parley:opencode-server-url';

/** What a read-only role may not do (spec §4.8, spike §15): file edits, commands, network tools, subagents. */
export const OPENCODE_READ_ONLY_DENY = ['edit', 'shell', 'webfetch', 'websearch', 'subagent'] as const;

export interface OpencodePermission {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export interface OpencodeConfig {
  mcp: Record<string, { type: 'local'; command: string[]; environment: Record<string, string> }>;
  /** Ordered, the last match wins. */
  permissions: OpencodePermission[];
  model?: string;
  /** Files OpenCode adds to the system prompt: the Parley session layer (spec §4.6 amendment, O5). */
  instructions?: string[];
  autoupdate: false;
}

export interface OpencodeConfigParams {
  /** Parley MCP parameters of the session (work dir, session id, channel, tool profile…). */
  mcp: McpConfigParams;
  /** Read-only role: deny the tools of `OPENCODE_READ_ONLY_DENY`. */
  readOnly?: boolean;
  /** `provider/model` or `provider/model#variant`; omitted for "Default". */
  model?: string;
  /** Absolute paths of instruction files (the session layer file). */
  instructions?: readonly string[];
}

const MODEL = /^[^\s/#]+\/[^\s#]+(#[^\s#]+)?$/;

/** Permission rules of the session: the role's denies first, `parley_*` allow last so Parley's tools never ask. */
export function opencodePermissions(readOnly: boolean): OpencodePermission[] {
  return [
    ...(readOnly ? OPENCODE_READ_ONLY_DENY.map((action): OpencodePermission => ({ action, resource: '*', effect: 'deny' })) : []),
    { action: `${MCP_SERVER_NAME}_*`, resource: '*', effect: 'allow' },
  ];
}

export function buildOpencodeConfig({ mcp, readOnly = false, model, instructions }: OpencodeConfigParams): OpencodeConfig {
  for (const file of instructions ?? []) {
    if (!path.isAbsolute(file)) throw new Error(`OpenCode needs an absolute instructions path: ${file}`);
  }
  if (model !== undefined && !MODEL.test(model)) throw new Error(`OpenCode model must look like provider/model[#variant]: ${model}`);
  const server = mcpConfig(mcp).mcpServers[MCP_SERVER_NAME];
  if (server === undefined) throw new Error('Parley MCP server config is missing');
  const command = [server.command, ...server.args];
  // The server resolves a relative command against its own PATH (spike §1): only absolute paths are allowed.
  if (!path.isAbsolute(server.command)) throw new Error(`OpenCode needs an absolute MCP command path: ${server.command}`);
  for (const arg of server.args) {
    if (arg.endsWith('.js') && !path.isAbsolute(arg)) throw new Error(`OpenCode needs an absolute MCP entry path: ${arg}`);
  }
  return {
    mcp: { [MCP_SERVER_NAME]: { type: 'local', command, environment: { ...server.env } } },
    permissions: opencodePermissions(readOnly),
    ...(model === undefined ? {} : { model }),
    ...(instructions === undefined || instructions.length === 0 ? {} : { instructions: [...instructions] }),
    autoupdate: false,
  };
}

/** Value of `OPENCODE_CONFIG_CONTENT`. */
export function opencodeConfigContent(params: OpencodeConfigParams): string {
  return JSON.stringify(buildOpencodeConfig(params));
}

/** Value of `OPENCODE_CLI_CONFIG_CONTENT`. */
export function opencodeCliConfigContent(): string {
  return JSON.stringify({ highlights: false });
}

/** The config environment of the session's `opencode serve` (spec §4.2 step 3); the host adds the password. */
export function opencodeServerEnv(params: OpencodeConfigParams): Record<string, string> {
  return {
    [OPENCODE_CONFIG_ENV]: opencodeConfigContent(params),
    [OPENCODE_CLI_CONFIG_ENV]: opencodeCliConfigContent(),
    [OPENCODE_DISABLE_AUTOUPDATE_ENV]: '1',
  };
}
