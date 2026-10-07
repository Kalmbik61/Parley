import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  discoverClaudeSkills,
  type ClaudeDiscoveryOptions,
  type DiscoveryDiagnostic as ClaudeDiagnostic,
} from './claude.js';
import {
  discoverCodexSkills,
  type CodexDiscoveryOptions,
  type DiscoveryDiagnostic as CodexDiagnostic,
} from './codex.js';
import type { NativeSkill } from './types.js';

/** Evidence and settings are explicit session snapshots; resolving never runs a CLI. */
export type SkillCatalogOptions =
  | ({ provider: 'claude' } & ClaudeDiscoveryOptions)
  | ({ provider: 'codex' } & CodexDiscoveryOptions);

export type SkillCatalogDiagnostic =
  | ClaudeDiagnostic
  | CodexDiagnostic
  | { provider: NativeSkill['provider']; code: 'missing-context'; path: string };

export interface SkillCatalog {
  provider: NativeSkill['provider'];
  /** Full native inventory, including hidden/unverified records and same-name documents. */
  skills: NativeSkill[];
  diagnostics: SkillCatalogDiagnostic[];
  /** Never prune an earlier inventory using an incomplete result. */
  partial: boolean;
}

export async function resolveSkillCatalog(options: SkillCatalogOptions): Promise<SkillCatalog> {
  const cwd = path.resolve(options.cwd);
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    // A deleted participant worktree must not be replaced with the leader's/home catalog.
    return {
      provider: options.provider,
      skills: [],
      diagnostics: [{ provider: options.provider, code: 'missing-context', path: cwd }],
      partial: true,
    };
  }
  const result = options.provider === 'claude'
    ? await discoverClaudeSkills(options)
    : await discoverCodexSkills(options);
  return { provider: options.provider, ...result };
}
