import { prepareSkillShare, skillShareAvailability, skillSharePolicyAllowed } from './share-skill.js';
import type { SkillShareTarget } from './share-skill.js';
import { readNativePluginInventory } from './native-plugin-inventory.js';
import type { NativePluginInventory, NativePluginTarget } from './native-plugin-inventory.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { commandBinary, loadProviders, stateDir, readCodexNativeContext, resolveSkillCatalog } from '@parley/core';
import type { SkillCatalogOptions, NativeSkill } from '@parley/core';
import { capabilityPresence, capabilitySnapshot } from '@parley/protocol';
import type { CapabilityActionReason, CapabilitySkillTarget, CapabilityMcpTarget, CapabilityPluginCatalogRequest, CapabilityPluginTargetRequest, CapabilityPluginDetailsRequest, CapabilityPluginInstallRequest, CapabilityColumn, CapabilityDiagnostic, CapabilityPresence, CapabilityProvider, CapabilityRow, CapabilitySnapshot } from '@parley/protocol';
import { contextFingerprint, deny, fingerprint, readBinaryIdentity, sameBinaryIdentity, verifiedClaudeActionBinary } from './native-targets.js';
import type { NativeMcpInventory, NativeMcpTarget, NativeBinaryIdentity } from './native-targets.js';
import { readClaudeSnapshot } from './claude.js';
import { readCodexSnapshot } from './codex.js';
import { rowIdentity, object, skillSharingCatalogKnown, readJsonFile, readNativeJson, safeText } from './redact.js';
import type { NativeJsonReader, SnapshotEntry } from './redact.js';

type ClaudeOptions = Omit<Extract<SkillCatalogOptions, { provider: 'claude' }>, 'provider' | 'cwd' | 'homeDir'>;
type CodexOptions = Omit<Extract<SkillCatalogOptions, { provider: 'codex' }>, 'provider' | 'cwd' | 'homeDir'>;
export interface SnapshotContext {
  /** Actual main checkout for the project panel, not a participant worktree. */
  projectPath: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  binaries: Record<CapabilityProvider, string | null>;
  claude?: ClaudeOptions & {
    userConfigFile?: string;
    /** Source-backed native/Git identity; unresolved leaves local MCP unknown. */
    mainCheckout?: string;
    /** Trusted native effective-winner evidence, bound to cwd and exact config contents.
     * Local file order/get_settings/exit 0 are insufficient; no default producer. */
    mcpWinningTargets?: { cwd: string; targets: readonly { name: string; scope: 'user' | 'project' | 'local'; configFingerprint: string }[] };
    mcpPolicy?: { verified: boolean; enabled?: readonly string[]; disabled?: readonly string[]; approved?: readonly string[] };
  };
  codex?: CodexOptions;
}
export interface ProviderSnapshotResult { entries: SnapshotEntry[]; diagnostics: CapabilityDiagnostic[]; phase: CapabilityColumn['phase']; /** Private catalog closure proof, including an empty receiver catalog. */ skillSharingContext?: boolean; native?: NativeMcpInventory; pluginsNative?: NativePluginInventory }
export interface SnapshotReaderOptions { pluginRedactionSecrets?: readonly string[]; readNative?: NativeJsonReader; readCodexContext?: typeof readCodexNativeContext; readBinaryIdentity?: typeof readBinaryIdentity; readPluginInventory?: typeof readNativePluginInventory; codexPluginContext?: { context: Awaited<ReturnType<typeof readCodexNativeContext>>; binaryIdentity: NativeBinaryIdentity | null } }
export type ProviderSnapshotReader = (context: SnapshotContext, options: SnapshotReaderOptions) => Promise<ProviderSnapshotResult>;

/** Bounded native Git output only; no repository/config output or raw errors are logged. */
async function readGit(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile('git', [...args],
      { env, encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) => {
        if (error !== null) { resolve(null); return; }
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch { resolve(null); }
      });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  });
}

/** Native --local-env-vars identifies repository-specific variables to remove for foreign queries.
 * Git documents that its main worktree is listed first; queried root must also belong to that list.
 * https://git-scm.com/docs/git-rev-parse#Documentation/git-rev-parse.txt---local-env-vars
 * https://git-scm.com/docs/git-worktree#_commands
 */
