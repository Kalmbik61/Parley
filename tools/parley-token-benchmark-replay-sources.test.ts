// T9a harness, slice H5a: the sources judged at launch planning (recipes, skills), each arm planned in its own scratch.
import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPES } from '../packages/core/src/recipes/builtin.js';
import { readLaunchSources } from './parley-token-benchmark-replay-sources.js';

const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
const T = 300_000;

describe('readLaunchSources: the shipped recipes and the skill catalogue file, as each arm\'s launch plans them', () => {
  it('the real product leaves both unchanged: every playbook sits verbatim in both layers, and the catalogue file is the same', async () => {
    const s = await readLaunchSources(FIVE);
    for (const recipe of BUILTIN_RECIPES) {
      expect(s.recipes.classic).toContain(`${recipe.id}\n${recipe.playbook}`);
      expect(s.recipes.replacement).toContain(`${recipe.id}\n${recipe.playbook}`);
    }
    expect(s.recipes.classic).toBe(s.recipes.replacement);
    expect(s.skills.classic).toContain('amber-reader');
    expect(s.skills.classic).toContain('plan-checker');
    expect(s.skills.classic).toBe(s.skills.replacement);
    expect(s.where.recipes).toContain('scratch of its own per arm');
  }, T);
  it('one changed byte of one playbook on the replacement arm only makes the recipes differ, and only there', async () => {
    const first = BUILTIN_RECIPES[0]!;
    const s = await readLaunchSources(FIVE, { mutate: { arm: 'replacement', edit: (plan) => ({ ...plan, args: plan.args.map((a) => a.replace(first.playbook.slice(0, 30), `${first.playbook.slice(0, 29)}X`)) }) } });
    expect(s.recipes.classic).not.toBe(s.recipes.replacement);
    expect(s.recipes.classic).toContain(`${first.id}\n${first.playbook}`);
    expect(s.recipes.replacement).toContain(`${first.id}\n---`.slice(0, first.id.length + 1) );
    expect(s.recipes.replacement).not.toContain(`${first.id}\n${first.playbook}`);
    expect(s.skills.classic).toBe(s.skills.replacement);
  }, T);
  it('a skill file that cannot be read is an empty source, which the criterion fails by name', async () => {
    const s = await readLaunchSources(FIVE, { mutate: { arm: 'replacement', edit: (plan) => ({ ...plan, env: { ...plan.env, PARLEY_NATIVE_CONTEXT_REVISION: '00000000-0000-0000-0000-000000000000' } }) } });
    expect(s.skills.classic).not.toBe('');
    expect(s.skills.replacement).toBe('');
  }, T);
  it('the same arm planned twice gives the same sources: nothing in them is per launch', async () => {
    const a = await readLaunchSources(FIVE);
    const b = await readLaunchSources(FIVE);
    expect(b).toEqual(a);
  }, T);
});
