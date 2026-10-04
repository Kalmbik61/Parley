import path from 'node:path';
import { BUILTIN_ROLES } from '../roles/builtin.js';
import { parseMarkdownFrontmatter } from '../skills/frontmatter.js';
import type { ParsedRecipe, RecipeAgent, RecipeCode } from './types.js';

export const RECIPE_DOCUMENT_MAX_BYTES = 1024 * 1024;
const invalid = (code: RecipeCode): ParsedRecipe => ({ status: 'invalid', diagnostic: { code } });
const scalar = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString() === value;
const label = (value: unknown): value is string => scalar(value) && !!value.trim() && !/[\r\n]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (row: Record<string, unknown>, allowed: string[]): boolean => Object.keys(row).every(key => allowed.includes(key));
export function projectRecipeId(file: string): string | null {
  if (path.basename(file) !== file || !file.endsWith('.md') || file.length > 255 || !label(file)) return null;
  const name = file.slice(0, -3);
  return name && name !== '.' && name !== '..' ? `project:${name}` : null;
}
/** Names remain exact source-qualified native identities, never filesystem paths or guessed aliases. */
function roleId(value: unknown): value is string {
  if (!scalar(value)) return false;
  const colon = value.indexOf(':'); const source = value.slice(0, colon); const name = value.slice(colon + 1);
  if (colon < 0 || !name || name.length > 4096) return false;
  return source === 'builtin' ? BUILTIN_ROLES.some(role => role.id === value) : source === 'claude' || source === 'codex';
}
export function parseProjectRecipe(file: string, text: string): ParsedRecipe {
  const id = projectRecipeId(file);
  if (!id) return invalid('invalid-id');
  if (!scalar(text)) return invalid('invalid-utf8');
  if (Buffer.byteLength(text) > RECIPE_DOCUMENT_MAX_BYTES) return invalid('file-too-large');
  const parsed = parseMarkdownFrontmatter(text);
  if (parsed.status === 'missing') return invalid('missing-frontmatter');
  if (parsed.status === 'invalid') return { status: 'invalid', diagnostic: { code: 'invalid-yaml', ...(parsed.diagnostic.line === undefined ? {} : { line: parsed.diagnostic.line }), ...(parsed.diagnostic.column === undefined ? {} : { column: parsed.diagnostic.column }) } };
  const data = parsed.data;
  if (!exactKeys(data, ['name', 'description', 'mode', 'agents']) || !label(data.name) || !label(data.description) || typeof data.mode !== 'string' || !['free', 'checklist', 'verified'].includes(data.mode) || !Array.isArray(data.agents) || data.agents.length > 10_000) return invalid('invalid-schema');
  const agents: RecipeAgent[] = [];
  for (const value of data.agents) {
    if (!record(value) || !exactKeys(value, ['role', 'provider', 'model', 'effort', 'worktree', 'lead', 'count']) ||
        (value.provider !== undefined && !label(value.provider)) ||
        (value.model !== undefined && value.model !== null && !label(value.model)) ||
        (value.effort !== undefined && value.effort !== null && !label(value.effort)) ||
        (value.worktree !== undefined && typeof value.worktree !== 'boolean') ||
        (value.lead !== undefined && typeof value.lead !== 'boolean')) return invalid('invalid-schema');
    if (!roleId(value.role)) return invalid('invalid-role');
    const count = value.count === undefined ? 1 : value.count;
    if (!Number.isInteger(count) || typeof count !== 'number' || count < 1 || count > 3) return invalid('invalid-count');
    agents.push({ role: value.role, ...(value.provider === undefined ? {} : { provider: value.provider as string }), ...(value.model === undefined ? {} : { model: value.model as string | null }), ...(value.effort === undefined ? {} : { effort: value.effort as string | null }), worktree: value.worktree === true, lead: value.lead === true, count });
  }
  if (agents.filter(row => row.lead).length !== 1 || agents.some(row => row.lead && row.count !== 1)) return invalid('invalid-lead');
  if (agents.reduce((sum, row) => sum + row.count, 0) < 2) return invalid('too-few-agents');
  // The common parser already validates the initial closed header. Keep body bytes/EOL exactly.
  const delimiters = [...text.matchAll(/^---[ \t]*\r?$/gm)];
  const closing = delimiters[text.charCodeAt(0) === 0xfeff ? 0 : 1];
  if (!closing || closing.index === undefined) return invalid('invalid-yaml');
  const bodyStart = closing.index + closing[0].length + (text[closing.index + closing[0].length] === '\n' ? 1 : 0);
  const playbook = text.slice(bodyStart);
  return { status: 'valid', recipe: { id, source: 'project', name: data.name, description: data.description, mode: data.mode as 'free' | 'checklist' | 'verified', agents, playbook } };
}