export async function findMainCheckout(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const canonicalCwd = await realpath(cwd);
    if (!(await stat(canonicalCwd)).isDirectory()) return null;
    // Only the inventory query removes all Git variables: it reads native variable names, no repository.
    const inventoryEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
    const inventory = await readGit(['rev-parse', '--local-env-vars'], inventoryEnv);
    if (inventory === null) return null;
    const names = inventory.split('\n').filter(Boolean);
    if (names.length === 0 || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))) return null;
    const cleanEnv = { ...env };
    for (const name of names) delete cleanEnv[name];
    for (const name of Object.keys(cleanEnv)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete cleanEnv[name];
    const prefix = ['-c', 'core.fsmonitor=false', '-C', canonicalCwd];
    const [listing, root] = await Promise.all([
      readGit([...prefix, 'worktree', 'list', '--porcelain', '-z'], cleanEnv),
      readGit([...prefix, 'rev-parse', '--show-toplevel'], cleanEnv),
    ]);
    if (listing === null || root === null || !root.endsWith('\n')) return null;
    const fields = listing.split('\0');
    const first = fields[0]; const end = fields.indexOf('');
    if (!first?.startsWith('worktree ') || fields.slice(0, end).includes('bare')) return null;
    const worktrees = fields.filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
    if (worktrees.length > 128 || worktrees.some(folder => !path.isAbsolute(folder))) return null;
    const queriedRoot = root.slice(0, -1);
    if (!path.isAbsolute(queriedRoot)) return null;
    const canonicalRoot = await realpath(queriedRoot);
    const relative = path.relative(canonicalRoot, canonicalCwd);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
    const members = await Promise.all(worktrees.map(folder => realpath(folder).catch(() => null)));
    if (!members.includes(canonicalRoot)) return null;
    const main = members[0];
    return main && (await stat(main)).isDirectory() ? main : null;
  } catch { return null; }
}

export async function defaultSnapshotContext(projectPath: string): Promise<SnapshotContext> {
  const cwd = await realpath(projectPath);
  if (!(await stat(cwd)).isDirectory()) throw new Error('missing-context');
  const env = { ...process.env };
  const main = await findMainCheckout(cwd, env);
  const panel = main ?? cwd;
  const homeDir = homedir();
  const registry = await loadProviders();
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(panel, env.CLAUDE_CONFIG_DIR) : undefined;
  return {
    projectPath: panel, homeDir, env,
    binaries: { claude: registry.claude ? commandBinary(registry.claude.runner.command, env) : null,
      codex: registry.codex ? commandBinary(registry.codex.runner.command, env) : null },
    claude: { ...(configDir ? { configDir, userConfigFile: path.join(configDir, '.claude.json') } : {}),
      ...(main ? { mainCheckout: main } : {}) },
    codex: env.CODEX_HOME ? { codexHome: path.resolve(panel, env.CODEX_HOME) } : {},
  };
}

const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function mergeSnapshotRows(columns: Partial<Record<CapabilityProvider, SnapshotEntry[]>>): CapabilityRow[] {
  const rows = new Map<string, CapabilityRow>();
  for (const provider of ['claude', 'codex'] as const) for (const entry of columns[provider] ?? []) {
    const id = entry.rowId && /^[a-f0-9]{64}$/.test(entry.rowId) ? entry.rowId : rowIdentity(entry.kind, entry.name, provider);
    let row = rows.get(id);
    if (!row) { row = { id, kind: entry.kind, name: entry.name, description: entry.presence.description,
      separateCopies: false, claude: [], codex: [] }; rows.set(id, row); }
    if (!row[provider].some(item => item.id === entry.presence.id)) row[provider].push(entry.presence);
  }
  for (const row of rows.values()) {
    row.claude.sort((a, b) => compare(a.id, b.id)); row.codex.sort((a, b) => compare(a.id, b.id));
    const documents = [...row.claude, ...row.codex].map(item => item.documentPath).filter((item): item is string => item !== null);
    row.separateCopies = row.kind === 'skill' && new Set(documents).size > 1;
  }
  return [...rows.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name) || compare(a.id, b.id));
}

