import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, modelForTier } from './builtin.js';
import type { RoleTier } from './types.js';

describe('builtin roles', () => {
  it('provides eight stable original roles with their agreed working boundaries', () => {
    expect(BUILTIN_ROLES.map((role) => role.id)).toEqual([
      'builtin:planner',
      'builtin:architect',
      'builtin:critic',
      'builtin:executor',
      'builtin:reviewer',
      'builtin:verifier',
      'builtin:debugger',
      'builtin:researcher',
    ]);
    for (const role of BUILTIN_ROLES) {
      expect(role.description.trim()).not.toBe('');
      expect(role.prompt.split('\n').length).toBeLessThanOrEqual(40);
      expect(role.prompt).toMatch(/report/i);
      expect(role.prompt).toMatch(/lead|human/i);
      expect(role.prompt).not.toMatch(/[Ѐ-ӿ]/);
      if (role.readOnly) expect(role.prompt).toMatch(/shell/);
    }
    expect(BUILTIN_ROLES.find((role) => role.id === 'builtin:verifier')?.readOnly).toBe(false);
  });
  it('selects the agreed model tiers from the current provider catalog', () => {
    expect(
      ['strong', 'standard', 'light'].map((tier) => modelForTier('claude', tier as RoleTier)),
    ).toEqual(['opus', 'sonnet', 'haiku']);
    expect(
      ['strong', 'standard', 'light'].map((tier) => modelForTier('codex', tier as RoleTier)),
    ).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
    expect(modelForTier('glm', 'strong')).toBeNull();
  });
});
