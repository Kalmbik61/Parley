import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { readCodexNativeContext } from '@parley/core';
import type { CapabilityActionAvailability, CapabilityMcpAddAvailability, CapabilityPluginSummary, CapabilityProvider } from '@parley/protocol';
import { allow, deny, deniedAdd, fingerprint, contextFingerprint, readBinaryIdentity, sameBinaryIdentity,
  verifiedClaudeActionBinary, claudeDestinationsBound, canonicalFileLocation, codexUserConfigProof } from './native-targets.js';
import type { NativeBinaryIdentity, McpScope } from './native-targets.js';
import { nativeIdentity, object, readNativeJson, readJsonFile, safeText, secretValues } from './redact.js';
import type { SnapshotContext, SnapshotReaderOptions } from './snapshot.js';

export interface NativePluginTarget {
  id: string; kind: 'installed' | 'available'; nativeId: string; scope: McpScope | null;
  fingerprint: string; sourceFingerprint: string | null;
  actions: CapabilityPluginSummary['actions']; summary: CapabilityPluginSummary;
}
export interface NativePluginInventory {
  provider: CapabilityProvider; contextFingerprint: string; signature: string;
  executionBinary: string | null; binaryIdentity: NativeBinaryIdentity | null;
  targets: NativePluginTarget[]; installScopes: CapabilityMcpAddAvailability; marketplaceNames: string[]; marketplaceAdd: CapabilityMcpAddAvailability;
  catalog: CapabilityActionAvailability; partial: boolean;
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
/** Audited 2.1.287 Tp/VE/QA branches are not ordinary selected-scope plugins. */
export function isClaudeSpecialMarketplace(name: string): boolean {
  const lower = name.toLowerCase();
  return ['builtin', 'inline', 'skills-dir', 'synced'].includes(lower) ||
    lower.replace(/[. ]+$/, '').replace(/[^a-z0-9_-]/g, '-') === 'anthropic-plugin-directory';
}
function pluginSecrets(value: unknown): string[] {
  const values = new Set(secretValues(value)); let remaining = 50_000;
  const visit = (item: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 12 || values.size > 256) { values.add('\0redaction-overflow'); return; }
    if (Array.isArray(item)) { for (const child of item.slice(0, 4000)) visit(child, depth + 1); return; }
    const data = object(item); if (!data) return;
    for (const [key, child] of Object.entries(data)) {
      if (/^(path|root|installLocation|installPath|installedPath|command|headersHelper|sourceCommand)$/.test(key) && typeof child === 'string' && child !== '') values.add(child);
      else visit(child, depth + 1);
    }
  };
  visit(value, 0); return [...values].sort((a, b) => b.length - a.length);
}
const display = (value: unknown, secrets: readonly string[]): string | null => {
  const result = safeText(value, secrets);
  return result !== null && Buffer.from(result, 'utf8').toString('utf8') === result ? Array.from(result).slice(0, 8192).join('') : null;
};
const emptyComposition = (): CapabilityPluginSummary['composition'] => ({ skills: null, agents: null, mcp: null, hooks: null, tokenEstimate: null });
const noActions = (): CapabilityPluginSummary['actions'] => ({ install: deny(), uninstall: deny(), enable: deny(), disable: deny(), details: deny('native-only') });
const contained = (root: string, file: string): boolean => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

interface SourceBudget { files: Map<string, Record<string, unknown> | null>; remaining: number; exhausted: boolean }
async function sourceMetadata(file: string, budget: SourceBudget): Promise<Record<string, unknown> | null> {
  if (budget.files.has(file)) return budget.files.get(file)!;
  if (budget.files.size >= 128 || budget.remaining < 1024 * 1024) { budget.exhausted = true; return null; }
  budget.remaining -= 1024 * 1024; // Reserve the full bounded read, including whitespace.
  const info = await lstat(file);
  if (!info.isFile() || await realpath(file) !== file) return null;
  const read = await readJsonFile(file, 1024 * 1024); const data = read.status === 'valid' ? object(read.data) : null;
  budget.files.set(file, data); return data;
}

/** Only metadata is read. Native registration plus the exact regular manifest establishes source,
 * never cache location alone. Command/helper/unknown closure branches fail closed. */
