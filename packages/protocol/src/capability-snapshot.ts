import { z } from 'zod';

export const capabilityProvider = z.enum(['claude', 'codex']);
export const capabilityScope = z.enum(['user', 'project', 'local', 'plugin', 'builtin', 'system', 'admin', 'extra', 'claude.ai']);
export const capabilityDiagnostic = z.object({
  code: z.enum(['missing-context', 'context-unverified', 'unavailable', 'unreadable', 'invalid-config',
    'invalid-output', 'timeout', 'output-limit', 'resolver-partial', 'identity-unverified', 'receipt-unverified']),
  source: z.enum(['skills', 'mcp', 'plugins', 'context', 'receipt']).optional(),
  count: z.number().int().nonnegative().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
}).strict();
export const capabilityActionReason = z.enum(['unverified', 'stale', 'builtin', 'managed', 'ambiguous',
  'not-installed', 'unsupported-scope', 'unsupported-transport', 'unsupported-fields', 'unsupported-context', 'native-only']);
export const capabilityActionAvailability = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true), reason: z.null() }).strict(),
  z.object({ allowed: z.literal(false), reason: capabilityActionReason }).strict(),
]);
export const capabilityPluginActions = z.object({ uninstall: capabilityActionAvailability, enable: capabilityActionAvailability, disable: capabilityActionAvailability, details: capabilityActionAvailability }).strict();
export const capabilityMcpActions = z.object({ remove: capabilityActionAvailability, check: capabilityActionAvailability }).strict();
export const capabilityMcpAddAvailability = z.object({
  user: capabilityActionAvailability, project: capabilityActionAvailability, local: capabilityActionAvailability,
}).strict();

