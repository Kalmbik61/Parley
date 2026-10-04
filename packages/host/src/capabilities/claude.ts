import { readNativePluginInventory } from './native-plugin-inventory.js';
import path from 'node:path';
import { allow, contextFingerprint, deniedAdd, deny, fingerprint, validMcpName, verifiedClaudeActionBinary, claudeDestinationsBound, claudeStorageIdentity } from './native-targets.js';
import type { NativeMcpTarget } from './native-targets.js';
import { realpath } from 'node:fs/promises';
import { resolveSkillCatalog } from '@parley/core';
import type { CapabilityDiagnostic, CapabilityPresence, CapabilityScope } from '@parley/protocol';
import { mcpSummary, nativeIdentity, rowIdentity, object, projectSkills, skillSharingCatalogKnown, readJsonFile, readNativeJson, safeText, secretValues } from './redact.js';
import type { SnapshotEntry } from './redact.js';
import type { ProviderSnapshotResult, SnapshotContext, SnapshotReaderOptions } from './snapshot.js';

export async function readClaudeSnapshot(context: SnapshotContext, options: SnapshotReaderOptions = {}): Promise<ProviderSnapshotResult> {
  const diagnostics: CapabilityDiagnostic[] = [];
  const entries: SnapshotEntry[] = []; const targets: NativeMcpTarget[] = []; const names: string[] = [];
  const native = options.readNative ?? readNativeJson;
  const config = context.claude ?? {};
  const actionBinary = await verifiedClaudeActionBinary(context, options.readBinaryIdentity);
  const boundDestinations = claudeDestinationsBound(context);
  const configDir = path.resolve(context.projectPath, config.configDir ?? path.join(context.homeDir, '.claude'));
  const userFile = config.userConfigFile ?? (config.configDir ? path.join(configDir, '.claude.json') : path.join(context.homeDir, '.claude.json'));
  const projectFile = path.join(context.projectPath, '.mcp.json');
  const storage = await claudeStorageIdentity(userFile, projectFile);
  const [catalog, user, project, plugins] = await Promise.all([
    resolveSkillCatalog({ provider: 'claude', cwd: context.projectPath, homeDir: context.homeDir,
      ...(config.configDir ? { configDir: config.configDir } : {}), ...(config.settings ? { settings: config.settings } : {}),
      ...(config.nativeEvidence ? { nativeEvidence: config.nativeEvidence } : {}),
      limits: { ...config.limits, maxEntries: Math.min(config.limits?.maxEntries ?? 2000, 2000) } }),
    readJsonFile(userFile),
    readJsonFile(projectFile),
    native(context.binaries.claude, ['plugin', 'list', '--json'], context).catch(() => ({ status: 'invalid' as const, code: 'invalid-output' as const })),
  ]);
  entries.push(...projectSkills(catalog));
  if (catalog.partial) diagnostics.push({ code: 'resolver-partial', source: 'skills', count: catalog.diagnostics.length });
  for (const read of [user, project]) if (read.status === 'invalid') diagnostics.push({ code: read.code, source: 'mcp' });
  const userData = user.status === 'valid' ? object(user.data) : null;
  const projectData = project.status === 'valid' ? object(project.data) : null;
  if (user.status === 'valid' && !userData || project.status === 'valid' && !projectData) diagnostics.push({ code: 'invalid-config', source: 'mcp' });
  let main: string | null = null;
  if (config.mainCheckout && path.isAbsolute(config.mainCheckout)) try { main = await realpath(config.mainCheckout); } catch { /* no guessed storage key */ }
  if (config.mcpPolicy?.verified !== true) diagnostics.push({ code: 'context-unverified', source: 'mcp' });
  if (main === null) diagnostics.push({ code: 'identity-unverified', source: 'mcp' });
  let winningTargets = config.mcpWinningTargets?.targets;
  try { if (!winningTargets || winningTargets.length > 2000 || await realpath(config.mcpWinningTargets!.cwd) !== await realpath(context.projectPath)) winningTargets = undefined; }
  catch { winningTargets = undefined; }
  const localRecord = main ? object(object(userData?.projects)?.[main]) : null;
  const secrets = [...secretValues(userData), ...secretValues(projectData), ...(plugins.status === 'valid' ? secretValues(plugins.data) : [])];
  const projects = object(userData?.projects);
  let completeMcpNames = !(userData && Object.hasOwn(userData, 'projects') && !projects) &&
    !(main && projects && Object.hasOwn(projects, main) && !localRecord);
  if (!completeMcpNames) diagnostics.push({ code: 'invalid-config', source: 'mcp' });
  const addMcp = (value: unknown, scope: CapabilityScope): void => {
    const servers = object(value); if (value !== undefined && !servers) { completeMcpNames = false; diagnostics.push({ code: 'invalid-config', source: 'mcp' }); return; }
    if (servers && Object.keys(servers).length > 2000) { completeMcpNames = false; diagnostics.push({ code: 'output-limit', source: 'mcp' }); }
    for (const [rawName, raw] of Object.entries(servers ?? {}).slice(0, 2000)) {
      const data = object(raw); const name = safeText(rawName, secrets); names.push(rawName);
      if (!data || !name) { completeMcpNames = false; diagnostics.push({ code: 'invalid-config', source: 'mcp' }); continue; }
      const disabled = data.disabled === true || config.mcpPolicy?.disabled?.includes(rawName) === true ||
        scope === 'project' && Array.isArray(localRecord?.disabledMcpjsonServers) && localRecord.disabledMcpjsonServers.includes(rawName);
      const verified = config.mcpPolicy?.verified === true;
      const enabled = disabled ? false : verified && config.mcpPolicy?.enabled?.includes(rawName) ? true : null;
      const approved = scope !== 'project' || config.mcpPolicy?.approved?.includes(rawName) === true ||
        Array.isArray(localRecord?.enabledMcpjsonServers) && localRecord.enabledMcpjsonServers.includes(rawName);
      const presence: CapabilityPresence = { id: nativeIdentity('claude', 'mcp', scope, scope === 'project' ? context.projectPath : main, rawName), scope, source: null,
        documentPath: null, description: null, installed: true, enabled,
        status: disabled ? 'off' : verified && !approved ? 'pending-approval' : 'unknown',
        summary: safeText(mcpSummary(data), secrets), modelAvailable: null, unavailableReason: null };
      entries.push({ kind: 'mcp', name, rowId: rowIdentity('mcp', rawName), presence });
      if (actionBinary && boundDestinations && storage !== null && main !== null && user.status !== 'invalid' && project.status !== 'invalid' && (user.status === 'missing' || userData !== null) && (project.status === 'missing' || projectData !== null) && validMcpName(rawName))
        targets.push({ id: presence.id, provider: 'claude', name: rawName, scope: scope as 'user' | 'project' | 'local',
          fingerprint: fingerprint(raw), remove: allow(), check: verified && enabled === true && approved && winningTargets?.filter(target => target.name === rawName).length === 1 && winningTargets.some(target => target.name === rawName && target.scope === scope && target.configFingerprint === fingerprint(raw)) ? allow() : deny('unverified') });
    }
  };
  addMcp(userData?.mcpServers, 'user'); addMcp(localRecord?.mcpServers, 'local'); addMcp(projectData?.mcpServers, 'project');
  if (plugins.status === 'invalid') diagnostics.push({ code: plugins.code, source: 'plugins' });
  else if (plugins.status === 'valid') {
    if (!Array.isArray(plugins.data)) diagnostics.push({ code: 'invalid-output', source: 'plugins' });
    else {
      if (plugins.data.length > 2000) diagnostics.push({ code: 'output-limit', source: 'plugins' });
      for (const raw of plugins.data.slice(0, 2000)) {
      const data = object(raw); const name = safeText(data?.id, secrets);
      if (!data || !name) { diagnostics.push({ code: 'invalid-output', source: 'plugins' }); continue; }
      const scope = data.scope === 'user' || data.scope === 'project' || data.scope === 'local' ? data.scope : null;
      if ((scope === 'project' || scope === 'local') && typeof data.projectPath === 'string') {
        try { if (await realpath(data.projectPath) !== await realpath(context.projectPath)) continue; }
        catch { diagnostics.push({ code: 'context-unverified', source: 'plugins' }); continue; }
      }
      const evidence = config.nativeEvidence;
      let verified = false;
      try { verified = evidence?.policyVerified === true && await realpath(evidence.cwd) === await realpath(context.projectPath) &&
        evidence.plugins?.some(plugin => plugin.id === data.id && plugin.verified && plugin.enabled === true) === true; } catch { /* unknown evidence */ }
      const enabled = data.enabled === false ? false : data.enabled === true && verified ? true : null;
      if ((enabled === null || scope === null) && !diagnostics.some(item => item.code === 'context-unverified' && item.source === 'plugins'))
        diagnostics.push({ code: 'context-unverified', source: 'plugins' });
      entries.push({ kind: 'plugin', name, rowId: rowIdentity('plugin', String(data.id), 'claude'), presence: { id: nativeIdentity('claude', 'plugin', scope, data.id),
        scope, source: name, documentPath: null, description: safeText(data.description, secrets), installed: true,
        enabled, status: enabled === false ? 'off' : 'unknown', summary: null, modelAvailable: null, unavailableReason: null } });
    }
  }
    }
  // Cross-field repeats of observed secrets are filtered even in otherwise allowed metadata.
  for (const entry of entries) {
    entry.name = safeText(entry.name, secrets) ?? '[redacted]';
    entry.presence.description = safeText(entry.presence.description, secrets);
  }
  for (const target of targets) {
    if (!completeMcpNames) target.check = deny('unverified');
    else if (names.filter(name => name === target.name).length !== 1) target.check = deny('ambiguous');
  }
  const verified = completeMcpNames && actionBinary && boundDestinations && storage !== null && main !== null && user.status !== 'invalid' && project.status !== 'invalid' && (user.status === 'missing' || userData !== null) && (project.status === 'missing' || projectData !== null);
  const pluginsNative = await (options.readPluginInventory ?? readNativePluginInventory)(context, 'claude', { ...options, pluginRedactionSecrets: secrets });
  if (pluginsNative.partial && !diagnostics.some(item => item.source === 'plugins' && item.code === 'context-unverified')) diagnostics.push({ code: 'context-unverified', source: 'plugins' });
  if (pluginsNative.catalog.allowed) {
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.kind === 'plugin') entries.splice(index, 1);
    for (const target of pluginsNative.targets.filter(target => target.kind === 'installed')) {
      const summary = target.summary;
      entries.push({ kind: 'plugin', name: summary.pluginId, rowId: rowIdentity('plugin', target.nativeId, 'claude'), presence: {
        id: target.id, scope: target.scope, source: summary.pluginId, documentPath: null, description: summary.description,
        installed: true, enabled: summary.enabled, status: summary.enabled === false ? 'off' : 'unknown', summary: null,
        modelAvailable: null, unavailableReason: null,
      } });
    }
  }
  return { entries, diagnostics, pluginsNative, skillSharingContext: skillSharingCatalogKnown(catalog), phase: diagnostics.length ? 'partial' : 'ready', native: {
    contextFingerprint: contextFingerprint(context, 'claude'), signature: fingerprint({ user, project, main, policy: config.mcpPolicy, winners: config.mcpWinningTargets, actionBinary, storage }),
    names, targets, ...(actionBinary ? { executionBinary: actionBinary.canonicalPath } : {}), add: verified ? { user: allow(), project: allow(), local: allow() } : deniedAdd(context.binaries.claude ? 'unverified' : 'not-installed'),
  } };
}
