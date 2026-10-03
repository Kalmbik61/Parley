import { z } from 'zod';
import { capabilityProvider, capabilityScope, capabilityActionAvailability, capabilityActionReason } from './capability-snapshot.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(8192).refine(value => !value.includes('\0') && new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value);
export const CAPABILITY_PLUGIN_RESPONSE_BYTES = 4 * 1024 * 1024;
const responseReason = z.enum([...capabilityActionReason.options, 'output-limit', 'invalid-output']);
const responseWithinBudget = (value: unknown): boolean => new TextEncoder().encode(JSON.stringify(value)).byteLength <= CAPABILITY_PLUGIN_RESPONSE_BYTES;
const id = text.min(1).max(4096);
const base = { projectPath: text.min(1), provider: capabilityProvider, revision };
export const capabilityPluginCatalogRequest = z.object(base).strict();
const selector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installed'), presenceId: id }).strict(),
  z.object({ kind: z.literal('available'), catalogId: id }).strict(),
]);
export const capabilityPluginDetailsRequest = z.object({ ...base, target: selector }).strict();
const scope = z.enum(['user', 'project', 'local']);
export const capabilityPluginInstallRequest = z.object({ ...base, catalogId: id, scope }).strict()
  .superRefine((value, context) => {
    if (value.provider === 'codex' && value.scope !== 'user')
      context.addIssue({ code: 'custom', path: ['scope'], message: 'Codex requires user scope' });
  });
export const capabilityPluginTargetRequest = z.object({ ...base, presenceId: id }).strict();
/** Native removal may permanently delete plugin data. It requires its own explicit confirmation. */
export const capabilityPluginUninstallRequest = capabilityPluginTargetRequest.extend({ confirmDataLoss: z.literal(true) });
/** Local path is explicit user input only; it never appears in a safe response. */
export const capabilityPluginMarketplaceRequest = z.object({ ...base, scope, source: z.object({
  kind: z.literal('local'), path: text.min(1),
}).strict() }).strict().superRefine((value, context) => {
  if (value.provider === 'codex' && value.scope !== 'user')
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Codex requires user scope' });
});
const count = z.number().int().nonnegative().max(1_000_000).nullable();
/** Unknown composition remains null. The host must redact every display string before projection. */
export const capabilityPluginComposition = z.object({ skills: count, agents: count, mcp: count, hooks: count,
  tokenEstimate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
const actions = z.object({ install: capabilityActionAvailability, uninstall: capabilityActionAvailability,
  enable: capabilityActionAvailability, disable: capabilityActionAvailability, details: capabilityActionAvailability,
}).strict();
export const capabilityPluginSummary = z.object({ id, kind: z.enum(['installed', 'available']),
  provider: capabilityProvider, name: text.min(1), pluginId: text.min(1), description: text.nullable(),
  version: text.nullable(), scope: capabilityScope.nullable(), enabled: z.boolean().nullable(),
  composition: capabilityPluginComposition, actions,
}).strict().superRefine((value, context) => {
  const humanScope = ['user', 'project', 'local'].includes(value.scope ?? '');
  const mutation = value.actions.uninstall.allowed || value.actions.enable.allowed || value.actions.disable.allowed;
  if ((mutation || value.actions.details.allowed) && (value.kind !== 'installed' || !humanScope))
    context.addIssue({ code: 'custom', path: ['actions'], message: 'Installed plugin action requires human source scope' });
  if (value.actions.install.allowed && value.kind !== 'available')
    context.addIssue({ code: 'custom', path: ['actions', 'install'], message: 'Install requires an available plugin' });
  if (value.provider === 'codex' && (value.actions.enable.allowed || value.actions.disable.allowed || value.actions.details.allowed || value.actions.uninstall.allowed && value.scope !== 'user'))
    context.addIssue({ code: 'custom', path: ['actions'], message: 'Codex plugin actions require native-supported user operations' });
});
export const capabilityPluginCatalogResponse = z.object({ revision, provider: capabilityProvider,
  partial: z.boolean(), phase: z.enum(['ready', 'unavailable', 'error']),
  reason: responseReason.nullable(), entries: z.array(capabilityPluginSummary).max(4096),
}).strict().superRefine((value, context) => {
  value.entries.forEach((entry, index) => {
    if (entry.provider !== value.provider)
      context.addIssue({ code: 'custom', path: ['entries', index, 'provider'], message: 'Catalog entries require matching provider' });
  });
}).refine(responseWithinBudget, 'Plugin response exceeds byte budget');
export const capabilityPluginDetailsResponse = z.object({ revision, partial: z.boolean(),
  entry: capabilityPluginSummary.nullable(), reason: responseReason.nullable(),
}).strict().refine(responseWithinBudget, 'Plugin response exceeds byte budget');
export const capabilityPluginResult = z.object({ outcome: z.enum(['ok', 'denied', 'failed', 'unavailable', 'cancelled']),
  code: z.enum(['ok', ...capabilityActionReason.options, 'invalid-input', 'conflict', 'timeout', 'output-limit',
    'cli-error', 'invalid-output', 'context-changed', 'shutdown', 'policy-denied', 'confirmation-required']),
  exitCode: z.number().int().min(0).max(255).optional(),
}).strict();

export type CapabilityPluginSummary = z.infer<typeof capabilityPluginSummary>;
export type CapabilityPluginResult = z.infer<typeof capabilityPluginResult>;

export type CapabilityPluginCatalogRequest = z.infer<typeof capabilityPluginCatalogRequest>;
export type CapabilityPluginDetailsRequest = z.infer<typeof capabilityPluginDetailsRequest>;
export type CapabilityPluginInstallRequest = z.infer<typeof capabilityPluginInstallRequest>;
export type CapabilityPluginTargetRequest = z.infer<typeof capabilityPluginTargetRequest>;
export type CapabilityPluginUninstallRequest = z.infer<typeof capabilityPluginUninstallRequest>;
export type CapabilityPluginMarketplaceRequest = z.infer<typeof capabilityPluginMarketplaceRequest>;
export type CapabilityPluginCatalogResponse = z.infer<typeof capabilityPluginCatalogResponse>;
export type CapabilityPluginDetailsResponse = z.infer<typeof capabilityPluginDetailsResponse>;
export const capabilityPluginMethodSchemas = {
  'capabilities.plugins.available': capabilityPluginCatalogRequest,
  'capabilities.plugins.details': capabilityPluginDetailsRequest,
  'capabilities.plugins.install': capabilityPluginInstallRequest,
  'capabilities.plugins.uninstall': capabilityPluginUninstallRequest,
  'capabilities.plugins.enable': capabilityPluginTargetRequest,
  'capabilities.plugins.disable': capabilityPluginTargetRequest,
  'capabilities.plugins.addMarketplace': capabilityPluginMarketplaceRequest,
} as const;
export interface CapabilityPluginMethodResults {
  'capabilities.plugins.available': CapabilityPluginCatalogResponse;
  'capabilities.plugins.details': CapabilityPluginDetailsResponse;
  'capabilities.plugins.install': CapabilityPluginResult;
  'capabilities.plugins.uninstall': CapabilityPluginResult;
  'capabilities.plugins.enable': CapabilityPluginResult;
  'capabilities.plugins.disable': CapabilityPluginResult;
  'capabilities.plugins.addMarketplace': CapabilityPluginResult;
}
