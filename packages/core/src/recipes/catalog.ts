import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveRoleChoice, RoleChoiceError } from '../roles/catalog.js';
import { isClaudeCode } from '../providers.js';
import type { RoleCatalog } from '../roles/types.js';
import { stateDir } from '../work/state-dir.js';
import { BUILTIN_RECIPES } from './builtin.js';
import { parseProjectRecipe, projectRecipeId, RECIPE_DOCUMENT_MAX_BYTES } from './parse.js';
import type { ExpandedRecipeAgent, ParsedRecipe, RecipeCatalog, RecipeCatalogView, RecipeDefinition, RecipeSnapshot } from './types.js';

/** Presets preserve explicit overrides; resolving defaults never mutates the recipe/session map. */
export function expandRecipe(recipe: RecipeDefinition, roles: RoleCatalog): ExpandedRecipeAgent[] {
  return recipe.agents.flatMap(row => Array.from({ length: row.count }, () => {
    const choice = { role: row.role, worktree: row.worktree, lead: row.lead,
      ...(row.provider === undefined ? {} : { provider: row.provider }),
      ...(row.model === undefined ? {} : { model: row.model }),
      ...(row.effort === undefined ? {} : { effort: row.effort }) };
    try {
      return { choice: { ...choice }, status: 'ready' as const, resolved: resolveRoleChoice(roles, { roleId: row.role, ...(row.provider === undefined ? {} : { provider: row.provider }), ...(row.model === undefined ? {} : { model: row.model }), ...(row.effort === undefined ? {} : { effort: row.effort }),
        // Роль Claude годится любому провайдеру семейства Claude Code (GLM), как и при создании сессии (`prepareSessionRole`).
        ...(row.provider !== undefined && isClaudeCode(row.provider) ? { claudeCode: true } : {}) }) };
    } catch (error) {
      if (!(error instanceof RoleChoiceError)) throw error;
      return { choice: { ...choice }, status: error.code, resolved: null };
    }
  }));
}
export function snapshotRecipe(recipe: RecipeDefinition): RecipeSnapshot {
  return { id: recipe.id, name: recipe.name, playbook: recipe.playbook };
}
/** Каталог для окна: ошибки разбора остаются строками, а нативные роли сводятся к безопасной выжимке. */
export function recipeCatalogView(catalog: RecipeCatalog): RecipeCatalogView {
  return {
    partial: catalog.partial,
    diagnostics: catalog.diagnostics,
    entries: catalog.entries.map(entry => entry.status === 'invalid' ? entry : {
      status: 'valid' as const, recipe: entry.recipe,
      agents: entry.agents.map(({ choice, status, resolved }) => ({ choice, status,
        resolved: resolved === null ? null : { provider: resolved.provider, model: resolved.model, effort: resolved.effort, readOnly: resolved.readOnly } })),
    }),
  };
}
async function readRecipe(file: string): Promise<{ parsed: ParsedRecipe; bytes: number }> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { parsed: { status: 'invalid', diagnostic: { code: 'unreadable' } }, bytes: 0 };
      const bytes = Buffer.alloc(RECIPE_DOCUMENT_MAX_BYTES + 1); let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > RECIPE_DOCUMENT_MAX_BYTES) return { parsed: { status: 'invalid', diagnostic: { code: 'file-too-large' } }, bytes: length };
      const current = await lstat(file), after = await handle.stat();
      if (!current.isFile() || before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        return { parsed: { status: 'invalid', diagnostic: { code: 'unreadable' } }, bytes: length };
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
      catch { return { parsed: { status: 'invalid', diagnostic: { code: 'invalid-utf8' } }, bytes: length }; }
      return { parsed: parseProjectRecipe(path.basename(file), text), bytes: length };
    } finally { await handle.close(); }
  } catch { return { parsed: { status: 'invalid', diagnostic: { code: 'unreadable' } }, bytes: 0 }; }
}
/** Selected project Git files only. Native role context is supplied, never guessed or rediscovered. */
export async function listRecipeCatalog(options: { projectPath?: string; roles: RoleCatalog }): Promise<RecipeCatalog> {
  const catalog: RecipeCatalog = { entries: BUILTIN_RECIPES.map(item => { const recipe = structuredClone(item); return { status: 'valid', recipe, agents: expandRecipe(recipe, options.roles) }; }), partial: false, diagnostics: [] };
  if (options.projectPath === undefined) return catalog;
  try {
    const project = await realpath(options.projectPath);
    if (!(await lstat(project)).isDirectory()) throw new Error('unavailable project');
    const root = stateDir(project), folder = path.join(root, 'recipes');
    // An absent recipes directory is empty; a vanished established context is unavailable.
    try { await lstat(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return catalog; throw error; }
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('unsafe recipe root');
    try { await lstat(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return catalog; throw error; }
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory() || await realpath(folder) !== folder || !(await lstat(folder)).isDirectory()) throw new Error('unsafe recipes directory');
    const rootInfo = await lstat(root), directory = await lstat(folder);
    const unchanged = async (): Promise<boolean> => {
      const r = await lstat(root), d = await lstat(folder);
      return r.isDirectory() && d.isDirectory() && r.ino === rootInfo.ino && r.dev === rootInfo.dev && d.ino === directory.ino && d.dev === directory.dev && await realpath(root) === root && await realpath(folder) === folder;
    };
    const names: string[] = []; const stream = await opendir(folder);
    try {
      for (;;) {
        const entry = await stream.read(); if (!entry) break;
        if (names.length >= 256) { catalog.partial = true; catalog.diagnostics.push({ code: 'discovery-limit' }); break; }
        names.push(entry.name);
      }
    } finally { await stream.close(); }
    let total = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      if (!await unchanged()) throw new Error('recipe context changed');
      const result = await readRecipe(path.join(folder, name)); total += result.bytes;
      if (total > 8 * 1024 * 1024) { catalog.partial = true; catalog.diagnostics.push({ code: 'discovery-limit' }); break; }
      if (!await unchanged()) throw new Error('recipe context changed');
      catalog.entries.push(result.parsed.status === 'valid'
        ? { ...result.parsed, agents: expandRecipe(result.parsed.recipe, options.roles) }
        : { status: 'invalid', id: projectRecipeId(name) ?? `project:${name}`, file: name, diagnostic: result.parsed.diagnostic });
    }
  } catch {
    catalog.entries = catalog.entries.filter(entry => entry.status === 'valid' && entry.recipe.source === 'builtin');
    catalog.partial = true; catalog.diagnostics.push({ code: 'unreadable' });
  }
  return catalog;
}
