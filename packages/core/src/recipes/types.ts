import type { ResolvedRoleChoice } from '../roles/catalog.js';

export interface RecipeAgent {
  role: string;
  provider?: string;
  model?: string | null;
  effort?: string | null;
  worktree: boolean;
  lead: boolean;
  count: number;
}
export interface RecipeDefinition {
  id: string;
  source: 'builtin' | 'project';
  name: string;
  description: string;
  mode: 'free' | 'checklist' | 'verified';
  agents: RecipeAgent[];
  /** Full human text; marked delivery preprocessing belongs to the launch layer. */
  playbook: string;
}
export interface RecipeSnapshot { id: string; name: string; playbook: string }
export type RecipeCode = 'invalid-id' | 'missing-frontmatter' | 'invalid-yaml' | 'invalid-schema' | 'invalid-role' | 'invalid-count' | 'invalid-lead' | 'too-few-agents' | 'invalid-utf8' | 'file-too-large' | 'unreadable' | 'discovery-limit';
export interface RecipeDiagnostic { code: RecipeCode; line?: number; column?: number }
export type ParsedRecipe = { status: 'valid'; recipe: RecipeDefinition } | { status: 'invalid'; diagnostic: RecipeDiagnostic };
export interface ExpandedRecipeAgent {
  choice: Omit<RecipeAgent, 'count'>;
  status: 'ready' | 'role-missing' | 'role-provider-mismatch' | 'role-permissions-unavailable' | 'role-context-unverified';
  resolved: ResolvedRoleChoice | null;
}
export type RecipeEntry = { status: 'valid'; recipe: RecipeDefinition; agents: ExpandedRecipeAgent[] } | { status: 'invalid'; id: string; file: string; diagnostic: RecipeDiagnostic };
export interface RecipeCatalog { entries: RecipeEntry[]; partial: boolean; diagnostics: RecipeDiagnostic[] }
/** Безопасная проекция строки для окна: без текста роли, путей и нативной конфигурации. */
export interface RecipeAgentView {
  choice: ExpandedRecipeAgent['choice'];
  status: ExpandedRecipeAgent['status'];
  resolved: { provider: string; model: string | null; effort: string | null; readOnly: boolean } | null;
}
export type RecipeEntryView =
  | { status: 'valid'; recipe: RecipeDefinition; agents: RecipeAgentView[] }
  | Extract<RecipeEntry, { status: 'invalid' }>;
export interface RecipeCatalogView { entries: RecipeEntryView[]; partial: boolean; diagnostics: RecipeDiagnostic[] }