/** Receipt metadata only proves ownership when its current file/actual link still matches. */
async function builtinSkills(context: SnapshotContext, entries: SnapshotEntry[]): Promise<CapabilityDiagnostic[]> {
  const read = await readJsonFile(path.join(stateDir(context.projectPath), 'skills-receipt.json'), 1024 * 1024);
  if (read.status === 'missing') return [];
  const data = read.status === 'valid' ? object(read.data) : null;
  const receipt = data?.version === 1 ? object(data.entries) : null;
  if (!receipt) return [{ code: 'receipt-unverified', source: 'receipt' }];
  const owned = new Set<string>();
  const observed = new Set(entries.filter(entry => entry.kind === 'skill').map(entry => entry.presence.documentPath));
  for (const [folder, raw] of Object.entries(receipt).slice(0, 1000)) {
    const entry = object(raw);
    if (!entry || !path.isAbsolute(folder)) continue;
    try {
      const info = await lstat(folder);
      if ((entry.kind !== 'dir' && entry.kind !== 'copy') || !info.isDirectory() || typeof entry.sha256 !== 'string') continue;
      const file = path.join(folder, 'SKILL.md');
      if (!observed.has(await realpath(file))) continue;
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > 65_536) continue;
        const content = Buffer.alloc(65_537); let length = 0;
        while (length < content.length) {
          const { bytesRead } = await handle.read(content, length, content.length - length, null);
          if (bytesRead === 0) break; length += bytesRead;
        }
        if (length > 65_536 || createHash('sha256').update(content.subarray(0, length)).digest('hex') !== entry.sha256) continue;
        owned.add(await realpath(file));
      } finally { await handle.close(); }
    } catch { /* Edited/broken receipt entries are never claimed by name. */ }
  }
  for (const entry of entries) if (entry.kind === 'skill' && entry.name === 'parley' &&
    entry.presence.documentPath !== null && owned.has(entry.presence.documentPath)) entry.presence.scope = 'builtin';
  return [];
}

