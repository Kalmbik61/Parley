/**
 * Запись рецепта проекта (Save as recipe, спека рецептов, 5.2). Пишется только `<проект>/.parley/recipes/<имя>.md` —
 * тем же каталогом, из которого читает `recipes.list` (`listRecipeCatalog`), поэтому сохранённый рецепт сразу виден в
 * диалоге. Основа имени файла проверяется строго (`RECIPE_FILE_STEM`), содержимое — тем же разборщиком, что читает
 * рецепты (`parseProjectRecipe`): файл, который каталог счёл бы битым, не пишется. Существующий файл без явного
 * `replace` не трогается.
 */

import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureStateDir, parseProjectRecipe, type RecipeAgent } from '@parley/core';
import { RECIPE_FILE_STEM, type RecipeSaveRequest } from '../shared/recipe-save.js';
import { HostError } from './host-connection.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const KEYS = ['projectPath', 'file', 'name', 'description', 'mode', 'agents', 'playbook', 'replace'];
const AGENT_KEYS = ['role', 'provider', 'model', 'effort', 'worktree', 'lead', 'count'];
/** Состав рецепта — единицы строк; предел отсекает мусор до разбора. */
const MAX_AGENT_ROWS = 30;
const MAX_TEXT = 1024 * 1024;

/** Форма запроса из окна; смысл (роли, ведущий, число агентов) проверяет разборщик рецепта при записи. */
export function parseRecipeSaveRequest(value: unknown): RecipeSaveRequest | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => KEYS.includes(key))) return null;
  const { projectPath, file, name, description, mode, agents, playbook, replace } = value;
  if (typeof projectPath !== 'string' || projectPath.includes('\0') || !path.isAbsolute(projectPath) || projectPath.length > 32768) return null;
  if (typeof file !== 'string' || !RECIPE_FILE_STEM.test(file)) return null;
  if (typeof name !== 'string' || typeof description !== 'string' || typeof playbook !== 'string' || playbook.length > MAX_TEXT) return null;
  if (mode !== 'free' && mode !== 'checklist' && mode !== 'verified') return null;
  if (typeof replace !== 'boolean' || !Array.isArray(agents) || agents.length > MAX_AGENT_ROWS) return null;
  const rows: RecipeAgent[] = [];
  for (const row of agents) {
    if (!isRecord(row) || !Object.keys(row).every((key) => AGENT_KEYS.includes(key))) return null;
    const { role, provider, model, effort, worktree, lead, count } = row;
    if (typeof role !== 'string' || typeof worktree !== 'boolean' || typeof lead !== 'boolean' || typeof count !== 'number') return null;
    if (provider !== undefined && typeof provider !== 'string') return null;
    if (model !== undefined && model !== null && typeof model !== 'string') return null;
    if (effort !== undefined && effort !== null && typeof effort !== 'string') return null;
    rows.push({ role, worktree, lead, count,
      ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
  }
  return { projectPath, file, name, description, mode, agents: rows, playbook, replace };
}

/** Строка YAML в двойных кавычках: JSON-строка — корректный YAML; разделители строк Unicode экранируются отдельно. */
const quoted = (text: string): string => JSON.stringify(text).replace(/[\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Файл рецепта: frontmatter (YAML) и тело — плейбук как есть, байт в байт. */
export function recipeFileText(input: Pick<RecipeSaveRequest, 'name' | 'description' | 'mode' | 'agents' | 'playbook'>): string {
  const lines = ['---', `name: ${quoted(input.name)}`, `description: ${quoted(input.description)}`, `mode: ${input.mode}`, 'agents:'];
  for (const row of input.agents) {
    lines.push(`  - role: ${quoted(row.role)}`);
    if (row.provider !== undefined) lines.push(`    provider: ${quoted(row.provider)}`);
    if (row.model !== undefined) lines.push(`    model: ${row.model === null ? 'null' : quoted(row.model)}`);
    if (row.effort !== undefined) lines.push(`    effort: ${row.effort === null ? 'null' : quoted(row.effort)}`);
    if (row.worktree) lines.push('    worktree: true');
    if (row.lead) lines.push('    lead: true');
    if (row.count !== 1) lines.push(`    count: ${row.count}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${input.playbook}`;
}

const bad = (): HostError => new HostError('bad_request', 'Invalid recipe request.');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Пишет рецепт и возвращает путь файла. `exists` — файл уже есть и `replace` не выбран. Каталог рецептов — только
 * настоящая папка внутри каталога состояния проекта; ссылка вместо неё или вместо файла — отказ.
 */
export async function writeProjectRecipe(input: RecipeSaveRequest): Promise<{ status: 'saved'; file: string; id: string } | { status: 'exists' }> {
  const text = recipeFileText(input);
  const name = `${input.file}.md`;
  const parsed = parseProjectRecipe(name, text);
  if (parsed.status !== 'valid' || parsed.recipe.playbook !== input.playbook || parsed.recipe.name !== input.name) throw bad();
  const project = await realpath(input.projectPath);
  const state = await ensureStateDir(project);
  const folder = path.join(state, 'recipes');
  await mkdir(folder, { recursive: true });
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || await realpath(folder) !== path.join(await realpath(state), 'recipes')) throw bad();
  const target = path.join(folder, name);
  let existing = false;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw bad();
    existing = true;
  } catch (error) { if (!missing(error)) throw error; }
  if (existing && !input.replace) return { status: 'exists' };
  if (existing) {
    // Замена — через соседний временный файл: читатель не увидит половину записи.
    const temporary = path.join(folder, `.${input.file}.${process.pid}.tmp`);
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    await rename(temporary, target);
  } else {
    try { await writeFile(target, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'exists' }; throw error; }
  }
  return { status: 'saved', file: target, id: parsed.recipe.id };
}
