import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPES } from '../recipes/builtin.js';
import { BUILTIN_ROLES } from '../roles/builtin.js';
import { recipeDisplay, roleDisplay } from './builtin-display.js';

describe('builtin labels at the display boundary', () => {
  it('has Russian labels and descriptions for all nine roles and all three recipes', () => {
    expect(BUILTIN_ROLES).toHaveLength(9);
    expect(BUILTIN_RECIPES).toHaveLength(3);
    for (const [entries, display] of [
      [BUILTIN_ROLES, roleDisplay],
      [BUILTIN_RECIPES, recipeDisplay],
    ] as const) {
      for (const entry of entries) {
        const source = structuredClone(entry);
        expect(display(entry, 'en')).toEqual({
          name: source.name,
          description: source.description,
        });
        const russian = display(entry, 'ru');
        expect(russian.name).toMatch(/[а-яё]/i);
        expect(russian.description).toMatch(/[а-яё]/i);
        expect(entry).toEqual(source);
      }
    }
  });

  it('shows native roles and project recipes verbatim', () => {
    const custom = {
      id: 'project:review',
      source: 'project',
      name: 'Review & audit',
      description: 'User-authored',
    };
    const native = { ...custom, id: 'claude:reviewer', source: 'claude' };
    expect(recipeDisplay(custom, 'ru')).toEqual({
      name: custom.name,
      description: custom.description,
    });
    expect(roleDisplay(native, 'ru')).toEqual({
      name: native.name,
      description: native.description,
    });
  });
});
