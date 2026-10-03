import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectCodexSkillContext, readCodexSkillCatalog } from './context.js';
let root: string;
let cwd: string;
let home: string;
let document: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-native-skill-context-'));
  cwd = path.join(root, 'project'); home = path.join(root, 'home');
  await mkdir(path.join(cwd, '.codex/skills/review/agents'), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(cwd, '.codex/skills/review/SKILL.md'), '---\nname: review\ndescription: Review code quality\n---\n');
  cwd = await realpath(cwd); home = await realpath(home);
  document = path.join(cwd, '.codex/skills/review/SKILL.md');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function response() {
  return { config: { layers: [
    { name: { type: 'sessionFlags' }, version: 'flag', config: {} },
    { name: { type: 'project', dotCodexFolder: path.join(cwd, '.codex') }, version: 'project', config: {} },
    { name: { type: 'user', file: path.join(home, '.codex/config.toml') }, version: 'user', config: {} },
  ] }, requirements: { requirements: null }, skills: { data: [{ cwd, errors: [], skills: [
    { name: 'review', path: document, scope: 'repo', enabled: true, pluginId: null },
  ] }] } };
}
describe('native skill context projection', () => {
  it('projects low-to-high human policy without raw config and intersects a native project document', async () => {
    const native = response();
    native.config.layers[2]!.config = { secret: 'DO_NOT_PROJECT' };
    const projected = await projectCodexSkillContext(cwd, native);
    expect(projected?.layers.map(layer => layer.source)).toEqual(['User', 'Project', 'SessionFlags']);
    expect(JSON.stringify(projected)).not.toContain('DO_NOT_PROJECT');
    const catalog = await readCodexSkillCatalog({ cwd, homeDir: home, read: async () => native });
    expect(catalog?.skills.find(skill => skill.path === document)).toMatchObject({ name: 'review', modelAvailable: true, source: 'project' });
  });
  it('rejects unknown requirements, foreign cwd, profile, errors and conflicting duplicate identities', async () => {
    const native = response();
    const cases = [
      { ...native, requirements: {} }, { ...native, requirements: { requirements: {} } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, cwd: home }] } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, errors: [{ message: 'SECRET' }] }] } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, skills: [...native.skills.data[0]!.skills, { ...native.skills.data[0]!.skills[0]!, enabled: false }] }] } },
      { ...native, config: { layers: [{ name: { type: 'user', file: '/tmp/config.toml', profile: 'named' }, config: {}, version: 'v' }] } },
      { ...native, config: { layers: [{ name: { type: 'enterpriseManaged' }, config: {}, version: 'v' }] } },
    ];
    for (const value of cases) expect(await projectCodexSkillContext(cwd, value)).toBeNull();
  });
  it('retains human User disable selectors even when the native layer is disabled', async () => {
    const native = response();
    const disabledUser = { ...native.config.layers[2]!, disabledReason: 'disabled native source',
      config: { skills: { config: [{ name: 'review', enabled: false }] } } };
    native.config.layers[2] = disabledUser;
    const found = await readCodexSkillCatalog({ cwd, homeDir: home, read: async () => native });
    expect(found?.skills.find(skill => skill.path === document)?.unavailableReason).toBe('human-disabled');
  });
  it('does not promote plugin identity, even when its native scope is repo', async () => {
    const native = response();
    const value = { ...native, skills: { data: [{ ...native.skills.data[0]!, skills: [{ ...native.skills.data[0]!.skills[0]!, pluginId: 'plugin@example' }] }] } };
    expect((await projectCodexSkillContext(cwd, value))?.evidence.skills).toEqual([]);
  });
  it('keeps SessionFlags human disable and manual-only policy stronger than native enabled', async () => {
    const native = response();
    native.config.layers[0]!.config = { skills: { config: [{ name: 'review', enabled: false }] } };
    expect((await readCodexSkillCatalog({ cwd, homeDir: home, read: async () => native }))?.skills[0]?.modelAvailable).toBe(false);
    native.config.layers[0]!.config = {};
    await writeFile(path.join(cwd, '.codex/skills/review/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    expect((await readCodexSkillCatalog({ cwd, homeDir: home, read: async () => native }))?.skills[0]?.unavailableReason).toBe('implicit-invocation-disabled');
  });
});
