import path from 'node:path';
import { TextDecoder } from 'node:util';
import { CAPABILITY_PLUGIN_RESPONSE_BYTES, capabilityPluginCatalogRequest, capabilityPluginDetailsRequest,
  capabilityPluginInstallRequest, capabilityPluginUninstallRequest, capabilityPluginTargetRequest, capabilityPluginMarketplaceRequest,
  capabilityPluginCatalogResponse, capabilityPluginDetailsResponse } from '@parley/protocol';
import type { CapabilityPluginCatalogRequest, CapabilityPluginCatalogResponse, CapabilityPluginDetailsRequest, CapabilityPluginDetailsResponse,
  CapabilityPluginInstallRequest, CapabilityPluginUninstallRequest, CapabilityPluginTargetRequest, CapabilityPluginMarketplaceRequest,
  CapabilityPluginResult, CapabilityPluginSummary } from '@parley/protocol';
import { executeMcp } from './actions.js';
import type { McpExecutor, McpExecution } from './actions.js';
import type { SafeCapabilitiesService } from './snapshot.js';
import { localMarketplaceSource, isClaudeSpecialMarketplace } from './native-plugin-inventory.js';
import { object } from './redact.js';
import { createProviderScheduler, ProviderSchedulerError } from './scheduler.js';
import type { ProviderScheduler } from './scheduler.js';

const shutdown = (): CapabilityPluginResult => ({ outcome: 'cancelled', code: 'shutdown' });
const responseTooLarge = (value: unknown): boolean => Buffer.byteLength(JSON.stringify(value), 'utf8') > CAPABILITY_PLUGIN_RESPONSE_BYTES;
const jsonResult = (stdout: Buffer | undefined): Record<string, unknown> | null => {
  if (!stdout || stdout.length > 1024 * 1024) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    return object(JSON.parse(text));
  } catch { return null; }
};
/** Counts/cost only, from pinned observed headings. Description/commands/output never propagate. */
export function parseClaudePluginComposition(stdout: Buffer | undefined): CapabilityPluginSummary['composition'] | null {
  if (!stdout || stdout.length > 1024 * 1024) return null;
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    const counts: Record<string, number> = {};
    for (const match of value.matchAll(/^\s*(Skills|Agents|Hooks|MCP servers)\s+\((\d{1,7})\)(?:[ \t]|$)/gm)) {
      if (counts[match[1]!] !== undefined || Number(match[2]) > 1_000_000) return null;
      counts[match[1]!] = Number(match[2]);
    }
    if (['Skills', 'Agents', 'Hooks', 'MCP servers'].some(key => counts[key] === undefined)) return null;
    const tokens = /^\s*Always-on:\s*~(\d{1,16})\s+tok\b/m.exec(value)?.[1];
    const tokenEstimate = tokens !== undefined && Number.isSafeInteger(Number(tokens)) ? Number(tokens) : null;
    return { skills: counts.Skills!, agents: counts.Agents!, hooks: counts.Hooks!, mcp: counts['MCP servers']!, tokenEstimate };
  } catch { return null; }
}

