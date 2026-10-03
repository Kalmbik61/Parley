import { METHODS } from './methods.js';
import { describe, it, expect } from 'vitest';
import { capabilityPluginCatalogRequest, capabilityPluginDetailsRequest, capabilityPluginInstallRequest,
  capabilityPluginUninstallRequest, capabilityPluginMarketplaceRequest, capabilityPluginComposition,
  capabilityPluginResult, capabilityPluginCatalogResponse, capabilityPluginDetailsResponse } from './capability-plugin-actions.js';
const base = { projectPath: '/fixture', provider: 'claude', revision: 1 };
describe('safe draft plugin boundary', () => {
  it('uses opaque installed or catalog targets, with no raw native selector', () => {
    expect(capabilityPluginDetailsRequest.safeParse({ ...base, target: { kind: 'available', catalogId: 'opaque' } }).success).toBe(true);
    expect(capabilityPluginDetailsRequest.safeParse({ ...base, target: { kind: 'installed', presenceId: 'opaque' } }).success).toBe(true);
    expect(capabilityPluginDetailsRequest.safeParse({ ...base, pluginId: 'native@marketplace' }).success).toBe(false);
  });
  it.each(['project', 'local'])('refuses Codex %s writes', scope => {
    expect(capabilityPluginInstallRequest.safeParse({ ...base, provider: 'codex', catalogId: 'opaque', scope }).success).toBe(false);
    expect(capabilityPluginMarketplaceRequest.safeParse({ ...base, provider: 'codex', scope, source: { kind: 'local', path: '/fixture/market' } }).success).toBe(false);
  });
  it('requires explicit persistent data loss confirmation', () => {
    expect(capabilityPluginUninstallRequest.safeParse({ ...base, presenceId: 'opaque' }).success).toBe(false);
    expect(capabilityPluginUninstallRequest.safeParse({ ...base, presenceId: 'opaque', confirmDataLoss: false }).success).toBe(false);
    expect(capabilityPluginUninstallRequest.safeParse({ ...base, presenceId: 'opaque', confirmDataLoss: true }).success).toBe(true);
  });
  it('does not admit remote source commands or confirmation-bypass flags', () => {
    for (const source of [{ kind: 'command', command: 'fixture' }, { kind: 'git', url: 'https://fixture' },
      { kind: 'local', path: '/fixture', headersHelper: 'fixture' }])
      expect(capabilityPluginMarketplaceRequest.safeParse({ ...base, scope: 'user', source }).success).toBe(false);
    expect(capabilityPluginInstallRequest.safeParse({ ...base, catalogId: 'opaque', scope: 'user', yes: true }).success).toBe(false);
  });
  it('preserves unknown composition and rejects invented negative statistics', () => {
    const unknown = { skills: null, agents: null, mcp: null, hooks: null, tokenEstimate: null };
    expect(capabilityPluginComposition.parse(unknown)).toEqual(unknown);
    expect(capabilityPluginComposition.safeParse({ ...unknown, skills: -1 }).success).toBe(false);
  });
  it.each(['stdout', 'stderr', 'argv', 'config', 'error'])('rejects %s on response boundaries even on success', key => {
    expect(capabilityPluginResult.safeParse({ outcome: 'ok', code: 'ok', [key]: 'SECRET_FIXTURE' }).success).toBe(false);
    expect(capabilityPluginCatalogResponse.safeParse({ revision: 1, provider: 'claude', partial: true,
      phase: 'ready', reason: null, entries: [], [key]: 'SECRET_FIXTURE' }).success).toBe(false);
  });
  it('rejects unknown request fields and stale-invalid revision shapes', () => {
    expect(capabilityPluginCatalogRequest.safeParse({ ...base, config: {} }).success).toBe(false);
    expect(capabilityPluginCatalogRequest.safeParse({ ...base, revision: -1 }).success).toBe(false);
  });
});

