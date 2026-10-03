/** Internal catalog contract; raw metadata and skill bodies never enter the wire DTO. */
export interface NativeSkill {
  provider: 'claude' | 'codex';
  /** Native discovery origin, never inferred from the canonical filename. */
  documentKind: 'skill' | 'command';
  /** Exact native load name, including its namespace. */
  name: string;
  /** Full valid description; empty only for an invalid metadata record. */
  description: string;
  source: 'user' | 'project' | 'plugin' | 'claude.ai' | 'system' | 'admin' | 'extra';
  /** Absolute canonical path of SKILL.md or a native Claude command document. */
  path: string;
  modelAvailable: boolean;
  unavailableReason: SkillUnavailableReason | null;
}

export type SkillUnavailableReason =
  | 'human-disabled'
  | 'user-invocable-only'
  | 'implicit-invocation-disabled'
  | 'disable-model-invocation'
  | 'plugin-disabled'
  | 'shadowed'
  | 'availability-unverified'
  | 'invalid-metadata'
  | 'load-tool-unavailable';

export type MetadataDiagnosticCode =
  | 'invalid-yaml'
  | 'invalid-toml'
  | 'invalid-utf8'
  | 'file-too-large'
  | 'unreadable'
  | 'invalid-policy'
  | 'invalid-name';

/** Only safe codes and 1-based positions: never parser messages or source excerpts. */
export interface MetadataDiagnostic {
  code: MetadataDiagnosticCode;
  line?: number;
  column?: number;
}

export interface InvalidMetadata {
  status: 'invalid';
  diagnostic: MetadataDiagnostic;
}

export type MetadataResult = { status: 'valid'; data: Record<string, unknown> } | InvalidMetadata;
export type FrontmatterResult = MetadataResult | { status: 'missing' };
