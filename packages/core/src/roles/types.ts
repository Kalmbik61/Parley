import type { MetadataDiagnosticCode } from '../skills/types.js';

export type RoleProvider = 'claude' | 'codex';
export type RoleTier = 'strong' | 'standard' | 'light';
export type RoleEffort = 'low' | 'medium' | 'high';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
interface RoleBase {
  /** Stable source-qualified identity; native files may move without changing it. */
  id: string;
  name: string;
  description: string;
  provider: RoleProvider;
  readOnly: boolean;
}
export interface BuiltinRole extends RoleBase {
  source: 'builtin';
  tier: RoleTier;
  effort: RoleEffort;
  prompt: string;
}
export interface ClaudeRole extends RoleBase {
  source: 'claude';
  provider: 'claude';
  path: string;
  /** Delivered as --agent, never duplicated as Parley role text. */
  nativeAgent: string;
}
export interface CodexRole extends RoleBase {
  source: 'codex';
  provider: 'codex';
  path: string;
  prompt: string;
  model: string | null;
  /** Native effort is not limited to Parley's three builtin effort levels. */
  effort: string | null;
  sandboxMode: SandboxMode | null;
}
export type RoleDefinition = BuiltinRole | ClaudeRole | CodexRole;
export interface RoleDiagnostic {
  source: 'builtin' | 'claude' | 'codex';
  code:
    | MetadataDiagnosticCode
    | 'duplicate-role'
    | 'symlink-cycle'
    | 'discovery-limit'
    | 'missing-context'
    | 'context-unverified'
    | 'unsupported-config';
  path?: string;
  line?: number;
  column?: number;
  count?: number;
}
export interface RoleCatalog {
  roles: RoleDefinition[];
  diagnostics: RoleDiagnostic[];
  partial: boolean;
}
export interface RoleDiscoveryLimits {
  maxDepth?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxRoots?: number;
}