export interface CapabilitiesPluginActions {
  available(params: CapabilityPluginCatalogRequest): Promise<CapabilityPluginCatalogResponse>;
  details(params: CapabilityPluginDetailsRequest): Promise<CapabilityPluginDetailsResponse>;
  install(params: CapabilityPluginInstallRequest): Promise<CapabilityPluginResult>;
  uninstall(params: CapabilityPluginUninstallRequest): Promise<CapabilityPluginResult>;
  enable(params: CapabilityPluginTargetRequest): Promise<CapabilityPluginResult>;
  disable(params: CapabilityPluginTargetRequest): Promise<CapabilityPluginResult>;
  addMarketplace(params: CapabilityPluginMarketplaceRequest): Promise<CapabilityPluginResult>;
  dispose(): void;
}
type Mutation = 'install' | 'uninstall' | 'enable' | 'disable' | 'addMarketplace';
type Request = CapabilityPluginInstallRequest | CapabilityPluginUninstallRequest | CapabilityPluginTargetRequest | CapabilityPluginMarketplaceRequest;
export function createCapabilitiesPluginActions(service: SafeCapabilitiesService, executor: McpExecutor = executeMcp, sharedScheduler?: ProviderScheduler): CapabilitiesPluginActions {
  const scheduler = sharedScheduler ?? createProviderScheduler(); let disposed = false;
  const catalogError = (params: CapabilityPluginCatalogRequest, reason: CapabilityPluginCatalogResponse['reason']): CapabilityPluginCatalogResponse => ({ revision: params.revision, provider: params.provider, partial: true, phase: 'unavailable', reason, entries: [] });
  const detailsError = (params: CapabilityPluginDetailsRequest, reason: CapabilityPluginDetailsResponse['reason']): CapabilityPluginDetailsResponse => ({ revision: params.revision, partial: true, entry: null, reason });
  const available = async (params: CapabilityPluginCatalogRequest): Promise<CapabilityPluginCatalogResponse> => {
    if (!capabilityPluginCatalogRequest.safeParse(params).success || !path.isAbsolute(params.projectPath)) return catalogError(params, 'unverified');
    try {
      return await scheduler.run(params.provider, async signal => {
        if (disposed || signal.aborted) return catalogError(params, 'unverified');
        const prepared = await service.preparePluginAction(params);
        if (disposed || signal.aborted) return catalogError(params, 'unverified');
        if (!prepared.ok) return catalogError(params, prepared.code === 'stale' || prepared.code === 'context-changed' ? 'stale' : 'unverified');
        const result: CapabilityPluginCatalogResponse = { revision: params.revision, provider: params.provider, partial: prepared.inventory.partial,
          phase: prepared.inventory.catalog.allowed ? 'ready' : 'unavailable', reason: prepared.inventory.catalog.allowed ? null : prepared.inventory.catalog.reason,
          entries: prepared.inventory.targets.map(target => structuredClone(target.summary)) };
        if (responseTooLarge(result)) return catalogError(params, 'output-limit');
        const safe = capabilityPluginCatalogResponse.safeParse(result);
        return safe.success ? safe.data : catalogError(params, 'invalid-output');
      });
    } catch { return catalogError(params, 'unverified'); }
  };
  const details = async (params: CapabilityPluginDetailsRequest): Promise<CapabilityPluginDetailsResponse> => {
    if (!capabilityPluginDetailsRequest.safeParse(params).success || !path.isAbsolute(params.projectPath)) return detailsError(params, 'unverified');
    try {
      return await scheduler.run(params.provider, async signal => {
        if (disposed || signal.aborted) return detailsError(params, 'unverified');
        const prepared = await service.preparePluginAction(params);
        if (disposed || signal.aborted) return detailsError(params, 'unverified');
        if (!prepared.ok || !prepared.target) return detailsError(params, prepared.ok || prepared.code !== 'stale' ? 'unverified' : 'stale');
        const target = prepared.target; const entry = structuredClone(target.summary);
        let reason: CapabilityPluginDetailsResponse['reason'] = null;
        if (target.actions.details.allowed && params.provider === 'claude' && prepared.isCurrent() && prepared.inventory.executionBinary) {
          const output = await executor(prepared.inventory.executionBinary, ['plugin', 'details', target.nativeId], prepared.context, signal);
          if (disposed || signal.aborted || !prepared.isCurrent()) return detailsError(params, 'stale');
          const composition = output.code === 'ok' ? parseClaudePluginComposition(output.stdout) : null;
          if (composition) entry.composition = composition;
          else reason = 'invalid-output';
        } else reason = target.actions.details.allowed ? 'unverified' : target.actions.details.reason;
        const result: CapabilityPluginDetailsResponse = { revision: params.revision, partial: reason !== null, entry, reason };
        if (responseTooLarge(result)) return detailsError(params, 'output-limit');
        const safe = capabilityPluginDetailsResponse.safeParse(result);
        return safe.success ? safe.data : detailsError(params, 'invalid-output');
      });
    } catch { return detailsError(params, 'unverified'); }
  };
  const mutate = async (kind: Mutation, params: Request): Promise<CapabilityPluginResult> => {
    const schema = kind === 'install' ? capabilityPluginInstallRequest : kind === 'uninstall' ? capabilityPluginUninstallRequest
      : kind === 'addMarketplace' ? capabilityPluginMarketplaceRequest : capabilityPluginTargetRequest;
    if (!schema.safeParse(params).success || !path.isAbsolute(params.projectPath)) return { outcome: 'denied', code: 'invalid-input' };
    if (disposed) return shutdown();
    try {
      return await scheduler.run(params.provider, async signal => {
        if (disposed || signal.aborted) return shutdown();
        const prepared = await service.preparePluginAction(params);
        if (disposed || signal.aborted) return shutdown();
        if (!prepared.ok) return { outcome: 'denied', code: prepared.code };
        const target = prepared.target;
        const scope = 'scope' in params ? params.scope : target?.scope;
        const support = kind === 'addMarketplace' ? prepared.inventory.marketplaceAdd[(params as CapabilityPluginMarketplaceRequest).scope] : target?.actions[kind];
        if (!support?.allowed) return { outcome: 'unavailable', code: support?.reason ?? 'unverified' };
        const binary = prepared.inventory.executionBinary;
        if (!binary || !scope) return { outcome: 'unavailable', code: 'unverified' };
        if (kind === 'install' && !prepared.inventory.installScopes[scope].allowed) return { outcome: 'unavailable', code: prepared.inventory.installScopes[scope].reason ?? 'unverified' };
        if (params.provider === 'codex' && (scope !== 'user' || kind === 'enable' || kind === 'disable')) return { outcome: 'unavailable', code: 'native-only' };
        let source: Awaited<ReturnType<typeof localMarketplaceSource>> = null;
        if (kind === 'addMarketplace') {
          source = await localMarketplaceSource((params as CapabilityPluginMarketplaceRequest).source.path, params.provider === 'claude');
          if (disposed || signal.aborted) return shutdown();
          if (!source || params.provider === 'claude' && isClaudeSpecialMarketplace(source.name)) return { outcome: 'unavailable', code: 'unverified' };
          if (prepared.inventory.marketplaceNames.some(name => name.toLowerCase() === source!.name.toLowerCase())) return { outcome: 'denied', code: 'conflict' };
          // The same metadata is checked twice around all asynchronous preparation; no path is guessed from display text.
          const current = await localMarketplaceSource(source.path, params.provider === 'claude');
          if (!current || current.fingerprint !== source.fingerprint) return { outcome: 'denied', code: 'context-changed' };
        }
        if (!prepared.isCurrent()) return { outcome: 'denied', code: 'stale' };
        const selector = source?.path ?? target!.nativeId;
        const command = kind === 'addMarketplace' ? ['plugin', 'marketplace', 'add', selector]
          : ['plugin', params.provider === 'codex' ? kind === 'install' ? 'add' : 'remove' : kind, selector];
        const args = [...command, ...(params.provider === 'claude' ? ['--scope', scope] : []), '--json'];
        let output: McpExecution;
        try { output = await executor(binary, args, prepared.context, signal); }
        catch { output = { code: signal.aborted ? 'shutdown' : 'cli-error' }; }
        if (disposed || signal.aborted) return shutdown();
        let result: CapabilityPluginResult;
        if (output.code !== 'ok') result = { outcome: 'failed', code: output.code, ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }) };
        else {
          const json = jsonResult(output.stdout);
          const expectedCommand = kind === 'addMarketplace' ? 'marketplace-add' : kind;
          const claudeOk = json?.command === expectedCommand && json.outcome === 'ok' && (kind === 'addMarketplace' ? json.marketplace === source!.name : json.pluginId === target!.nativeId && json.scope === scope);
          const codexOk = json?.success !== false && json?.error === undefined && json?.failureCode === undefined && (json?.outcome === undefined || json.outcome === 'ok') && (kind === 'addMarketplace' ? json?.marketplaceName === source!.name && typeof json.installedRoot === 'string' && typeof json.alreadyAdded === 'boolean'
            : json?.pluginId === target!.nativeId && (kind !== 'install' || json.authPolicy === 'ON_INSTALL'));
          result = (params.provider === 'claude' ? claudeOk : codexOk) ? { outcome: 'ok', code: 'ok' }
            : { outcome: 'failed', code: json?.outcome === 'failed' ? 'cli-error' : 'invalid-output' };
        }
        service.refresh(params.projectPath);
        return result;
      });
    } catch (error) { return error instanceof ProviderSchedulerError && error.code === 'shutdown' ? shutdown() : { outcome: 'failed', code: 'cli-error' }; }
  };
  return { available, details, install: params => mutate('install', params), uninstall: params => mutate('uninstall', params),
    enable: params => mutate('enable', params), disable: params => mutate('disable', params), addMarketplace: params => mutate('addMarketplace', params),
    dispose() { disposed = true; if (!sharedScheduler) scheduler.dispose(); } };
}
