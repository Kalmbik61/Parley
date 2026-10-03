import { createHash } from 'node:crypto';
import { realpath, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { CodexNativeContext } from '@parley/core';
import type { CapabilityActionAvailability, CapabilityActionReason, CapabilityMcpAddAvailability, CapabilityProvider } from '@parley/protocol';
import { object } from './redact.js';
import type { SnapshotContext } from './snapshot.js';

export type McpScope = 'user' | 'project' | 'local';
/** Private selector/provenance. Never part of SnapshotEntry, DTO, events or logs. */
export interface NativeMcpTarget {
  id: string; provider: CapabilityProvider; name: string; scope: McpScope;
  fingerprint: string; remove: CapabilityActionAvailability; check: CapabilityActionAvailability;
}
export interface NativeMcpInventory {
  contextFingerprint: string; signature: string; names: string[];
  executionBinary?: string; binaryIdentity?: NativeBinaryIdentity; targets: NativeMcpTarget[]; add: CapabilityMcpAddAvailability;
}
export const allow = (): CapabilityActionAvailability => ({ allowed: true, reason: null });
export const deny = (reason: CapabilityActionReason = 'unverified'): CapabilityActionAvailability => ({ allowed: false, reason });
export const deniedAdd = (reason: CapabilityActionReason = 'unverified'): CapabilityMcpAddAvailability => ({ user: deny(reason), project: deny(reason), local: deny(reason) });
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const data = object(value); if (!data) return value;
  return Object.fromEntries(Object.keys(data).sort().map(key => [key, stable(data[key])]));
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const contextFingerprint = (context: SnapshotContext, provider: CapabilityProvider): string => fingerprint({
  provider, cwd: context.projectPath, home: context.homeDir, binary: context.binaries[provider], env: context.env ?? process.env,
  config: provider === 'claude' ? { configDir: context.claude?.configDir, userConfigFile: context.claude?.userConfigFile,
    mainCheckout: context.claude?.mainCheckout, policy: context.claude?.mcpPolicy, winners: context.claude?.mcpWinningTargets } : { codexHome: context.codex?.codexHome },
});
export const validMcpName = (name: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(name);

/** Native active layers prove provenance; no handwritten TOML/trust/precedence resolver. */
export async function codexUserMcpProof(context: SnapshotContext, native: CodexNativeContext | null): Promise<{ names: Set<string>; add: boolean; signature: string } | null> {
  const config = object(native?.config); const requirements = object(native?.requirements);
  if (!context.binaries.codex || !config || !Array.isArray(config.layers) || config.layers.length > 128 ||
    !requirements || !Object.hasOwn(requirements, 'requirements') || requirements.requirements !== null) return null;
  const env = context.env ?? process.env;
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(context.homeDir)) return null;
  const nativeHome = path.resolve(context.projectPath, env.CODEX_HOME ?? path.join(context.homeDir, '.codex'));
  const home = path.resolve(context.projectPath, context.codex?.codexHome ?? nativeHome);
  if (home !== nativeHome) return null;
  let expected: string;
  try { expected = await canonicalFileLocation(path.join(home, 'config.toml')); } catch { return null; }
  const users = new Set<string>(); const foreign = new Set<string>(); let userLayers = 0;
  for (const raw of config.layers) {
    const layer = object(raw); const name = object(layer?.name); const data = object(layer?.config);
    if (!layer || !name || !data || typeof layer.version !== 'string') return null;
    if (layer.disabledReason !== undefined && layer.disabledReason !== null) {
      if (typeof layer.disabledReason !== 'string') return null; continue;
    }
    const type = name.type;
    if (!['user', 'project', 'system', 'packagedDefaults', 'sessionFlags'].includes(String(type))) return null;
    if (type === 'sessionFlags' && Object.keys(data).length !== 0) return null;
    if (type === 'user') {
      if (name.profile !== undefined && name.profile !== null || typeof name.file !== 'string' || !path.isAbsolute(name.file)) return null;
      try { if (await canonicalFileLocation(name.file) !== expected) return null; } catch { return null; }
      if (++userLayers !== 1) return null;
    }
    const servers = object(data.mcp_servers);
    if (Object.hasOwn(data, 'mcp_servers') && !servers) return null;
    for (const [server, value] of Object.entries(servers ?? {})) {
      if (!object(value)) return null;
      (type === 'user' ? users : foreign).add(server);
    }
  }
  for (const name of foreign) users.delete(name);
  return { names: users, add: userLayers === 1, signature: fingerprint({ layers: config.layers, requirements: native?.requirements, userFile: expected }) };
}


export interface NativeBinaryIdentity { canonicalPath: string; sha256: string; size: number }
export const sameBinaryIdentity = (a: NativeBinaryIdentity | null | undefined, b: NativeBinaryIdentity | null | undefined): boolean =>
  !!a && !!b && a.canonicalPath === b.canonicalPath && a.sha256 === b.sha256 && a.size === b.size;
/** Audited native Add policy guard and explicit-scope Remove semantics, exact publisher bytes.
 * https://downloads.claude.ai/claude-code-releases/2.1.287/manifest.json
 * Commit 3c446a1b98aceb99a6cdee0f84a8bea42f4a8937. Other artifacts are not approved by version alone.
 */
export const CLAUDE_ACTION_BUILD = { version: '2.1.287', platform: 'darwin', arch: 'arm64', size: 227827120,
  sha256: '6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea' } as const;
export async function readBinaryIdentity(binary: string | null, context: SnapshotContext, maxBytes = 256 * 1024 * 1024): Promise<NativeBinaryIdentity | null> {
  if (!binary || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) return null;
  const candidates = binary.includes('/') || binary.includes('\\') ? [path.resolve(context.projectPath, binary)]
    : ((context.env ?? process.env).PATH ?? '/usr/bin:/bin').split(path.delimiter).map(folder => path.resolve(context.projectPath, folder, binary));
  for (const candidate of candidates) try {
    const canonicalPath = await realpath(candidate); const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || (before.mode & 0o111) === 0) continue;
      if (before.size > maxBytes) return null;
      const hash = createHash('sha256'); const chunk = Buffer.alloc(256 * 1024); let size = 0;
      while (size <= maxBytes) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - size), null);
        if (!bytesRead) break; hash.update(chunk.subarray(0, bytesRead)); size += bytesRead;
      }
      const after = await handle.stat(); const current = await stat(canonicalPath);
      if (size > maxBytes || size !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs || await realpath(candidate) !== canonicalPath) return null;
      return { canonicalPath, sha256: hash.digest('hex'), size };
    } finally { await handle.close(); }
  } catch { /* No paths, errors or binary contents leave this private adapter. */ }
  return null;
}
export async function verifiedClaudeActionBinary(context: SnapshotContext, read = readBinaryIdentity): Promise<NativeBinaryIdentity | null> {
  if (process.platform !== CLAUDE_ACTION_BUILD.platform || process.arch !== CLAUDE_ACTION_BUILD.arch) return null;
  const identity = await read(context.binaries.claude, context);
  return identity?.sha256 === CLAUDE_ACTION_BUILD.sha256 && identity.size === CLAUDE_ACTION_BUILD.size ? identity : null;
}
export function claudeDestinationsBound(context: SnapshotContext): boolean {
  const env = context.env ?? process.env;
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(context.homeDir)) return false;
  const nativeDir = path.resolve(context.projectPath, env.CLAUDE_CONFIG_DIR ?? path.join(context.homeDir, '.claude'));
  if (context.claude?.configDir && path.resolve(context.projectPath, context.claude.configDir) !== nativeDir) return false;
  const nativeFile = env.CLAUDE_CONFIG_DIR ? path.join(nativeDir, '.claude.json') : path.join(context.homeDir, '.claude.json');
  return !context.claude?.userConfigFile || path.resolve(context.claude.userConfigFile) === nativeFile;
}


/** Includes canonical config targets even when the next native Add will create an absent file. */
export async function canonicalFileLocation(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if (object(error)?.code !== 'ENOENT') throw error;
    const parent = path.dirname(file); if (parent === file) throw error;
    return path.join(await canonicalFileLocation(parent), path.basename(file));
  }
}
export async function claudeStorageIdentity(userFile: string, projectFile: string): Promise<readonly string[] | null> {
  try { return await Promise.all([canonicalFileLocation(path.resolve(userFile)), canonicalFileLocation(path.resolve(projectFile))]); }
  catch { return null; }
}