it('registers seven strict opaque plugin methods without changing legacy capability methods', () => {
  const available = METHODS['capabilities.plugins.available'].safeParse(base);
  expect(available.success).toBe(true);
  expect(METHODS['capabilities.plugins.enable'].safeParse({ ...base, presenceId: 'opaque', pluginId: 'native@market' }).success).toBe(false);
  expect(METHODS['capabilities.plugins.uninstall'].safeParse({ ...base, presenceId: 'opaque' }).success).toBe(false);
  expect(METHODS['capabilities.list'].safeParse({ projectPath: '/fixture', provider: 'claude' }).success).toBe(true);
});

it('bounds the complete multibyte catalog before framing and rejects malformed UTF-8 metadata', () => {
  const no = { allowed: false, reason: 'unverified' };
  const entry = { id: 'opaque', kind: 'available', provider: 'claude', name: 'fixture', pluginId: 'fixture@market',
    description: '日本語'.repeat(2730), version: null, scope: null, enabled: null,
    composition: { skills: null, agents: null, mcp: null, hooks: null, tokenEstimate: null },
    actions: { install: no, uninstall: no, enable: no, disable: no, details: no } };
  const response = { revision: 1, provider: 'claude', partial: false, phase: 'ready', reason: null, entries: [entry] };
  expect(capabilityPluginCatalogResponse.safeParse(response).success).toBe(true);
  expect(capabilityPluginCatalogResponse.safeParse({ ...response, entries: Array.from({ length: 200 }, () => entry) }).success).toBe(false);
  expect(capabilityPluginCatalogResponse.safeParse({ ...response, entries: [{ ...entry, description: '\ud800' }] }).success).toBe(false);
});

const yesAction = { allowed: true, reason: null }; const noAction = { allowed: false, reason: 'unverified' };
const summary = { id: 'opaque', kind: 'installed', provider: 'claude', name: 'fixture', pluginId: 'fixture@market', description: null, version: null, scope: 'user', enabled: null,
  composition: { skills: null, agents: null, mcp: null, hooks: null, tokenEstimate: null },
  actions: { install: noAction, uninstall: noAction, enable: noAction, disable: noAction, details: noAction } };
const responsesAccept = (entry: Record<string, unknown> & { provider: string }, provider = entry.provider) => ({
  catalog: capabilityPluginCatalogResponse.safeParse({ revision: 1, provider, partial: false, phase: 'ready', reason: null, entries: [entry] }).success,
  details: capabilityPluginDetailsResponse.safeParse({ revision: 1, partial: false, reason: null, entry }).success,
});
it.each(['enable', 'disable', 'details'])('rejects unsupported Codex %s in both response routes', action => {
  expect(responsesAccept({ ...summary, provider: 'codex', actions: { ...summary.actions, [action]: yesAction } })).toEqual({ catalog: false, details: false });
});
it.each(['admin', 'system', 'builtin', 'extra', 'plugin', 'claude.ai', 'synced', null])('rejects positive human mutation/details claims for %s scope in both response routes', scope => {
  for (const action of ['uninstall', 'enable', 'disable', 'details'])
    expect(responsesAccept({ ...summary, scope, actions: { ...summary.actions, [action]: yesAction } })).toEqual({ catalog: false, details: false });
});
it.each(['project', 'local'])('rejects Codex %s uninstall while preserving native-supported user removal', scope => {
  expect(responsesAccept({ ...summary, provider: 'codex', scope, actions: { ...summary.actions, uninstall: yesAction } })).toEqual({ catalog: false, details: false });
  expect(responsesAccept({ ...summary, provider: 'codex', actions: { ...summary.actions, uninstall: yesAction } })).toEqual({ catalog: true, details: true });
});
it('preserves available unknown-scope install but forbids installed/available action-kind confusion', () => {
  expect(responsesAccept({ ...summary, kind: 'available', scope: null, actions: { ...summary.actions, install: yesAction } })).toEqual({ catalog: true, details: true });
  expect(responsesAccept({ ...summary, actions: { ...summary.actions, install: yesAction } })).toEqual({ catalog: false, details: false });
  expect(responsesAccept({ ...summary, kind: 'available', actions: { ...summary.actions, uninstall: yesAction } })).toEqual({ catalog: false, details: false });
});
it('rejects cross-provider entries in a catalog without changing details ownership', () => {
  expect(responsesAccept({ ...summary, provider: 'codex' }, 'claude')).toEqual({ catalog: false, details: true });
});