async function sourceProof(id: string, available: readonly Record<string, unknown>[], marketplaces: readonly Record<string, unknown>[], provider: CapabilityProvider, installed: readonly Record<string, unknown>[], budget: SourceBudget): Promise<string | null> {
  const pending = new Set<string>(); const visited = new Map<string, unknown>();
  const walk = async (pluginId: string): Promise<boolean> => {
    if (visited.has(pluginId)) return true;
    if (pending.has(pluginId) || pending.size + visited.size >= 30 || !validId(pluginId)) return false;
    if (pluginId !== id && installed.some(entry => String(provider === 'claude' ? entry.id : entry.pluginId).toLowerCase() === pluginId.toLowerCase())) return false;
    pending.add(pluginId);
    const name = pluginId.split('@')[0]!, marketplaceName = pluginId.split('@')[1]!;
    const listed = available.filter(entry => String(entry.pluginId).toLowerCase() === pluginId.toLowerCase());
    const registrations = marketplaces.filter(entry => String(entry.name).toLowerCase() === marketplaceName.toLowerCase());
    if (listed.length !== 1 || registrations.length !== 1) return false;
    const rawRegistration = registrations[0]!;
    const registration = provider === 'codex' ? { ...rawRegistration, source: object(rawRegistration.marketplaceSource)?.sourceType === 'local' ? 'directory' : null, path: object(rawRegistration.marketplaceSource)?.source, installLocation: rawRegistration.root } : rawRegistration;
    if (registration.source !== 'directory' || typeof registration.path !== 'string' || !path.isAbsolute(registration.path) ||
      typeof registration.installLocation !== 'string' || !path.isAbsolute(registration.installLocation)) return false;
    try {
      const root = await realpath(registration.path);
      if (!(await lstat(root)).isDirectory() || await realpath(registration.installLocation) !== root) return false;
      const file = path.join(root, '.claude-plugin', 'marketplace.json');
      const market = await sourceMetadata(file, budget);
      if (!market || market.name !== marketplaceName || !Array.isArray(market.plugins) || market.plugins.length > 2000 || market.headersHelper !== undefined) return false;
      const matches = market.plugins.map(object).filter(entry => String(entry?.name).toLowerCase() === name.toLowerCase());
      const entry = matches.length === 1 ? matches[0] : null;
      if (!entry || entry.name !== name || typeof entry.source !== 'string' || !entry.source.startsWith('./') || provider === 'claude' && entry.source !== listed[0]!.source ||
        entry.headersHelper !== undefined || entry.sourceCommand !== undefined || entry.command !== undefined) return false;
      const plugin = await realpath(path.resolve(root, entry.source));
      if (!contained(root, plugin) || !(await lstat(plugin)).isDirectory()) return false;
      if (provider === 'codex') {
        const listedSource = object(listed[0]!.source);
        if (listedSource?.source !== 'local' || typeof listedSource.path !== 'string' || !path.isAbsolute(listedSource.path) || await realpath(listedSource.path) !== plugin) return false;
      }
      const metadataFile = path.join(plugin, '.claude-plugin', 'plugin.json');
      const metadata = await sourceMetadata(metadataFile, budget);
      if (!metadata || metadata.name !== name || [entry.version, listed[0]!.version].some(version => version !== undefined && version !== metadata.version) || metadata.headersHelper !== undefined || metadata.sourceCommand !== undefined || metadata.command !== undefined) return false;
      if (provider === 'codex') {
        if (listed[0]!.authPolicy !== 'ON_INSTALL' || listed[0]!.installPolicy !== 'AVAILABLE' ||
          ['mcpServers', 'apps', 'connectors', 'oauth', 'auth'].some(key => Object.hasOwn(metadata, key))) return false;
        try { await lstat(path.join(plugin, '.mcp.json')); return false; }
        catch (error) { if (object(error)?.code !== 'ENOENT') return false; }
      }
      for (const existing of installed) {
        const location = existing.installPath ?? existing.installedPath;
        if (typeof location !== 'string' || !path.isAbsolute(location)) continue;
        try { if (await realpath(location) === plugin) return false; } catch { /* A missing cache does not establish an alias. */ }
      }
      const dependencies = [...(Array.isArray(entry.dependencies) ? entry.dependencies : []), ...(Array.isArray(metadata.dependencies) ? metadata.dependencies : [])];
      if (entry.dependencies !== undefined && !Array.isArray(entry.dependencies) || metadata.dependencies !== undefined && !Array.isArray(metadata.dependencies) ||
        dependencies.length > 30 || dependencies.some(dependency => !validId(dependency))) return false;
      for (const dependency of dependencies) if (!await walk(dependency as string)) return false;
      pending.delete(pluginId); visited.set(pluginId, { registration, root, market, plugin, metadata }); return true;
    } catch { return false; }
  };
  return await walk(id) ? fingerprint([...visited.entries()].sort(([a], [b]) => a.localeCompare(b))) : null;
}

