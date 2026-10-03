import { resolveSkillCatalog } from '@parley/core';
import type { CapabilityDiagnostic } from '@parley/protocol';
import { mcpSummary, nativeIdentity, rowIdentity, object, projectSkills, readNativeJson, safeText, secretValues } from './redact.js';
import type { SnapshotEntry } from './redact.js';
import type { ProviderSnapshotResult, SnapshotContext, SnapshotReaderOptions } from './snapshot.js';

export async function readCodexSnapshot(context: SnapshotContext, options: SnapshotReaderOptions = {}): Promise<ProviderSnapshotResult> {
  const diagnostics: CapabilityDiagnostic[] = [];
  const native = options.readNative ?? readNativeJson;
  const read = (args: readonly string[]) => native(context.binaries.codex, args, context)
    .catch(() => ({ status: 'invalid' as const, code: 'invalid-output' as const }));
  const [catalog, mcp, plugins] = await Promise.all([
    resolveSkillCatalog({ provider: 'codex', cwd: context.projectPath, homeDir: context.homeDir, ...context.codex,
      limits: { ...context.codex?.limits, maxEntries: Math.min(context.codex?.limits?.maxEntries ?? 2000, 2000) } }),
    read(['mcp', 'list', '--json']), read(['plugin', 'list', '--json']),
  ]);
  const entries: SnapshotEntry[] = projectSkills(catalog);
  if (catalog.partial) diagnostics.push({ code: 'resolver-partial', source: 'skills', count: catalog.diagnostics.length });
  const secrets = [...(mcp.status === 'valid' ? secretValues(mcp.data) : []), ...(plugins.status === 'valid' ? secretValues(plugins.data) : [])];
  if (mcp.status === 'invalid') diagnostics.push({ code: mcp.code, source: 'mcp' });
  else if (mcp.status === 'valid') {
    if (!Array.isArray(mcp.data)) diagnostics.push({ code: 'invalid-output', source: 'mcp' });
    else {
      if (mcp.data.length > 2000) diagnostics.push({ code: 'output-limit', source: 'mcp' });
      for (const raw of mcp.data.slice(0, 2000)) {
      const data = object(raw); const name = safeText(data?.name, secrets);
      if (!data || !name) { diagnostics.push({ code: 'invalid-output', source: 'mcp' }); continue; }
      const enabled = typeof data.enabled === 'boolean' ? data.enabled : null;
      if (!diagnostics.some(item => item.code === 'context-unverified' && item.source === 'mcp')) diagnostics.push({ code: 'context-unverified', source: 'mcp' });
      entries.push({ kind: 'mcp', name, rowId: rowIdentity('mcp', String(data.name)), presence: { id: nativeIdentity('codex', 'mcp', context.projectPath, data.name), scope: null,
        source: null, documentPath: null, description: null, installed: true, enabled,
        status: enabled === false ? 'off' : 'unknown',
        summary: safeText(mcpSummary(data.transport), secrets), modelAvailable: null, unavailableReason: null } });
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
  return { entries, diagnostics, phase: diagnostics.length ? 'partial' : 'ready' };
}
