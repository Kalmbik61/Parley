import { readNativePluginInventory } from './native-plugin-inventory.js';
import { allow, codexUserMcpProof, contextFingerprint, deniedAdd, deny, fingerprint, validMcpName, readBinaryIdentity, sameBinaryIdentity } from './native-targets.js';
import type { NativeMcpTarget } from './native-targets.js';
import { readCodexNativeContext, resolveSkillCatalog } from '@parley/core';
import type { CapabilityDiagnostic } from '@parley/protocol';
import { mcpSummary, nativeIdentity, rowIdentity, object, projectSkills, skillSharingCatalogKnown, readNativeJson, safeText, secretValues } from './redact.js';
import type { SnapshotEntry } from './redact.js';
import type { ProviderSnapshotResult, SnapshotContext, SnapshotReaderOptions } from './snapshot.js';

export async function readCodexSnapshot(context: SnapshotContext, options: SnapshotReaderOptions = {}): Promise<ProviderSnapshotResult> {
  const diagnostics: CapabilityDiagnostic[] = [];
  const native = options.readNative ?? readNativeJson;
  const identify = options.readBinaryIdentity ?? readBinaryIdentity;
  const identity = await identify(context.binaries.codex, context);
  const executionBinary = identity?.canonicalPath ?? context.binaries.codex;
  const read = (args: readonly string[]) => native(executionBinary, args, context)
    .catch(() => ({ status: 'invalid' as const, code: 'invalid-output' as const }));
  const [catalog, mcp, plugins, nativeContext] = await Promise.all([
    resolveSkillCatalog({ provider: 'codex', cwd: context.projectPath, homeDir: context.homeDir, ...context.codex,
      limits: { ...context.codex?.limits, maxEntries: Math.min(context.codex?.limits?.maxEntries ?? 2000, 2000) } }),
    read(['mcp', 'list', '--json']), read(['plugin', 'list', '--json']),
    context.binaries.codex ? (options.readCodexContext ?? readCodexNativeContext)({ cwd: context.projectPath, command: executionBinary!, ...(context.env ? { env: context.env } : {}) }).catch(() => null) : null,
  ]);
  const entries: SnapshotEntry[] = projectSkills(catalog); const targets: NativeMcpTarget[] = []; const names: string[] = [];
  // Bind the active-layer proof to the same canonical executable bytes; this is not publisher approval.
  const stableBinary = identity !== null && sameBinaryIdentity(identity, await identify(identity.canonicalPath, context));
  const proof = stableBinary ? await codexUserMcpProof(context, nativeContext) : null;
  if (catalog.partial) diagnostics.push({ code: 'resolver-partial', source: 'skills', count: catalog.diagnostics.length });
  const secrets = [...(mcp.status === 'valid' ? secretValues(mcp.data) : []), ...(plugins.status === 'valid' ? secretValues(plugins.data) : [])];
  if (mcp.status === 'invalid') diagnostics.push({ code: mcp.code, source: 'mcp' });
  else if (mcp.status === 'valid') {
    if (!Array.isArray(mcp.data)) diagnostics.push({ code: 'invalid-output', source: 'mcp' });
    else {
      if (mcp.data.length > 2000) diagnostics.push({ code: 'output-limit', source: 'mcp' });
      for (const raw of mcp.data.slice(0, 2000)) {
      const data = object(raw); const name = safeText(data?.name, secrets);
      if (typeof data?.name === 'string') names.push(data.name);
      if (!data || !name) { diagnostics.push({ code: 'invalid-output', source: 'mcp' }); continue; }
      const enabled = typeof data.enabled === 'boolean' ? data.enabled : null;
      if (!proof?.names.has(String(data.name)) && !diagnostics.some(item => item.code === 'context-unverified' && item.source === 'mcp')) diagnostics.push({ code: 'context-unverified', source: 'mcp' });
      entries.push({ kind: 'mcp', name, rowId: rowIdentity('mcp', String(data.name)), presence: { id: nativeIdentity('codex', 'mcp', context.projectPath, data.name), scope: proof?.names.has(String(data.name)) ? 'user' : null,
        source: null, documentPath: null, description: null, installed: true, enabled,
        status: enabled === false ? 'off' : 'unknown',
        summary: safeText(mcpSummary(data.transport), secrets), modelAvailable: null, unavailableReason: null } });
      if (proof?.names.has(String(data.name)) && validMcpName(String(data.name))) targets.push({
        id: nativeIdentity('codex', 'mcp', context.projectPath, data.name), provider: 'codex', name: String(data.name), scope: 'user',
        fingerprint: fingerprint(raw), remove: allow(), check: deny('native-only'),
      });
    }
  }
    }
  if (plugins.status === 'invalid') diagnostics.push({ code: plugins.code, source: 'plugins' });
  else if (plugins.status === 'valid') {
    const list = object(plugins.data)?.installed;
    if (!Array.isArray(list)) diagnostics.push({ code: 'invalid-output', source: 'plugins' });
    else {
      if (list.length > 2000) diagnostics.push({ code: 'output-limit', source: 'plugins' });
      for (const raw of list.slice(0, 2000)) {
      const data = object(raw); const name = safeText(data?.pluginId, secrets);
      if (!data || !name) { diagnostics.push({ code: 'invalid-output', source: 'plugins' }); continue; }
      if (data.installed === false) continue;
      // Listing exposes configured enabled, but positive effective plugin policy is not proven by P03.
      const enabled = data.enabled === false ? false : null;
      if (!diagnostics.some(item => item.code === 'context-unverified' && item.source === 'plugins'))
        diagnostics.push({ code: 'context-unverified', source: 'plugins' });
      entries.push({ kind: 'plugin', name, rowId: rowIdentity('plugin', String(data.pluginId), 'codex'), presence: { id: nativeIdentity('codex', 'plugin', data.pluginId), scope: null,
        source: safeText(data.marketplaceName, secrets), documentPath: null, description: safeText(data.description, secrets),
        installed: true, enabled, status: enabled === false ? 'off' : 'unknown', summary: null, modelAvailable: null, unavailableReason: null } });
    }
  }
    }
  for (const entry of entries) {
    entry.name = safeText(entry.name, secrets) ?? '[redacted]';
    entry.presence.description = safeText(entry.presence.description, secrets);
  }
  const validList = mcp.status === 'valid' && Array.isArray(mcp.data) && names.length === mcp.data.length;
  if (!validList || new Set(names).size !== names.length) targets.splice(0);
  const pluginsNative = await (options.readPluginInventory ?? readNativePluginInventory)(context, 'codex', { ...options, pluginRedactionSecrets: secrets, codexPluginContext: { context: nativeContext, binaryIdentity: stableBinary ? identity : null } });
  if (pluginsNative.partial && !diagnostics.some(item => item.source === 'plugins' && item.code === 'context-unverified')) diagnostics.push({ code: 'context-unverified', source: 'plugins' });
  if (pluginsNative.catalog.allowed) {
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.kind === 'plugin') entries.splice(index, 1);
    for (const target of pluginsNative.targets.filter(target => target.kind === 'installed')) {
      const summary = target.summary;
      entries.push({ kind: 'plugin', name: summary.pluginId, rowId: rowIdentity('plugin', target.nativeId, 'codex'), presence: {
        id: target.id, scope: target.scope, source: summary.pluginId, documentPath: null, description: summary.description,
        installed: true, enabled: summary.enabled, status: summary.enabled === false ? 'off' : 'unknown', summary: null,
        modelAvailable: null, unavailableReason: null,
      } });
    }
  }
  return { entries, diagnostics, pluginsNative, skillSharingContext: skillSharingCatalogKnown(catalog), phase: diagnostics.length ? 'partial' : 'ready', native: {
    contextFingerprint: contextFingerprint(context, 'codex'), signature: fingerprint({ mcp, proof: proof?.signature, binaryIdentity: stableBinary ? identity : null }), names, targets,
    ...(stableBinary && identity ? { executionBinary: identity.canonicalPath, binaryIdentity: identity } : {}),
    add: proof?.add && validList && new Set(names).size === names.length ? { user: allow(), project: deny('unsupported-scope'), local: deny('unsupported-scope') } : deniedAdd(context.binaries.codex ? 'unverified' : 'not-installed'),
  } };
}