/** A fresh local path is explicit input, not a display id or remote installer source. */
export async function localMarketplaceSource(file: string, verifyClosure = false): Promise<{ path: string; name: string; fingerprint: string } | null> {
  try {
    if (!path.isAbsolute(file)) return null;
    const canonical = await realpath(file); const info = await lstat(canonical);
    if (!info.isDirectory()) return null;
    const manifest = path.join(canonical, '.claude-plugin', 'marketplace.json');
    if (!(await lstat(manifest)).isFile() || await realpath(manifest) !== manifest) return null;
    const read = await readJsonFile(manifest, 1024 * 1024); const data = read.status === 'valid' ? object(read.data) : null;
    if (!data || typeof data.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.name) ||
      !Array.isArray(data.plugins) || data.plugins.length > 2000) return null;
    let closure: string[] | null = null;
    if (verifyClosure) {
      if (data.headersHelper !== undefined || data.sourceCommand !== undefined || data.command !== undefined) return null;
      const entries = data.plugins.map(object);
      if (entries.some(entry => !entry || typeof entry.name !== 'string' || !validId(`${entry.name}@${data.name}`))) return null;
      // Explicit candidate input, not evidence of an existing native registration/catalog.
      const candidates = entries.map(entry => ({ pluginId: `${entry!.name}@${data.name}`, source: entry!.source, ...(entry!.version === undefined ? {} : { version: entry!.version }) }));
      const registration = [{ name: data.name, source: 'directory', path: canonical, installLocation: canonical }];
      const budget: SourceBudget = { files: new Map(), remaining: 32 * 1024 * 1024, exhausted: false };
      closure = [];
      for (const entry of candidates) {
        const proof = await sourceProof(entry.pluginId, candidates, registration, 'claude', [], budget);
        if (proof === null) return null; closure.push(proof);
      }
    }
    return { path: canonical, name: data.name, fingerprint: fingerprint({ canonical, data, closure }) };
  } catch { return null; }
}

