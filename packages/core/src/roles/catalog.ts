import { BUILTIN_ROLES, modelForTier } from './builtin.js';
import { compareRoleText, discoverClaudeRoles, type ClaudeRoleOptions } from './claude.js';
import { discoverCodexRoles, type CodexRoleOptions } from './codex.js';
import type { RoleCatalog, RoleDefinition, RoleDiagnostic, SandboxMode } from './types.js';

/** Catalog snapshots contain definitions, never saved session choices. */
export function buildRoleCatalog(...native: readonly RoleCatalog[]): RoleCatalog {
  const diagnostics: RoleDiagnostic[] = native.flatMap((catalog) =>
    catalog.diagnostics.map((item) => ({ ...item })),
  );
  const byId = new Map<string, RoleDefinition>();
  const duplicate = new Set<string>();
  let partial = native.some((catalog) => catalog.partial);
  for (const definition of [...BUILTIN_ROLES, ...native.flatMap((catalog) => catalog.roles)]) {
    if (byId.has(definition.id) || duplicate.has(definition.id)) {
      byId.delete(definition.id);
      duplicate.add(definition.id);
      partial = true;
      diagnostics.push({ source: definition.source, code: 'duplicate-role' });
    } else byId.set(definition.id, { ...definition });
  }
  return {
    roles: [...byId.values()].sort((a, b) => compareRoleText(a.id, b.id)),
    diagnostics,
    partial,
  };
}

/** Explicit inputs only: this module never locates or mutates the human global home. */
export async function listRoleCatalog(
  options: { claude?: ClaudeRoleOptions; codex?: CodexRoleOptions } = {},
): Promise<RoleCatalog> {
  const catalogs = await Promise.all([
    ...(options.claude ? [discoverClaudeRoles(options.claude)] : []),
    ...(options.codex ? [discoverCodexRoles(options.codex)] : []),
  ]);
  return buildRoleCatalog(...catalogs);
}

export interface RequiredRolePermissions {
  readOnly?: boolean;
  sandboxMode?: SandboxMode;
  /** A disappeared native Claude identity cannot be replaced by a plain session. */
  nativeAgentRequired?: boolean;
  /** When known, require the same native identity, not merely another Claude role. */
  nativeAgent?: string;
}
export interface RoleChoice {
  roleId?: string | null;
  /** Only fields actually selected by the human belong here. Null clears a default. */
  provider?: string;
  model?: string | null;
  effort?: string | null;
  mode?: 'create' | 'existing';
  providerDefaults?: { provider: string; model?: string | null; effort?: string | null };
  /** Caller carries saved explicit human constraints, not cached permissions/defaults of a removed role. */
  requiredPermissions?: RequiredRolePermissions;
}
export interface ResolvedRoleChoice {
  role: RoleDefinition | null;
  provider: string;
  model: string | null;
  effort: string | null;
  roleText: string;
  nativeAgent: string | null;
  readOnly: boolean;
  sandboxMode: SandboxMode | null;
  warnings: Array<{ code: 'role-missing'; roleId: string }>;
}
export class RoleChoiceError extends Error {
  constructor(
    readonly code:
      | 'role-missing'
      | 'role-provider-mismatch'
      | 'role-permissions-unavailable'
      | 'role-context-unverified',
  ) {
    super(code);
    this.name = 'RoleChoiceError';
  }
}

const sandboxRank: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};
/** Pure resolution: does not mutate the choice or write computed defaults into the map. */
export function resolveRoleChoice(
  catalog: RoleCatalog,
  choice: RoleChoice = {},
): ResolvedRoleChoice {
  const warnings: ResolvedRoleChoice['warnings'] = [];
  const role = choice.roleId
    ? (catalog.roles.find((item) => item.id === choice.roleId) ?? null)
    : null;
  if (choice.roleId && !role) {
    if (choice.mode !== 'existing') throw new RoleChoiceError('role-missing');
    warnings.push({ code: 'role-missing', roleId: choice.roleId });
  }
  if (role?.source === 'codex' && catalog.diagnostics.some((item) => item.source === 'codex')) {
    // An unreadable/unsupported later file could change this role's winning config or permissions.
    throw new RoleChoiceError('role-context-unverified');
  }
  const provider =
    choice.provider ?? role?.provider ?? choice.providerDefaults?.provider ?? 'claude';
  if (role && role.source !== 'builtin' && role.provider !== provider)
    throw new RoleChoiceError('role-provider-mismatch');
  const required = choice.requiredPermissions;
  const nativeAgent = role?.source === 'claude' ? role.nativeAgent : null;
  if (
    (required?.nativeAgentRequired && nativeAgent === null) ||
    (required?.nativeAgent !== undefined && required.nativeAgent !== nativeAgent)
  )
    throw new RoleChoiceError('role-permissions-unavailable');
  const roleModel =
    role?.source === 'builtin'
      ? modelForTier(provider, role.tier)
      : role?.source === 'codex'
        ? role.model
        : null;
  const roleEffort = role?.source === 'builtin' || role?.source === 'codex' ? role.effort : null;
  const defaults =
    choice.providerDefaults?.provider === provider ? choice.providerDefaults : undefined;
  // Claude supplies its own native defaults through --agent; Parley must not override them implicitly.
  const model =
    choice.model !== undefined
      ? choice.model
      : (roleModel ?? (role?.source === 'claude' ? null : (defaults?.model ?? null)));
  const effort =
    choice.effort !== undefined
      ? choice.effort
      : (roleEffort ?? (role?.source === 'claude' ? null : (defaults?.effort ?? null)));
  const readOnly =
    role?.readOnly === true || required?.readOnly === true || required?.sandboxMode === 'read-only';
  let sandboxMode = role?.source === 'codex' ? role.sandboxMode : null;
  if (
    required?.sandboxMode !== undefined &&
    (sandboxMode === null || sandboxRank[required.sandboxMode] < sandboxRank[sandboxMode])
  )
    sandboxMode = required.sandboxMode;
  if (readOnly && provider === 'codex') sandboxMode = 'read-only';
  const prompt = role?.source === 'builtin' || role?.source === 'codex' ? role.prompt : '';
  const roleText =
    role && prompt ? `Your role in this workspace: ${role.name} (${role.id}).\n${prompt}` : '';
  return { role, provider, model, effort, roleText, nativeAgent, readOnly, sandboxMode, warnings };
}