async function markSharedLinks(context: SnapshotContext, columns: Partial<Record<CapabilityProvider, SnapshotEntry[]>>): Promise<void> {
  for (const provider of ['claude', 'codex'] as const) {
    const other = provider === 'claude' ? 'codex' : 'claude';
    const targets = new Set((columns[other] ?? []).filter(entry => entry.kind === 'skill').map(entry => entry.presence.documentPath));
    for (const entry of columns[provider] ?? []) {
      const presence = entry.presence;
      if (entry.kind !== 'skill' || !targets.has(presence.documentPath) || !['user', 'project', 'builtin'].includes(presence.scope ?? '')) continue;
      if (!/^[^/\\:]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
      const projectRoot = path.join(context.projectPath, provider === 'claude' ? '.claude/skills' : '.agents/skills');
      const userRoot = provider === 'claude'
        ? path.join(path.resolve(context.projectPath, context.claude?.configDir ?? path.join(context.homeDir, '.claude')), 'skills')
        : path.join(context.homeDir, '.agents/skills');
      const roots = presence.scope === 'project' ? [projectRoot] : presence.scope === 'user' ? [userRoot] : [projectRoot, userRoot];
      for (const root of roots) try {
        const folder = path.join(root, entry.name);
        if (!(await lstat(folder)).isSymbolicLink()) continue;
        const target = await readlink(folder);
        if (target === '' || await realpath(path.join(folder, 'SKILL.md')) !== presence.documentPath) continue;
        presence.sharedFrom = other; break;
      } catch { /* Canonical equality alone never implies a symlink or its direction. */ }
    }
  }
}

export type PreparedMcpAction = { ok: false; code: CapabilityActionReason | 'context-changed' | 'shutdown' } | {
  ok: true; context: SnapshotContext; inventory: NativeMcpInventory; target?: NativeMcpTarget; checkProof: string | null; isCurrent(): boolean;
};
export type PreparedPluginAction = { ok: false; code: CapabilityActionReason | 'context-changed' | 'shutdown' } | {
  ok: true; context: SnapshotContext; inventory: NativePluginInventory; target?: NativePluginTarget; isCurrent(): boolean;
};
export type PreparedSkillAction = { ok: false; code: 'stale' | 'shutdown' | 'unverified' | 'context-changed' | 'builtin' | 'ambiguous' } | { ok: true; target: SkillShareTarget; isCurrent(): boolean };
export interface SafeCapabilitiesService {
  prepareSkillAction(params: CapabilitySkillTarget, kind?: 'share' | 'unshare'): Promise<PreparedSkillAction>;
  get(projectPath: string): CapabilitySnapshot;
  refresh(projectPath: string): CapabilitySnapshot;
  prepareMcpAction(params: CapabilityMcpTarget | { projectPath: string; provider: CapabilityProvider; revision: number }): Promise<PreparedMcpAction>;
  preparePluginAction(params: CapabilityPluginCatalogRequest | CapabilityPluginTargetRequest | CapabilityPluginDetailsRequest | CapabilityPluginInstallRequest): Promise<PreparedPluginAction>;
  recordMcpCheck(projectPath: string, provider: CapabilityProvider, target: NativeMcpTarget, status: CapabilityPresence['status'], proof: string | null): boolean;
  dispose(): void;
}
export interface SafeCapabilitiesOptions extends SnapshotReaderOptions {
  context?: (projectPath: string) => Promise<SnapshotContext>;
  readers?: Partial<Record<CapabilityProvider, ProviderSnapshotReader>>;
  changed?: (projectPath: string, snapshot: CapabilitySnapshot) => void;
}

/** Private effective-selection proof captured before Check, never published in DTOs. */
function mcpCheckProof(inventory: NativeMcpInventory | undefined, target: NativeMcpTarget | undefined): string | null {
  if (!inventory || !target?.check.allowed) return null;
  return fingerprint({ context: inventory.contextFingerprint, inventory: inventory.signature,
    executionBinary: inventory.executionBinary, binary: inventory.binaryIdentity,
    target: { id: target.id, provider: target.provider, name: target.name, scope: target.scope, fingerprint: target.fingerprint } });
}

export function createSafeCapabilitiesService(options: SafeCapabilitiesOptions = {}): SafeCapabilitiesService {
  interface Cached { generation: number; snapshot: CapabilitySnapshot; entries: Partial<Record<CapabilityProvider, SnapshotEntry[]>>; inventories: Partial<Record<CapabilityProvider, NativeMcpInventory>>; pluginInventories: Partial<Record<CapabilityProvider, NativePluginInventory>>; contexts: Partial<Record<CapabilityProvider, SnapshotContext>>; skillContexts: Partial<Record<CapabilityProvider, boolean>>; health: Map<string, { provider: CapabilityProvider; proof: string; status: CapabilityPresence['status'] }> }
  const cache = new Map<string, Cached>();
  let disposed = false;
  const copy = (value: CapabilitySnapshot): CapabilitySnapshot => structuredClone(value);
  const active = (key: string, generation: number): Cached | undefined => {
    const value = cache.get(key); return !disposed && value?.generation === generation ? value : undefined;
  };
  const emit = (key: string, value: Cached): void => { options.changed?.(key, copy(value.snapshot)); };
  const refresh = (projectPath: string): CapabilitySnapshot => {
    const key = path.resolve(projectPath);
    const previous = cache.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    const value: Cached = { generation, entries: {}, inventories: {}, pluginInventories: {}, contexts: {}, skillContexts: {}, health: new Map(previous?.health), snapshot: { projectPath: key, revision: (previous?.snapshot.revision ?? 0) + 1,
      columns: { claude: { phase: 'loading', diagnostics: [] }, codex: { phase: 'loading', diagnostics: [] } }, rows: [] } };
    cache.set(key, value);
    const finish = async (provider: CapabilityProvider, result: ProviderSnapshotResult, context?: SnapshotContext): Promise<void> => {
      const current = active(key, generation); if (!current) return;
      if (context) current.contexts[provider] = context;
      current.skillContexts[provider] = result.skillSharingContext === true;
      const entries: SnapshotEntry[] = []; const diagnostics = [...result.diagnostics];
      const healthKeys = new Set<string>();
      for (const entry of result.entries) {
        // Rebuild the allowlist even for injected readers; no raw extra property reaches DTO/events.
        const p = entry.presence;
        const safe: CapabilityPresence = { id: p.id, scope: p.scope, source: p.source, documentPath: p.documentPath,
          description: safeText(p.description), installed: p.installed, enabled: p.enabled, status: p.status,
          summary: safeText(p.summary), modelAvailable: p.modelAvailable, unavailableReason: p.unavailableReason,
          ...(p.sharedFrom ? { sharedFrom: p.sharedFrom } : {}),
          ...(entry.kind === 'mcp' ? { mcpActions: { remove: deny(), check: deny(provider === 'codex' ? 'native-only' : 'unverified') } } : {}) };
        const target = result.native?.targets.find(target => target.id === p.id && target.provider === provider);
        if (target && entry.kind === 'mcp') {
          safe.mcpActions = { remove: target.remove, check: target.check };
          const key = JSON.stringify([provider, target.id]);
          const proof = mcpCheckProof(result.native, target);
          const health = current.health.get(key);
          if (proof !== null && health?.proof === proof && safe.enabled !== false) {
            safe.status = health.status; healthKeys.add(key);
          }
        }
        const pluginTarget = result.pluginsNative?.targets.find(target => target.id === p.id && target.kind === 'installed');
        if (entry.kind === 'plugin') safe.pluginActions = pluginTarget ? { uninstall: pluginTarget.actions.uninstall, enable: pluginTarget.actions.enable, disable: pluginTarget.actions.disable, details: pluginTarget.actions.details } : { uninstall: deny(), enable: deny(), disable: deny(), details: deny('native-only') };
        const parsed = capabilityPresence.safeParse(safe);
        if (!parsed.success || !safeText(entry.name)) { diagnostics.push({ code: 'invalid-output' }); continue; }
        entries.push({ ...(entry.kind === 'skill' && entry.nativeSkill?.provider === provider && entry.nativeSkill.path === safe.documentPath && entry.nativeSkill.name === entry.name ? { nativeSkill: { ...entry.nativeSkill }, skillSharingContext: entry.skillSharingContext === true } : {}), kind: entry.kind, name: safeText(entry.name)!, ...(entry.rowId && /^[a-f0-9]{64}$/.test(entry.rowId) ? { rowId: entry.rowId } : {}), presence: parsed.data });
      }
      if (context) entries.unshift({ kind: 'mcp', name: 'parley', rowId: rowIdentity('mcp', 'parley'), presence: {
        id: JSON.stringify([provider, 'mcp', 'builtin', 'parley']), scope: 'builtin', source: 'Parley launch',
        documentPath: null, description: 'Provided by Parley when a session starts.', installed: true,
        enabled: null, status: 'unknown', summary: 'Provided at session launch', modelAvailable: null, unavailableReason: null,
        mcpActions: { remove: deny('builtin'), check: deny('builtin') },
      } });
      let bytes = 0;
      const bounded = entries.filter(entry => { bytes += Buffer.byteLength(JSON.stringify(entry)); return bytes <= 1024 * 1024; });
      if (bounded.length !== entries.length) diagnostics.push({ code: 'output-limit', count: entries.length - bounded.length });
      const visibleHealthKeys = new Set(bounded.filter(entry => entry.kind === 'mcp').map(entry => JSON.stringify([provider, entry.presence.id])));
      for (const [key, health] of current.health)
        if (health.provider === provider && (!healthKeys.has(key) || !visibleHealthKeys.has(key))) current.health.delete(key);
      current.entries[provider] = bounded;
      if (result.native) current.inventories[provider] = { ...result.native,
        names: context ? [...new Set([...result.native.names, 'parley'])] : [...result.native.names],
        targets: result.native.targets.filter(target => bounded.some(entry => entry.kind === 'mcp' && entry.presence.id === target.id)) };
      if (result.pluginsNative) current.pluginInventories[provider] = { ...result.pluginsNative, targets: result.pluginsNative.targets.filter(target => target.kind === 'available' || bounded.some(entry => entry.kind === 'plugin' && entry.presence.id === target.id)) };
      if (context) await markSharedLinks(context, current.entries);
      if (active(key, generation) !== current) return;
      current.snapshot.columns[provider] = { phase: diagnostics.length && result.phase === 'ready' ? 'partial' : result.phase, diagnostics,
        ...(result.native ? { mcpAdd: result.native.add } : {}),
        ...(result.pluginsNative ? { pluginCatalog: result.pluginsNative.catalog, pluginMarketplaceAdd: result.pluginsNative.marketplaceAdd } : {}) };
      current.snapshot.rows = mergeSnapshotRows(current.entries);
      for (const row of current.snapshot.rows.filter(row => row.kind === 'skill')) for (const source of ['claude', 'codex'] as const) for (const presence of row[source]) {
        const privateEntry = current.entries[source]?.find(entry => entry.presence.id === presence.id);
        const record = current.skillContexts.claude === true && current.skillContexts.codex === true && privateEntry?.skillSharingContext === true ? privateEntry.nativeSkill : undefined;
        const sourceContext = current.contexts[source];
        const prepared = record && sourceContext ? await prepareSkillShare(sourceContext, record, { builtin: presence.scope === 'builtin', separateCopies: row.separateCopies }, false, true) : null;
        const availability = prepared?.ok ? await skillShareAvailability(prepared.target) : null;
        const reason = !prepared || prepared.ok ? 'unverified' : prepared.code === 'builtin' ? 'builtin' : prepared.code === 'ambiguous' ? 'ambiguous' : prepared.code === 'unsupported-scope' ? 'unsupported-scope' : 'unverified';
        presence.skillActions = { share: record && skillSharePolicyAllowed(record) && availability?.share ? { allowed: true, reason: null } : deny(reason), unshare: availability?.unshare ? { allowed: true, reason: null } : deny(reason) };
      }
      if (active(key, generation) !== current) return;
      current.snapshot.revision += 1;
      try { current.snapshot = capabilitySnapshot.parse(current.snapshot); }
      catch { delete current.pluginInventories[provider]; delete current.inventories[provider]; current.entries[provider] = []; current.snapshot.rows = mergeSnapshotRows(current.entries);
        current.snapshot.columns[provider] = { phase: 'error', diagnostics: [{ code: 'invalid-output' }] }; }
      emit(key, current);
    };
    void (options.context ?? defaultSnapshotContext)(key).then(context => {
      for (const provider of ['claude', 'codex'] as const) {
        const reader = options.readers?.[provider] ?? (provider === 'claude' ? readClaudeSnapshot : readCodexSnapshot);
        void reader(context, { readNative: options.readNative ?? readNativeJson, readCodexContext: options.readCodexContext ?? readCodexNativeContext, readBinaryIdentity: options.readBinaryIdentity ?? readBinaryIdentity, readPluginInventory: options.readPluginInventory ?? readNativePluginInventory }).then(async result => {
          result.diagnostics.push(...await builtinSkills(context, result.entries));
          await finish(provider, result, context);
        }).catch(() => finish(provider, { entries: [], diagnostics: [{ code: 'invalid-output' }], phase: 'error' }, context));
      }
    }).catch(() => {
      for (const provider of ['claude', 'codex'] as const)
        void finish(provider, { entries: [], diagnostics: [{ code: 'missing-context', source: 'context' }], phase: 'error' });
    });
    return copy(value.snapshot);
  };
  return { get(projectPath) { const value = cache.get(path.resolve(projectPath)); return value ? copy(value.snapshot) : refresh(projectPath); },
    refresh,
    async prepareSkillAction(params, kind = 'share') {
      if (disposed) return { ok: false, code: 'shutdown' };
      const key = path.resolve(params.projectPath), current = cache.get(key);
      if (!current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
      const entry = current.entries[params.provider]?.find(row => row.kind === 'skill' && row.presence.id === params.presenceId);
      const original = entry?.nativeSkill, previous = current.contexts[params.provider];
      if (!original || !previous || entry?.skillSharingContext !== true || current.skillContexts.claude !== true || current.skillContexts.codex !== true) return { ok: false, code: 'unverified' };
      try {
        const context = await (options.context ?? defaultSnapshotContext)(key);
        const contextIdentity = (value: SnapshotContext): string => fingerprint([contextFingerprint(value, 'claude'), contextFingerprint(value, 'codex')]);
        if (contextIdentity(context) !== contextIdentity(previous)) return { ok: false, code: 'context-changed' };
        const catalogs = await Promise.all([
          resolveSkillCatalog({ provider: 'claude', cwd: context.projectPath, homeDir: context.homeDir, ...context.claude, limits: { ...context.claude?.limits, maxEntries: Math.min(context.claude?.limits?.maxEntries ?? 2000, 2000) } }),
          resolveSkillCatalog({ provider: 'codex', cwd: context.projectPath, homeDir: context.homeDir, ...context.codex, limits: { ...context.codex?.limits, maxEntries: Math.min(context.codex?.limits?.maxEntries ?? 2000, 2000) } }),
        ]);
        if (disposed) return { ok: false, code: 'shutdown' };
        if (cache.get(key) !== current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
        if (catalogs.some(catalog => !skillSharingCatalogKnown(catalog))) return { ok: false, code: 'unverified' };
        const records = catalogs.flatMap(catalog => catalog.skills);
        const matches = records.filter(record => record.provider === params.provider && record.path === original.path && record.name === original.name && record.documentKind === original.documentKind);
        if (matches.length !== 1 || fingerprint(matches[0]) !== fingerprint(original)) return { ok: false, code: 'context-changed' };
        const fresh: NativeSkill = matches[0]!;
        if (new Set(records.filter(record => record.name === fresh.name).map(record => record.path)).size > 1) return { ok: false, code: 'ambiguous' };
        const freshEntries = [{ ...entry!, nativeSkill: fresh, presence: { ...entry!.presence } }];
        if ((await builtinSkills(context, freshEntries)).length) return { ok: false, code: 'unverified' };
        if (freshEntries[0]!.presence.scope === 'builtin') return { ok: false, code: 'builtin' };
        const prepared = await prepareSkillShare(context, fresh, { builtin: false, separateCopies: false }, kind === 'share', kind === 'unshare');
        if (!prepared.ok) return { ok: false, code: 'unverified' };
        return { ok: true, target: prepared.target, isCurrent: () => !disposed && cache.get(key) === current && current.snapshot.revision === params.revision };
      } catch { return { ok: false, code: 'unverified' }; }
    },
    async prepareMcpAction(params) {
      if (disposed) return { ok: false, code: 'shutdown' };
      const key = path.resolve(params.projectPath); const current = cache.get(key);
      if (!current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
      const previous = current.inventories[params.provider];
      if (!previous) return { ok: false, code: 'unverified' };
      const oldTarget = 'presenceId' in params ? previous.targets.find(target => target.id === params.presenceId) : undefined;
      if ('presenceId' in params && !oldTarget) return { ok: false, code: 'unverified' };
      try {
        const context = await (options.context ?? defaultSnapshotContext)(key);
        if (contextFingerprint(context, params.provider) !== previous.contextFingerprint) return { ok: false, code: 'context-changed' };
        const reader = options.readers?.[params.provider] ?? (params.provider === 'claude' ? readClaudeSnapshot : readCodexSnapshot);
        const result = await reader(context, { readNative: options.readNative ?? readNativeJson, readCodexContext: options.readCodexContext ?? readCodexNativeContext, readBinaryIdentity: options.readBinaryIdentity ?? readBinaryIdentity });
        if (disposed) return { ok: false, code: 'shutdown' };
        if (cache.get(key) !== current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
        const fresh = result.native;
        if (!fresh || fresh.contextFingerprint !== previous.contextFingerprint || fresh.signature !== previous.signature) return { ok: false, code: 'context-changed' };
        const target = oldTarget ? fresh.targets.find(item => item.id === oldTarget.id) : undefined;
        if (fresh.executionBinary) {
          const binary = params.provider === 'claude' ? await verifiedClaudeActionBinary(context, options.readBinaryIdentity ?? readBinaryIdentity)
            : await (options.readBinaryIdentity ?? readBinaryIdentity)(fresh.executionBinary, context);
          if (!binary || binary.canonicalPath !== fresh.executionBinary || params.provider === 'codex' && !sameBinaryIdentity(binary, fresh.binaryIdentity)) return { ok: false, code: 'context-changed' };
          if (disposed) return { ok: false, code: 'shutdown' };
          if (cache.get(key) !== current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
        }
        if (oldTarget && (!target || target.name !== oldTarget.name || target.scope !== oldTarget.scope || target.fingerprint !== oldTarget.fingerprint)) return { ok: false, code: 'context-changed' };
        return { ok: true, context: fresh.executionBinary ? { ...context, binaries: { ...context.binaries, [params.provider]: fresh.executionBinary } } : context, inventory: { ...fresh, names: [...new Set([...fresh.names, ...previous.names.filter(name => name === 'parley')])] }, ...(target ? { target } : {}), checkProof: mcpCheckProof(fresh, target),
          isCurrent: () => !disposed && cache.get(key) === current && current.snapshot.revision === params.revision };
      } catch { return { ok: false, code: 'unverified' }; }
    },
    async preparePluginAction(params) {
      if (disposed) return { ok: false, code: 'shutdown' };
      const key = path.resolve(params.projectPath); const current = cache.get(key);
      if (!current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
      const previous = current.pluginInventories[params.provider];
      if (!previous) return { ok: false, code: 'unverified' };
      const selector = 'target' in params ? params.target.kind === 'installed' ? params.target.presenceId : params.target.catalogId
        : 'presenceId' in params ? params.presenceId : 'catalogId' in params ? params.catalogId : undefined;
      const oldTarget = selector ? previous.targets.find(target => target.id === selector) : undefined;
      if (selector && !oldTarget) return { ok: false, code: 'unverified' };
      try {
        const context = await (options.context ?? defaultSnapshotContext)(key);
        if (contextFingerprint(context, params.provider) !== previous.contextFingerprint) return { ok: false, code: 'context-changed' };
        const fresh = await (options.readPluginInventory ?? readNativePluginInventory)(context, params.provider, options);
        if (disposed) return { ok: false, code: 'shutdown' };
        if (cache.get(key) !== current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
        if (fresh.provider !== params.provider || fresh.contextFingerprint !== previous.contextFingerprint || fresh.signature !== previous.signature) return { ok: false, code: 'context-changed' };
        const target = oldTarget ? fresh.targets.find(value => value.id === oldTarget.id) : undefined;
        if (oldTarget && (!target || target.nativeId !== oldTarget.nativeId || target.scope !== oldTarget.scope || target.fingerprint !== oldTarget.fingerprint || target.sourceFingerprint !== oldTarget.sourceFingerprint)) return { ok: false, code: 'context-changed' };
        if (fresh.executionBinary) {
          const identity = params.provider === 'claude' ? await verifiedClaudeActionBinary(context, options.readBinaryIdentity ?? readBinaryIdentity)
            : await (options.readBinaryIdentity ?? readBinaryIdentity)(fresh.executionBinary, context);
          if (!sameBinaryIdentity(identity, fresh.binaryIdentity)) return { ok: false, code: 'context-changed' };
          if (disposed) return { ok: false, code: 'shutdown' };
          if (cache.get(key) !== current || current.snapshot.revision !== params.revision) return { ok: false, code: 'stale' };
        }
        return { ok: true, context: fresh.executionBinary ? { ...context, binaries: { ...context.binaries, [params.provider]: fresh.executionBinary } } : context,
          inventory: fresh, ...(target ? { target } : {}), isCurrent: () => !disposed && cache.get(key) === current && current.snapshot.revision === params.revision };
      } catch { return { ok: false, code: 'unverified' }; }
    },
    recordMcpCheck(projectPath, provider, target, status, proof) {
      const current = cache.get(path.resolve(projectPath));
      const inventory = current?.inventories[provider];
      const winning = inventory?.targets.find(item => item.id === target.id && item.provider === provider);
      if (disposed || !current || proof === null || proof === undefined || mcpCheckProof(inventory, winning) !== proof ||
        mcpCheckProof(inventory, target) !== proof) return false;
      current.health.set(JSON.stringify([provider, target.id]), { provider, proof, status });
      return true;
    },
    dispose() { disposed = true; cache.clear(); } };
}
