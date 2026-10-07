/**
 * Save as recipe (спека рецептов, 5.2): запрос окна к main и ответ. Имя файла — только основа (`payments-change` для
 * `.parley/recipes/payments-change.md`), без путей и расширения: каталог и `.md` добавляет main.
 */

import type { RecipeAgent } from '@parley/core';

/** Основа имени файла рецепта: буква или цифра первой, дальше буквы, цифры, `_` и `-`; без точек и слешей. */
export const RECIPE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RecipeSaveRequest {
  projectPath: string;
  file: string;
  name: string;
  description: string;
  mode: 'free' | 'checklist' | 'verified';
  agents: RecipeAgent[];
  playbook: string;
  /** Только после выбора человека «Replace» в ответ на `exists`: без него существующий файл не трогается. */
  replace: boolean;
}

export type RecipeSaveResult =
  | { status: 'saved'; id: string; opened: boolean }
  /** Файл с таким именем уже есть: окно предлагает Rename или Replace. */
  | { status: 'exists' };

/** Основа имени файла по названию рецепта: `Payments change!` → `payments-change`; пусто, если не из чего. */
export function recipeFileStem(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}
