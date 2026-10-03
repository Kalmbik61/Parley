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
  diagnostics: z.array(capabilityDiagnostic),
}).strict();
export const capabilitySnapshot = z.object({
  projectPath: z.string().min(1),
  revision: z.number().int().nonnegative(),
  columns: z.object({ claude: capabilityColumn, codex: capabilityColumn }).strict(),
  rows: z.array(capabilityRow),
}).strict();

export type CapabilityProvider = z.infer<typeof capabilityProvider>;
export type CapabilityScope = z.infer<typeof capabilityScope>;
export type CapabilityDiagnostic = z.infer<typeof capabilityDiagnostic>;
export type CapabilityPresence = z.infer<typeof capabilityPresence>;
export type CapabilityRow = z.infer<typeof capabilityRow>;
export type CapabilityColumn = z.infer<typeof capabilityColumn>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshot>;
