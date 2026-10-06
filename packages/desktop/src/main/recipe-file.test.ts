/**
 * Запись рецепта проекта (Save as recipe): строгая форма запроса и имя файла, содержимое читается тем же разборщиком,
 * что и каталог, существующий файл без `replace` не трогается, ссылки вместо каталога и файла отвергаются.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureStateDir, parseProjectRecipe, type RecipeAgent } from '@parley/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECIPE_FILE_STEM, recipeFileStem, type RecipeSaveRequest } from '../shared/recipe-save.js';
import { parseRecipeSaveRequest, recipeFileText, writeProjectRecipe } from './recipe-file.js';

const AGENTS: RecipeAgent[] = [
  { role: 'builtin:planner', lead: true, worktree: false, count: 1 },
  { role: 'builtin:executor', worktree: true, lead: false, count: 1, provider: 'claude', model: 'opus', effort: 'high' },
  { role: 'builtin:reviewer', worktree: false, lead: false, count: 1, model: null },
];

let project = '';
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-recipe-file-'))); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

const request = (patch: Partial<RecipeSaveRequest> = {}): RecipeSaveRequest => ({
  projectPath: project, file: 'payments-change', name: 'Payments change', description: 'Plan & build with a review', mode: 'verified',
  agents: AGENTS, playbook: '1. Ask.\n2. Plan.\n', replace: false, ...patch,
});
const recipesDir = (): string => path.join(project, '.parley', 'recipes');

describe('Save as recipe: запрос и имя файла', () => {
  it('принимает основу имени из букв, цифр, - и _', () => {
    for (const file of ['a', 'Payments_change-2', 'x'.repeat(64)]) expect(parseRecipeSaveRequest({ ...request(), file })).not.toBeNull();
    expect(RECIPE_FILE_STEM.test('x'.repeat(65))).toBe(false);
  });

  it('отвергает ../, слеши, точки, расширение, пустое и чужие поля', () => {
    for (const file of ['../escape', '..', '.', 'a/b', 'a\\b', '/abs', '.hidden', 'x.md', 'a b', '', '-lead', 'a\0b', 'a\nb'])
      expect(parseRecipeSaveRequest({ ...request(), file }), JSON.stringify(file)).toBeNull();
    expect(parseRecipeSaveRequest({ ...request(), extra: 1 })).toBeNull();
    expect(parseRecipeSaveRequest({ ...request(), mode: 'auto' })).toBeNull();
    expect(parseRecipeSaveRequest({ ...request(), projectPath: 'relative/path' })).toBeNull();
    expect(parseRecipeSaveRequest({ ...request(), replace: 'yes' })).toBeNull();
    expect(parseRecipeSaveRequest({ ...request(), agents: [{ role: 'builtin:planner', worktree: false, lead: true, count: 1, extra: true }] })).toBeNull();
    expect(parseRecipeSaveRequest(null)).toBeNull();
  });

  it('основа имени по названию: латиница и цифры через -, пустая, если не из чего', () => {
    expect(recipeFileStem('Payments change!')).toBe('payments-change');
    expect(recipeFileStem('  Debug / fast  ')).toBe('debug-fast');
    expect(recipeFileStem('Рецепт')).toBe('');
    expect(RECIPE_FILE_STEM.test(recipeFileStem('A'.repeat(100)))).toBe(true);
  });
});

describe('recipeFileText: файл читается тем же разборщиком', () => {
  it('круг: состав, режим, описание и плейбук возвращаются как были', () => {
    const playbook = 'Line one: "quoted" and \\ backslash.\n---\nAfter a rule.\n\n  indented\n';
    const text = recipeFileText(request({ name: 'Plan: "q" & more', description: 'Tabs\tand ünïcode — dash', playbook }));
    const parsed = parseProjectRecipe('payments-change.md', text);
    expect(parsed.status).toBe('valid');
    if (parsed.status !== 'valid') return;
    expect(parsed.recipe).toMatchObject({ id: 'project:payments-change', name: 'Plan: "q" & more', description: 'Tabs\tand ünïcode — dash', mode: 'verified', playbook });
    expect(parsed.recipe.agents).toEqual(AGENTS);
  });

  it('разделители строк Unicode в названии не ломают файл', () => {
    const parsed = parseProjectRecipe('x.md', recipeFileText(request({ name: 'a b\u0085c' })));
    expect(parsed).toMatchObject({ status: 'valid', recipe: { name: 'a b\u0085c' } });
  });
});

describe('writeProjectRecipe', () => {
  it('пишет .parley/recipes/<имя>.md и возвращает id проекта', async () => {
    const result = await writeProjectRecipe(request());
    expect(result).toEqual({ status: 'saved', file: path.join(recipesDir(), 'payments-change.md'), id: 'project:payments-change' });
    expect(parseProjectRecipe('payments-change.md', await readFile(path.join(recipesDir(), 'payments-change.md'), 'utf8')).status).toBe('valid');
    expect(await readdir(recipesDir())).toEqual(['payments-change.md']);
  });

  it('занятое имя без replace: exists, файл не тронут', async () => {
    await writeProjectRecipe(request());
    const file = path.join(recipesDir(), 'payments-change.md');
    const before = await readFile(file, 'utf8');
    expect(await writeProjectRecipe(request({ description: 'Another', playbook: 'New\n' }))).toEqual({ status: 'exists' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(recipesDir())).toEqual(['payments-change.md']);
  });

  it('replace после выбора человека заменяет файл целиком, без временных остатков', async () => {
    await writeProjectRecipe(request());
    const result = await writeProjectRecipe(request({ description: 'Another', playbook: 'New\n', replace: true }));
    expect(result.status).toBe('saved');
    const parsed = parseProjectRecipe('payments-change.md', await readFile(path.join(recipesDir(), 'payments-change.md'), 'utf8'));
    expect(parsed).toMatchObject({ status: 'valid', recipe: { description: 'Another', playbook: 'New\n' } });
    expect(await readdir(recipesDir())).toEqual(['payments-change.md']);
  });

  it('рецепт, который каталог счёл бы битым, не пишется и каталог не создаётся', async () => {
    for (const bad of [
      request({ agents: [AGENTS[0] as RecipeAgent] }),
      request({ agents: [AGENTS[0] as RecipeAgent, { ...(AGENTS[1] as RecipeAgent), lead: true }] }),
      request({ agents: [AGENTS[0] as RecipeAgent, { role: 'nobody:x', worktree: false, lead: false, count: 1 }] }),
      request({ agents: [AGENTS[0] as RecipeAgent, { ...(AGENTS[1] as RecipeAgent), count: 4 }] }),
      request({ name: '  ' }),
      request({ name: 'two\nlines' }),
    ]) await expect(writeProjectRecipe(bad)).rejects.toThrow();
    await expect(lstat(path.join(project, '.parley'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('каталог рецептов — ссылка наружу: отказ, снаружи ничего не записано', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'parley-recipe-outside-'));
    try {
      await mkdir(path.join(project, '.parley'));
      await symlink(outside, recipesDir());
      await expect(writeProjectRecipe(request())).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('файл рецепта — ссылка: отказ даже с replace, цель ссылки не тронута', async () => {
    const outside = path.join(project, 'human.txt');
    await writeFile(outside, 'Private');
    await mkdir(recipesDir(), { recursive: true });
    await symlink(outside, path.join(recipesDir(), 'payments-change.md'));
    await expect(writeProjectRecipe(request())).rejects.toThrow();
    await expect(writeProjectRecipe(request({ replace: true }))).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('Private');
  });
});

describe('Save as recipe: .gitignore каталога состояния', () => {
  // Белый список shared-файлов (SHARED_STATE_IGNORE в core, наружу не экспортируется).
  const SHARED_STATE_IGNORE = '*\n!.gitignore\n!backlog.md\n!plans/\n!plans/**\n!memory.md\n!decisions/\n!decisions/**\n!history-shared/\n!history-shared/**\n!recipes/\n!recipes/**\n';
  const ignoreFile = (): string => path.join(project, '.parley', '.gitignore');

  it('рецепт в новом проекте переключает .gitignore со строки * на белый список', async () => {
    await ensureStateDir(project);
    expect(await readFile(ignoreFile(), 'utf8')).toBe('*\n');
    expect((await writeProjectRecipe(request())).status).toBe('saved');
    expect(await readFile(ignoreFile(), 'utf8')).toBe(SHARED_STATE_IGNORE);
  });

  it('рецепт в проекте без каталога состояния: каталог заведён, .gitignore уже белый список', async () => {
    expect((await writeProjectRecipe(request())).status).toBe('saved');
    expect(await readFile(ignoreFile(), 'utf8')).toBe(SHARED_STATE_IGNORE);
  });

  it('написанный человеком .gitignore не переписывается', async () => {
    const dir = await ensureStateDir(project);
    await writeFile(path.join(dir, '.gitignore'), '*\n!mine\n');
    expect((await writeProjectRecipe(request())).status).toBe('saved');
    expect(await readFile(ignoreFile(), 'utf8')).toBe('*\n!mine\n');
  });
});
