import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, modelForTier } from './builtin.js';
import type { RoleTier } from './types.js';

describe('builtin roles', () => {
  it('provides nine stable original roles with their agreed working boundaries', () => {
    expect(BUILTIN_ROLES.map((role) => role.id)).toEqual([
      'builtin:feature-lead',
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
    const featureLead = BUILTIN_ROLES.find((role) => role.id === 'builtin:feature-lead')!;
    expect(featureLead.readOnly).toBe(true);
    expect(featureLead.prompt).toContain('application code, tests, scripts or configuration');
    expect(featureLead.prompt).toContain('Ownership is separate');
    expect(featureLead.prompt).toContain('Do not poll for routine progress');
    expect(featureLead.prompt).toContain('Do not acknowledge or relay routine notes');
    expect(featureLead.prompt).toContain('escalate urgent blockers immediately');
    expect(featureLead.prompt).toContain('create_session');
    expect(featureLead.prompt).not.toContain('created by the human');
    expect(featureLead.prompt).not.toContain('Read owned rooms');
    const verifier = BUILTIN_ROLES.find((role) => role.id === 'builtin:verifier')!;
    expect(verifier.readOnly).toBe(false);
    expect(verifier.prompt).toContain('PASS, FAIL, or NOT VERIFIED');
    expect(verifier.prompt).toContain('tests, fixtures, expected results, or configuration');
    const critic = BUILTIN_ROLES.find((role) => role.id === 'builtin:critic')!;
    expect(critic.prompt).toContain('plan or decision');
    const reviewer = BUILTIN_ROLES.find((role) => role.id === 'builtin:reviewer')!;
    expect(reviewer.prompt).toContain('tests cover the changed behavior');
    const debuggerRole = BUILTIN_ROLES.find((role) => role.id === 'builtin:debugger')!;
    expect(debuggerRole.prompt).toContain('regression test');
  });
  it('sends implementation to the standard tier in the Feature Lead and Planner prompts without changing their tiers', () => {
    const featureLead = BUILTIN_ROLES.find((role) => role.id === 'builtin:feature-lead')!;
    const planner = BUILTIN_ROLES.find((role) => role.id === 'builtin:planner')!;

    expect(featureLead.prompt).toContain(
      'on the standard tier (Executor); a strong model takes code only for a named reason.',
    );
    expect(planner.prompt).toContain(
      'Assign implementation steps to standard-tier executors; mark a step strong-only with its reason (concurrency, recovery, security, the write boundary).',
    );
    expect([featureLead.tier, planner.tier]).toEqual(['strong', 'strong']);
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
