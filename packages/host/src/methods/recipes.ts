import path from 'node:path';
import { listRecipeCatalog, recipeCatalogView, sessionRoleCatalog } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

/** Каталог рецептов выбранного проекта: встроенные и файлы `.parley/recipes/`, битые — с причиной. */
export function createRecipesList(catalog = sessionRoleCatalog): Handler<'recipes.list'> {
  return async ({ projectPath }) => {
    if (!path.isAbsolute(projectPath)) throw new HostError('bad_request', 'projectPath must be absolute');
    const roles = await catalog(projectPath, { codex: true });
    return recipeCatalogView(await listRecipeCatalog({ projectPath, roles }));
  };
}