export const capabilitySkillActions = z.object({ share: capabilityActionAvailability, unshare: capabilityActionAvailability }).strict();
export const capabilityPresence = z.object({
  id: z.string().min(1),
  scope: capabilityScope.nullable(),
  source: z.string().nullable(),
  /** Only a canonical skill/command document locator, never an MCP config/transport path. */
  documentPath: z.string().nullable(),
  description: z.string().nullable(),
  installed: z.boolean(),
  enabled: z.boolean().nullable(),
  status: z.enum(['ok', 'off', 'needs-auth', 'pending-approval', 'failed', 'unknown']),
  summary: z.string().nullable(),
  modelAvailable: z.boolean().nullable(),
  unavailableReason: z.enum(['human-disabled', 'user-invocable-only', 'implicit-invocation-disabled',
    'disable-model-invocation', 'plugin-disabled', 'shadowed', 'availability-unverified', 'invalid-metadata',
    'load-tool-unavailable']).nullable(),
  sharedFrom: capabilityProvider.optional(),
  mcpActions: capabilityMcpActions.optional(),
  pluginActions: capabilityPluginActions.optional(),
  skillActions: capabilitySkillActions.optional(),
}).strict();
export const capabilityRow = z.object({
  id: z.string().min(1),
  kind: z.enum(['skill', 'mcp', 'plugin']),
  name: z.string().min(1),
  description: z.string().nullable(),
  separateCopies: z.boolean(),
  claude: z.array(capabilityPresence),
  codex: z.array(capabilityPresence),
}).strict().superRefine((row, context) => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const [index, presence] of row[provider].entries()) {
      if (row.kind !== 'skill' && presence.skillActions !== undefined)
        context.addIssue({ code: 'custom', path: [provider, index, 'skillActions'], message: 'Only skills have sharing actions' });
      if (presence.skillActions && (presence.skillActions.share.allowed || presence.skillActions.unshare.allowed) && (!['user', 'project'].includes(presence.scope ?? '') || row.separateCopies))
        context.addIssue({ code: 'custom', path: [provider, index, 'skillActions'], message: 'Sharing requires one human native source' });
      if (row.kind !== 'plugin' && presence.pluginActions !== undefined)
        context.addIssue({ code: 'custom', path: [provider, index, 'pluginActions'], message: 'Only plugins have plugin actions' });
      if (presence.pluginActions && ['uninstall', 'enable', 'disable'].some(action => presence.pluginActions![action as 'uninstall' | 'enable' | 'disable'].allowed) && !['user', 'project', 'local'].includes(presence.scope ?? ''))
        context.addIssue({ code: 'custom', path: [provider, index, 'pluginActions'], message: 'Plugin mutation requires human source scope' });
      if (provider === 'codex' && presence.pluginActions && (presence.pluginActions.enable.allowed || presence.pluginActions.disable.allowed || presence.pluginActions.details.allowed || presence.pluginActions.uninstall.allowed && presence.scope !== 'user'))
        context.addIssue({ code: 'custom', path: [provider, index, 'pluginActions'], message: 'Codex plugin actions require native-supported user operations' });
      if (row.kind !== 'mcp' && presence.mcpActions !== undefined)
        context.addIssue({ code: 'custom', path: [provider, index, 'mcpActions'], message: 'Only MCP has MCP actions' });
      if (presence.mcpActions?.remove.allowed && !['user', 'project', 'local'].includes(presence.scope ?? ''))
        context.addIssue({ code: 'custom', path: [provider, index, 'mcpActions'], message: 'Removal requires human source scope' });
      if (provider === 'codex' && presence.mcpActions?.remove.allowed && presence.scope !== 'user')
        context.addIssue({ code: 'custom', path: [provider, index, 'mcpActions'], message: 'Codex removal requires user scope' });
      if (provider === 'codex' && presence.mcpActions?.check.allowed)
        context.addIssue({ code: 'custom', path: [provider, index, 'mcpActions'], message: 'Codex connection Check is unavailable' });
      if (presence.mcpActions?.check.allowed && !['user', 'project', 'local'].includes(presence.scope ?? ''))
        context.addIssue({ code: 'custom', path: [provider, index, 'mcpActions'], message: 'Check requires confirmed identity' });
      if (row.kind !== 'skill' && presence.documentPath !== null)
        context.addIssue({ code: 'custom', path: [provider, index, 'documentPath'], message: 'Only skill document locators are permitted' });
      if (row.kind !== 'skill' && (presence.modelAvailable !== null || presence.unavailableReason !== null))
        context.addIssue({ code: 'custom', path: [provider, index, 'modelAvailable'], message: 'Only skills have model availability' });
      if (row.kind === 'skill' && (presence.documentPath === null || presence.modelAvailable === null))
        context.addIssue({ code: 'custom', path: [provider, index], message: 'Skills require document identity and availability' });
    }
  }
});
export const capabilityColumn = z.object({
  phase: z.enum(['loading', 'ready', 'partial', 'error', 'unavailable']),
  mcpAdd: capabilityMcpAddAvailability.optional(),
  pluginCatalog: capabilityActionAvailability.optional(),
  pluginMarketplaceAdd: capabilityMcpAddAvailability.optional(),
  diagnostics: z.array(capabilityDiagnostic),
}).strict();
export const capabilitySnapshot = z.object({
  projectPath: z.string().min(1),
  revision: z.number().int().nonnegative(),
  columns: z.object({ claude: capabilityColumn, codex: capabilityColumn }).strict(),
  rows: z.array(capabilityRow),
}).strict().superRefine((snapshot, context) => {
  for (const scope of ['project', 'local'] as const) if ((snapshot.columns.codex.mcpAdd?.[scope].allowed || snapshot.columns.codex.pluginMarketplaceAdd?.[scope].allowed))
    context.addIssue({ code: 'custom', path: ['columns', 'codex', 'mcpAdd', scope], message: 'Codex mutations require user scope' });
});

export type CapabilityProvider = z.infer<typeof capabilityProvider>;
export type CapabilityScope = z.infer<typeof capabilityScope>;
export type CapabilityDiagnostic = z.infer<typeof capabilityDiagnostic>;
export type CapabilityPresence = z.infer<typeof capabilityPresence>;
export type CapabilityRow = z.infer<typeof capabilityRow>;
export type CapabilityColumn = z.infer<typeof capabilityColumn>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshot>;

export type CapabilityActionReason = z.infer<typeof capabilityActionReason>;
export type CapabilityActionAvailability = z.infer<typeof capabilityActionAvailability>;
export type CapabilityMcpActions = z.infer<typeof capabilityMcpActions>;
export type CapabilityMcpAddAvailability = z.infer<typeof capabilityMcpAddAvailability>;

export type CapabilityPluginActions = z.infer<typeof capabilityPluginActions>;
