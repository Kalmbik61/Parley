import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRoleCatalog } from '@parley/core';
import type { RequestInfo } from '../context.js';
import { createRecipesList } from './recipes.js';

let project = '';
beforeEach(async () => { project = await mkdtemp(path.join(tmpdir(), 'parley-recipes-method-')); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
const request = {} as RequestInfo;
const good = '---\nname: Mine\ndescription: Own recipe\nmode: free\nagents:\n  - role: builtin:reviewer\n    lead: true\n  - role: builtin:architect\n---\nMy playbook.\n';

describe('recipes.list', () => {
  it('встроенные и рецепты проекта; битый файл — отдельной строкой с причиной, каталог рабочий', async () => {
    await mkdir(path.join(project, '.parley', 'recipes'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'recipes', 'mine.md'), good);
    await writeFile(path.join(project, '.parley', 'recipes', 'broken.md'), good.replace('name: Mine', 'name: A\nname: B'));
    const result = await createRecipesList(async () => buildRoleCatalog())({ projectPath: project }, request);
    const valid = result.entries.flatMap((entry) => (entry.status === 'valid' ? [entry.recipe.id] : []));
    expect(valid).toEqual(['builtin:plan-build', 'builtin:review', 'builtin:debug', 'project:mine']);
    expect(result.entries.find((entry) => entry.status === 'invalid')).toMatchObject({
      id: 'project:broken', file: 'broken.md', diagnostic: { code: 'invalid-yaml', line: 3 },
    });
    expect(result.partial).toBe(false);
  });

  it('текст роли в ответ не попадает; относительный путь — bad_request до чтения ролей', async () => {
    const roles = buildRoleCatalog({ roles: [{ id: 'codex:sec', source: 'codex', provider: 'codex', name: 'sec', description: 'Review', path: '/secret/role.toml', prompt: 'PRIVATE_PROMPT', readOnly: true, model: 'm', effort: 'high', sandboxMode: 'read-only' }], diagnostics: [], partial: false });
    let calls = 0;
    const handler = createRecipesList(async () => { calls++; return roles; });
    expect(JSON.stringify(await handler({ projectPath: project }, request))).not.toContain('PRIVATE_PROMPT');
    await expect(handler({ projectPath: 'relative' }, request)).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toBe(1);
  });
});
