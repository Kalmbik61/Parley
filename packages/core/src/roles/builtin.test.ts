import { createHash } from 'node:crypto';
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

describe('builtin role texts are byte-identical (T8c goldens, recorded on f96965f0 before any T8c edit)', () => {
  const sha = (text: string): string => `${Buffer.byteLength(text, 'utf8')} ${createHash('sha256').update(text).digest('hex')}`;
  const GOLDEN: Record<string, { prompt: string; description: string }> = {
    'builtin:feature-lead': { prompt: '1943 7c690d70aef9d691792d8e2f44f9fbe1c836bfa21d909b4818c83b8214c04039', description: '150 9086bbeb7bb50ae4661205f1cd00656473422e1bc7320d4a4a726f445f290c18' },
    'builtin:planner': { prompt: '756 59aac1666d464b8a9fae747ee002b5f1cb1fcbb2782535eb72a18d9d91ef41c4', description: '107 2739fd487d50482ba2d415abe20a7eb80bfb5b81c75a20d4ec191d217b604527' },
    'builtin:architect': { prompt: '666 5508ed0f08071505291947844bf3d8371f9257c1c514cd21f9a7b4a510dd3c8a', description: '103 28f510bc82eb2653f45c5dc2c44ef02dc28012dafd8433a3e68a98ff1c54e7dd' },
    'builtin:critic': { prompt: '658 937a81aae999eeed67892125a6280f136498cf47d6bfe0977d9992646316eaf1', description: '109 1992e3010345893c6e6563bb6d8204c66d2e95ab2f07fe64914bdb53d3576313' },
    'builtin:executor': { prompt: '594 72424ce681ba17560fa54011ec95640201babfca4b5dbb4d053f9a0401d17664', description: '107 8844fceb76cb038073ce67037d8bf41132768bc9ca79c8ec38790a6153033574' },
    'builtin:reviewer': { prompt: '708 9482cdb036e2acfe5d85cc3e30aad956744fab871ecc55de53c374d812969cfe', description: '117 261bbbfdc70d2daf9944dcb93736ac81baffba43f8fcea081cdc030279159a82' },
    'builtin:verifier': { prompt: '759 b74494ca5a0d4e6a1d0d6f2d222f4ae87cb6bce8196c242c8bade6f7c7d93fdc', description: '108 a8bc2508e77f189e4ced229d8d092a4c819696830e49abcfbbd0a53d71bace95' },
    'builtin:debugger': { prompt: '677 d4ca615a4e3acd9893c6038fba27de992d59b39be101c1089cb7f6ea81f448b2', description: '95 ef4980a1464433d6475d9366f28630438e4b39382038a31c3365d40ac390b975' },
    'builtin:researcher': { prompt: '636 b5bf36eadd495d187a942f4e9ea504a9f962722b5cd28e850830c52583cd482a', description: '103 58af7a92b3e22caf0cccdfcbd724ef0cb55580c0d13d59d45c5c89e3060b4a23' },
  };

  it('every prompt and description is exactly what the base produced, and no role was added or removed', () => {
    expect(BUILTIN_ROLES.map((role) => role.id)).toEqual(Object.keys(GOLDEN));
    for (const role of BUILTIN_ROLES) expect({ prompt: sha(role.prompt), description: sha(role.description) }, role.id).toEqual(GOLDEN[role.id]);
  });
});