export async function readNativePluginInventory(context: SnapshotContext, provider: CapabilityProvider, options: SnapshotReaderOptions = {}): Promise<NativePluginInventory> {
  const identify = options.readBinaryIdentity ?? readBinaryIdentity;
  const nativeEnv = context.env ?? process.env;
  const nativeConfigDir = path.resolve(context.projectPath, context.claude?.configDir ?? nativeEnv.CLAUDE_CONFIG_DIR ?? path.join(context.homeDir, '.claude'));
  const identity = await identify(context.binaries[provider], context);
  const binary = identity?.canonicalPath ?? context.binaries[provider];
  const native = options.readNative ?? readNativeJson;
  const read = async (args: readonly string[]) => native(binary, args, context).catch(() => ({ status: 'invalid' as const, code: 'invalid-output' as const }));
  const [listed, registered, codexNative, redactionInputs] = await Promise.all([
    read(['plugin', 'list', '--available', '--json']),
    read(['plugin', 'marketplace', 'list', '--json']),
    provider === 'codex' && options.codexPluginContext && sameBinaryIdentity(identity, options.codexPluginContext.binaryIdentity) ? options.codexPluginContext.context : provider === 'codex' && binary ? (options.readCodexContext ?? readCodexNativeContext)({ command: binary, cwd: context.projectPath, ...(context.env ? { env: context.env } : {}) }).catch(() => null) : null,
    options.pluginRedactionSecrets ? null : provider === 'codex' ? read(['mcp', 'list', '--json']) : Promise.all([
      readJsonFile(context.claude?.userConfigFile ?? (nativeEnv.CLAUDE_CONFIG_DIR ? path.join(nativeConfigDir, '.claude.json') : path.join(context.homeDir, '.claude.json'))),
      readJsonFile(path.join(context.projectPath, '.mcp.json')),
    ]),
  ]);
  const stableBinary = identity !== null && sameBinaryIdentity(identity, await identify(identity.canonicalPath, context));
  const approved = provider === 'claude' ? stableBinary && await verifiedClaudeActionBinary(context, identify) !== null : stableBinary;
  const list = listed.status === 'valid' ? object(listed.data) : null;
  const installedRaw = Array.isArray(list?.installed) ? list.installed : [];
  const availableRaw = Array.isArray(list?.available) ? list.available : [];
  const installed = installedRaw.slice(0, 2000).map(object).filter((entry): entry is Record<string, unknown> => entry !== null);
  const available = availableRaw.slice(0, 2000).map(object).filter((entry): entry is Record<string, unknown> => entry !== null);
  const marketData = registered.status === 'valid' ? registered.data : null;
  const marketRaw = provider === 'claude' ? marketData : object(marketData)?.marketplaces;
  const marketplaces = Array.isArray(marketRaw) ? marketRaw.slice(0, 2000).map(object).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  const complete = !!list && Array.isArray(list.installed) && Array.isArray(list.available) && installedRaw.length <= 2000 && availableRaw.length <= 2000 &&
    installed.length === installedRaw.length && available.length === availableRaw.length;
  const completeMarkets = Array.isArray(marketRaw) && marketRaw.length <= 2000 && marketplaces.length === marketRaw.length;
  let destinations = false; const ownership: Record<string, Record<string, unknown> | null> = {}; const storage: Record<string, unknown> = {};
  const proof = provider === 'codex' && approved ? await codexUserConfigProof(context, codexNative, 'plugins') : null;
  if (provider === 'claude' && approved && claudeDestinationsBound(context)) try {
    const cwd = await realpath(context.projectPath);
    destinations = !!context.claude?.mainCheckout && await realpath(context.claude.mainCheckout) === cwd;
    const configDir = nativeConfigDir;
    for (const [scope, file] of Object.entries({ user: path.join(configDir, 'settings.json'), project: path.join(cwd, '.claude/settings.json'), local: path.join(cwd, '.claude/settings.local.json') })) {
      const data = await readJsonFile(file, 1024 * 1024);
      const mapping = data.status === 'valid' ? object(data.data) : null;
      ownership[scope] = data.status === 'missing' ? {} : mapping ? object(mapping.enabledPlugins) ?? (mapping.enabledPlugins === undefined ? {} : null) : null;
      storage[scope] = { path: await canonicalFileLocation(file), read: data };
    }
  } catch { destinations = false; }
  const installScopes = provider === 'claude' && approved && destinations && completeMarkets ? { user: ownership.user ? allow() : deny(), project: ownership.project ? allow() : deny(), local: ownership.local ? allow() : deny() }
    : provider === 'codex' && approved && completeMarkets && proof?.add ? { user: allow(), project: deny('unsupported-scope'), local: deny('unsupported-scope') } : deniedAdd(binary ? 'unverified' : 'not-installed');
  const cleanClaudeContext = provider === 'claude' && approved && destinations && complete && completeMarkets && installedRaw.length === 0 &&
    available.every(entry => validId(entry.pluginId)) && Object.values(ownership).length === 3 && Object.values(ownership).every(value => value !== null && Object.keys(value).length === 0);
  const marketplaceAdd = provider === 'claude' ? cleanClaudeContext ? installScopes : deniedAdd() : installScopes;
  const secrets = [...(options.pluginRedactionSecrets ?? pluginSecrets(redactionInputs)), ...pluginSecrets(codexNative), ...pluginSecrets(list), ...pluginSecrets(marketData), ...pluginSecrets(storage), ...secretValues({ env: context.env }), context.projectPath, context.homeDir, ...(binary ? [binary] : [])];
  const targets: NativePluginTarget[] = [];
  const sourceBudget: SourceBudget = { files: new Map(), remaining: 32 * 1024 * 1024, exhausted: false };
  for (const [kind, records] of [['installed', installed], ['available', available]] as const) for (const data of records) {
    const nativeId = provider === 'claude' && kind === 'installed' ? data.id : data.pluginId;
    if (!validId(nativeId)) continue;
    let scope: McpScope | null = kind === 'installed' ? provider === 'codex' ? proof?.names.has(nativeId) ? 'user' : null
      : data.scope === 'user' || data.scope === 'project' || data.scope === 'local' ? data.scope : null : null;
    let boundProject = scope === 'user';
    if (scope === 'project' || scope === 'local') try { boundProject = typeof data.projectPath === 'string' && await realpath(data.projectPath) === await realpath(context.projectPath); } catch { /* Unproven target stays denied. */ }
    if ((scope === 'project' || scope === 'local') && !boundProject) scope = null;
    const special = provider === 'claude' && (isClaudeSpecialMarketplace(nativeId.split('@')[1]!) || data.isBuiltin === true ||
      marketplaces.some(registration => String(registration.name).toLowerCase() === nativeId.split('@')[1]!.toLowerCase() && ['pluginDirectory', 'claudeai'].includes(String(registration.source))));
    const owned = !special && approved && complete && (provider === 'claude' ? destinations && boundProject && scope !== null &&
      typeof ownership[scope]?.[nativeId] === 'boolean' && ownership[scope]![nativeId] === data.enabled : proof?.names.has(nativeId) === true);
    const ambiguous = kind === 'installed' && records.filter(other => String(provider === 'claude' ? other.id : other.pluginId).toLowerCase() === nativeId.toLowerCase() && other.scope === data.scope).length !== 1;
    const source = kind === 'available' && !special && approved && complete && completeMarkets && (provider === 'claude' ? destinations : proof?.add && !proof.foreignNames.has(nativeId)) ? await sourceProof(nativeId, available, marketplaces, provider, installed, sourceBudget) : null;
    const actions = noActions();
    if (owned && !ambiguous) {
      actions.uninstall = allow();
      if (provider === 'claude') { actions.enable = data.enabled === false ? allow() : deny(); actions.disable = data.enabled === true ? allow() : deny(); }
    }
    if (provider === 'claude' && kind === 'installed' && approved && complete && installed.filter(other => String(other.id).toLowerCase() === nativeId.toLowerCase()).length === 1 && owned) actions.details = allow();
    if (kind === 'available' && !installed.some(other => String(provider === 'claude' ? other.id : other.pluginId).toLowerCase() === nativeId.toLowerCase()))
      actions.install = source !== null && Object.values(installScopes).some(scope => scope.allowed) ? allow() : deny();
    const id = nativeIdentity(provider, 'plugin', kind, contextFingerprint(context, provider), nativeId, scope, data.installPath ?? data.installedPath ?? null);
    const summary: CapabilityPluginSummary = { id, kind, provider, name: display(data.name, secrets) ?? display(nativeId, secrets) ?? '[redacted]',
      pluginId: display(nativeId, secrets) ?? '[redacted]', description: display(data.description, secrets), version: display(data.version, secrets), scope,
      enabled: data.enabled === false ? false : null, composition: emptyComposition(), actions };
    targets.push({ id, kind, nativeId, scope, fingerprint: fingerprint(data), sourceFingerprint: source, actions, summary });
  }
  const sourceSecrets = pluginSecrets([...sourceBudget.files.values()]);
  for (const target of targets) {
    target.summary.name = display(target.summary.name, sourceSecrets) ?? '[redacted]';
    target.summary.pluginId = display(target.summary.pluginId, sourceSecrets) ?? '[redacted]';
    target.summary.description = display(target.summary.description, sourceSecrets);
    target.summary.version = display(target.summary.version, sourceSecrets);
  }

  return { provider, contextFingerprint: contextFingerprint(context, provider), signature: fingerprint({ listed, registered, storage, proof: proof?.signature, identity: stableBinary ? identity : null, sources: targets.map(target => [target.id, target.sourceFingerprint]) }),
    executionBinary: approved ? identity!.canonicalPath : null, binaryIdentity: approved ? identity : null,
    targets, installScopes, marketplaceNames: marketplaces.map(entry => String(entry.name)).filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)), marketplaceAdd, catalog: complete ? allow() : deny(binary ? 'unverified' : 'not-installed'), partial: sourceBudget.exhausted || !complete || !completeMarkets || targets.length !== installed.length + available.length };
}
