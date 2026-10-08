import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSkillCatalog } from './catalog.js';
import { searchSkills } from './search.js';

let root: string;
let cwd: string;
let homeDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-catalog-'));
  cwd = path.join(root, 'participant');
  homeDir = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(homeDir)]);
});
afterEach(() => rm(root, { recursive: true, force: true }));
async function put(file: string, text: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return realpath(file);
}
const claude = () => ({
  provider: 'claude' as const, cwd, homeDir,
  nativeEvidence: { cwd, policyVerified: true, loadToolAvailable: true },
});

describe('shared skill catalog', () => {
  it('retains full multiline and hidden metadata for the panel, while search excludes it', async () => {
    const file = await put(path.join(cwd, '.claude/skills/review/SKILL.md'),
      '---\ndescription: |\n  Review code\n  with full context\ndisable-model-invocation: true\n---\nPRIVATE_BODY');
    const catalog = await resolveSkillCatalog(claude());
    expect(catalog).toMatchObject({ provider: 'claude', partial: false, diagnostics: [] });
    expect(catalog.skills).toEqual([{
      provider: 'claude', documentKind: 'skill', name: 'review',
      description: 'Review code\nwith full context\n', source: 'project', path: file,
      modelAvailable: false, unavailableReason: 'disable-model-invocation',
    }]);
    expect(searchSkills(catalog.skills, 'review')).toEqual([]);
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_BODY');
  });

  it('never guesses native evidence from files or another cwd', async () => {
    await put(path.join(cwd, '.claude/skills/review/SKILL.md'), '---\ndescription: Review code\n---\n');
    for (const nativeEvidence of [undefined, { cwd: homeDir, policyVerified: true, loadToolAvailable: true }]) {
      const catalog = await resolveSkillCatalog({ provider: 'claude', cwd, homeDir,
        ...(nativeEvidence ? { nativeEvidence } : {}),
      });
      expect(catalog.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
      expect(searchSkills(catalog.skills, 'review')).toEqual([]);
    }
  });

  it('retains the native winner and its shadowed record without name-based catalog dedupe', async () => {
    const user = await put(path.join(homeDir, '.claude/skills/review/SKILL.md'), '---\ndescription: User review\n---\n');
    await put(path.join(cwd, '.claude/skills/review/SKILL.md'), '---\ndescription: Project review\n---\n');
    const catalog = await resolveSkillCatalog(claude());
    expect(catalog.skills).toHaveLength(2);
    expect(catalog.skills.find(skill => skill.source === 'project')?.unavailableReason).toBe('shadowed');
    expect(searchSkills(catalog.skills, 'review').map(match => match.skill.path)).toEqual([user]);
  });

  it('keeps Codex same-name files and source labels, deduplicating only canonical aliases', async () => {
    const base = path.join(root, 'injected');
    const first = await put(path.join(base, 'a/SKILL.md'), '---\nname: review\ndescription: Review code\n---\n');
    await symlink(path.join(base, 'a'), path.join(base, 'alias'));
    const second = await put(path.join(root, 'extra/b/SKILL.md'), '---\nname: review\ndescription: Review code\n---\n');
    const catalog = await resolveSkillCatalog({ provider: 'codex', cwd, homeDir, configLayers: [], roots: [
      { path: base, source: 'user', verified: true },
      { path: path.join(root, 'extra'), source: 'extra' },
    ] });
    expect(catalog.skills.map(skill => skill.path).sort()).toEqual([first, second].sort());
    expect(catalog.skills.every(skill => skill.documentKind === 'skill')).toBe(true);
    expect(catalog.skills.find(skill => skill.path === second)).toMatchObject({ source: 'extra', modelAvailable: false });
    expect(catalog.partial).toBe(true);
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ provider: 'codex', code: 'availability-unverified' }));
    expect(searchSkills(catalog.skills, 'review').map(match => match.skill.path)).toEqual([first]);
  });

  it('preserves injected Codex human disables', async () => {
    const base = path.join(root, 'injected');
    await put(path.join(base, 'review/SKILL.md'), '---\nname: review\ndescription: Review code\n---\n');
    const catalog = await resolveSkillCatalog({ provider: 'codex', cwd, homeDir, roots: [{ path: base, source: 'user', verified: true }],
      configLayers: [{ source: 'User', data: { skills: { config: [{ name: 'review', enabled: false }] } } }],
    });
    expect(catalog.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'human-disabled' });
    expect(searchSkills(catalog.skills, 'review')).toEqual([]);
  });

  it('preserves native synced source labels for a verified active account', async () => {
    const file = await put(path.join(homeDir, '.claude/skills/synced/account/review/SKILL.md'), '---\ndescription: Account review\n---\n');
    const catalog = await resolveSkillCatalog({ ...claude(), nativeEvidence: {
      cwd, policyVerified: true, loadToolAvailable: true,
      synced: { account: 'account', accountVerified: true, manifestVerified: true,
        skills: [{ name: 'anthropic-skills:review', path: file }] },
    } });
    expect(catalog.skills).toEqual([{
      provider: 'claude', documentKind: 'skill', name: 'anthropic-skills:review',
      description: 'Account review', source: 'claude.ai', path: file,
      modelAvailable: true, unavailableReason: null,
    }]);
  });

  it('uses participant cwd rather than the main project for project sources', async () => {
    const leader = path.join(root, 'leader');
    await put(path.join(leader, '.claude/skills/leader/SKILL.md'), '---\ndescription: Leader skill\n---\n');
    await put(path.join(cwd, '.claude/skills/participant/SKILL.md'), '---\ndescription: Participant skill\n---\n');
    expect((await resolveSkillCatalog(claude())).skills.map(skill => skill.name)).toEqual(['participant']);
  });

  it.each(['claude', 'codex'] as const)('missing %s cwd returns an explicit empty partial result', async provider => {
    await put(path.join(homeDir, '.claude/skills/user/SKILL.md'), '---\ndescription: User skill\n---\n');
    await put(path.join(homeDir, '.agents/skills/user/SKILL.md'), '---\nname: user\ndescription: User skill\n---\n');
    const missing = path.join(cwd, 'removed');
    const catalog = await resolveSkillCatalog({ provider, cwd: missing, homeDir });
    expect(catalog).toEqual({ provider, skills: [], partial: true,
      diagnostics: [{ provider, code: 'missing-context', path: missing }],
    });
  });

  it('passes safe diagnostics and partial status without parser excerpts or body', async () => {
    await put(path.join(cwd, '.claude/skills/broken/SKILL.md'), '---\ndescription: [PRIVATE_BROKEN_SOURCE\n---\n');
    const catalog = await resolveSkillCatalog(claude());
    expect(catalog.skills).toEqual([]);
    expect(catalog.partial).toBe(true);
    expect(catalog.diagnostics[0]).toMatchObject({ provider: 'claude', code: 'invalid-yaml' });
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_BROKEN_SOURCE');
  });
});
