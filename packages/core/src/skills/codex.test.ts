import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexSkills } from './codex.js';

let root: string;
let cwd: string;
let homeDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-codex-skills-'));
  cwd = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(homeDir)]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(file: string, text: string | Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return realpath(file);
}
async function skill(base: string, folder: string, name = folder, description = 'A skill'): Promise<string> {
  return put(path.join(base, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBODY_NOT_METADATA\n`);
}
function injected(base: string, source: 'user' | 'project' | 'system' | 'admin' | 'plugin' | 'extra' = 'user') {
  return { cwd, homeDir, roots: [{ path: base, source, verified: true }], configLayers: [] };
}

describe('Codex native discovery', () => {
  it('discovers injected home, legacy and root-to-cwd sources without collapsing same names', async () => {
    await put(path.join(cwd, '.native-root'), '');
    const nested = path.join(cwd, 'nested'); await mkdir(nested);
    const files = await Promise.all([
      skill(path.join(homeDir, '.agents/skills'), 'user', 'duplicate'),
      skill(path.join(homeDir, '.codex/skills'), 'legacy', 'duplicate'),
      skill(path.join(cwd, '.agents/skills'), 'project', 'duplicate'),
      skill(path.join(nested, '.agents/skills'), 'nested', 'duplicate'),
    ]);
    const result = await discoverCodexSkills({ cwd: nested, homeDir, projectRootMarkers: ['.native-root'] });
    expect(result.skills.map(s => s.path).sort()).toEqual(files.sort());
    expect(result.skills.every(s => s.name === 'duplicate' && s.modelAvailable)).toBe(true);
    expect(result.partial).toBe(false);
  });

  it('uses CODEX_HOME and keeps source-backed system/config-folder roots unverified', async () => {
    const codexHome = path.join(root, 'custom-codex');
    const known = await skill(path.join(codexHome, 'skills'), 'legacy');
    const bundled = await skill(path.join(codexHome, 'skills/.system'), 'bundled');
    const project = await skill(path.join(cwd, '.codex/skills'), 'old-project');
    const result = await discoverCodexSkills({ cwd, homeDir, codexHome });
    expect(result.skills.find(s => s.path === known)?.modelAvailable).toBe(true);
    for (const file of [bundled, project]) expect(result.skills.find(s => s.path === file)).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
    expect(result.partial).toBe(true);
  });

  it('does not scan ancestors above the nearest native marker or substitute missing cwd', async () => {
    await put(path.join(cwd, '.git'), 'gitdir: synthetic');
    await skill(path.join(root, '.agents/skills'), 'outside');
    await skill(path.join(cwd, '.agents/skills'), 'inside');
    const result = await discoverCodexSkills({ cwd, homeDir });
    expect(result.skills.map(s => s.name)).toEqual(['inside']);
    const missing = await discoverCodexSkills({ cwd: path.join(cwd, 'removed'), homeDir });
    expect(missing.skills).toEqual([]);
    expect(missing).toMatchObject({ partial: true, diagnostics: [{ code: 'unreadable', provider: 'codex', source: 'project' }] });
  });

  it('uses non-project marker rules and ignores project marker overrides', async () => {
    await put(path.join(root, '.native'), '');
    await skill(path.join(root, '.agents/skills'), 'ancestor');
    const result = await discoverCodexSkills({ cwd, homeDir, configLayers: [
      { source: 'User', data: { project_root_markers: ['.native'] } },
      { source: 'Project', data: { project_root_markers: [] } },
    ] });
    expect(result.skills.map(s => s.name)).toEqual(['ancestor']);
  });

  it('keeps unrelated verified entries available when a supplied source is unverified', async () => {
    const known = path.join(root, 'known'); const unknown = path.join(root, 'unknown');
    await skill(known, 'known'); await skill(unknown, 'unknown');
    const result = await discoverCodexSkills({ cwd, homeDir, configLayers: [], roots: [
      { path: known, source: 'user', verified: true }, { path: unknown, source: 'extra' },
    ] });
    expect(result.skills.find(s => s.name === 'known')?.modelAvailable).toBe(true);
    expect(result.skills.find(s => s.name === 'unknown')).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
    expect(result.partial).toBe(true);
  });

  it('reads full multiline descriptions without exporting the Markdown body', async () => {
    const base = path.join(root, 'skills');
    await put(path.join(base, 'multi/SKILL.md'), '---\nname: multi\ndescription: |\n  first line\n  last Ж line\n---\nBODY_NOT_METADATA: [invalid YAML\n');
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills[0]).toMatchObject({ description: 'first line\nlast Ж line\n', modelAvailable: true });
    expect(JSON.stringify(result)).not.toContain('BODY_NOT_METADATA');
  });

  it('retains invalid descriptions as unavailable but rejects unsafe/unknown names', async () => {
    const base = path.join(root, 'skills');
    await put(path.join(base, 'missing/SKILL.md'), '---\nname: missing\n---\n');
    await put(path.join(base, 'array/SKILL.md'), '---\nname: array\ndescription: [one, two]\n---\n');
    await put(path.join(base, 'invalid/SKILL.md'), '---\nname: [secret_name]\ndescription: okay\n---\n');
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills.map(s => s.name)).toEqual(['array', 'missing']);
    expect(result.skills.every(s => s.description === '' && s.unavailableReason === 'invalid-metadata' && !s.modelAvailable)).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'invalid-name')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret_name');
  });

  it('uses the native canonical directory fallback only for absent name', async () => {
    const base = path.join(root, 'skills');
    await put(path.join(base, 'fallback/SKILL.md'), '---\ndescription: Native fallback\n---\n');
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills[0]).toMatchObject({ name: 'fallback', modelAvailable: true });
  });

  it('enforces whole-file 65536 bytes and reports invalid UTF-8/YAML without excerpts', async () => {
    const base = path.join(root, 'skills'); const header = '---\nname: boundary\ndescription: valid\n---\n';
    await put(path.join(base, 'boundary/SKILL.md'), header + 'x'.repeat(65536 - Buffer.byteLength(header)));
    await put(path.join(base, 'big/SKILL.md'), header + 'x'.repeat(65537 - Buffer.byteLength(header)));
    await put(path.join(base, 'bad-yaml/SKILL.md'), '---\nname: [SYNTHETIC_SECRET\n---\n');
    await put(path.join(base, 'bad-utf8/SKILL.md'), Buffer.from([0xff]));
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills.map(s => s.name)).toEqual(['boundary']);
    expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['file-too-large', 'invalid-yaml', 'invalid-utf8']));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });
});

describe('ordered human configuration and policy', () => {
  it('applies User and human SessionFlags in order, ignoring Project and Parley suppression', async () => {
    const base = path.join(root, 'skills'); const first = await skill(base, 'one', 'same'); const second = await skill(base, 'two', 'same');
    const result = await discoverCodexSkills({ ...injected(base), configLayers: [
      { source: 'User', disabled: true, data: { skills: { config: [{ name: 'same', enabled: false }] } } },
      { source: 'Project', data: { skills: { config: [{ name: 'same', enabled: true }] } } },
      { source: 'SessionFlags', data: { skills: { config: [{ path: first, enabled: true }] } } },
      { source: 'SessionFlags', provenance: 'parley', data: { skills: { config: [{ path: first, enabled: false }, { path: second, enabled: true }] } } },
    ] });
    expect(result.skills.find(s => s.path === first)?.modelAvailable).toBe(true);
    expect(result.skills.find(s => s.path === second)).toMatchObject({ modelAvailable: false, unavailableReason: 'human-disabled' });
  });

  it('replaces repeated selectors at their later position and canonicalises aliases', async () => {
    const base = path.join(root, 'skills'); const file = await skill(base, 'one', 'same');
    const alias = path.join(root, 'alias.md'); await symlink(file, alias);
    const result = await discoverCodexSkills({ ...injected(base), configLayers: [
      { source: 'User', data: { skills: { config: [{ path: alias, enabled: true }, { name: 'same', enabled: false }] } } },
      { source: 'SessionFlags', data: { skills: { config: [{ path: file, enabled: true }] } } },
    ] });
    expect(result.skills[0]?.modelAvailable).toBe(true);
    const directory = await discoverCodexSkills({ ...injected(base), configLayers: [
      { source: 'User', data: { skills: { config: [{ path: path.dirname(file), enabled: false }] } } },
    ] });
    expect(directory.skills[0]?.modelAvailable).toBe(true);
  });

  it('reads bounded TOML user rules without reading real global config', async () => {
    const codexHome = path.join(root, 'custom-codex');
    await skill(path.join(codexHome, 'skills'), 'human');
    await put(path.join(codexHome, 'config.toml'), '[[skills.config]]\nname="human"\nenabled=false\n');
    const result = await discoverCodexSkills({ cwd, homeDir, codexHome });
    expect(result.skills[0]).toMatchObject({ name: 'human', modelAvailable: false, unavailableReason: 'human-disabled' });
  });

  it('fails closed for invalid human selectors/boolean shapes without leaking config values', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    for (const config of [
      { skills: { config: 'SYNTHETIC_SECRET' } },
      { skills: { config: [{ name: 'one', enabled: 'false' }] } },
      { skills: { config: [{ name: 'one', path: '/tmp/SYNTHETIC_SECRET', enabled: true }] } },
    ]) {
      const result = await discoverCodexSkills({ ...injected(base), configLayers: [{ source: 'User', data: config }] });
      expect(result.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
      expect(result).toMatchObject({ partial: true });
      expect(result.diagnostics.some(d => d.code === 'invalid-policy')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
    }
  });

  it('reports invalid TOML with safe positions and closes unknown human rules', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    const config = await put(path.join(root, 'user.toml'), 'skills = [SYNTHETIC_SECRET\n');
    const result = await discoverCodexSkills({ ...injected(base), configLayers: [{ source: 'User', file: config }] });
    expect(result.skills[0]?.modelAvailable).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-toml', provider: 'codex', path: config }));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it('honours implicit policy veto even if a human selector enables the file', async () => {
    const base = path.join(root, 'skills'); const file = await skill(base, 'manual');
    await put(path.join(base, 'manual/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    const result = await discoverCodexSkills({ ...injected(base), configLayers: [{ source: 'User', data: { skills: { config: [{ path: file, enabled: true }] } } }] });
    expect(result.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'implicit-invocation-disabled' });
  });

  it('treats invalid policy as unknown instead of coercing strings or shapes', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    for (const yaml of ['policy:\n  allow_implicit_invocation: "false"\n', 'policy: [true]\n', 'policy:\n  allow_implicit_invocation: [SYNTHETIC_SECRET\n']) {
      await put(path.join(base, 'one/agents/openai.yaml'), yaml);
      const result = await discoverCodexSkills(injected(base));
      expect(result.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
      expect(result.diagnostics.some(d => d.code === 'invalid-policy')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
    }
  });
});

describe('bounded traversal and canonical identity', () => {
  it('deduplicates symlink aliases while retaining different same-name documents', async () => {
    const base = path.join(root, 'skills'); const first = await skill(base, 'first', 'same'); const second = await skill(base, 'second', 'same');
    await symlink(path.dirname(first), path.join(base, 'alias'));
    await symlink(base, path.join(root, 'root-alias'));
    const result = await discoverCodexSkills({ ...injected(base), roots: [
      { path: base, source: 'user', verified: true }, { path: path.join(root, 'root-alias'), source: 'project', verified: true },
    ] });
    expect(result.skills.map(s => s.path).sort()).toEqual([first, second].sort());
    expect(result.partial).toBe(false);
  });

  it('reports cycles/broken links as partial while keeping independent verified files', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'okay');
    await symlink(base, path.join(base, 'cycle'));
    await symlink(path.join(root, 'missing'), path.join(base, 'broken'));
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills[0]?.modelAvailable).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['symlink-cycle', 'unreadable']));
  });

  it('skips hidden directories and ignores system directory symlinks', async () => {
    const base = path.join(root, 'skills'); const target = path.join(root, 'target');
    await skill(base, '.hidden'); await skill(base, 'visible'); await skill(target, 'linked');
    await symlink(target, path.join(base, 'alias'));
    expect((await discoverCodexSkills(injected(base, 'system'))).skills.map(s => s.name)).toEqual(['visible']);
    expect((await discoverCodexSkills(injected(base, 'user'))).skills.map(s => s.name)).toEqual(['linked', 'visible']);
  });

  it('signals entry/directory/depth limits without traversing or silently reporting complete', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one'); await skill(base, 'two');
    for (const limits of [{ maxEntries: 1 }, { maxDirectories: 1 }, { maxDepth: 1 }]) {
      const result = await discoverCodexSkills({ ...injected(base), limits });
      expect(result.partial).toBe(true);
      expect(result.diagnostics.some(d => d.code === 'traversal-limit')).toBe(true);
    }
  });

  it('supports native direct-child plugin discovery only with explicit verified namespace/policy', async () => {
    const base = path.join(root, 'plugin'); await skill(base, 'direct'); await skill(base, 'nested/deep', 'deep');
    const result = await discoverCodexSkills({ ...injected(base), roots: [{ path: base, source: 'plugin', verified: true, namespace: 'fixture', discoveryMode: 'direct-children' }] });
    expect(result.skills.map(s => s.name)).toEqual(['fixture:direct']);
    expect(result.skills[0]?.modelAvailable).toBe(true);
    const unknown = await discoverCodexSkills({ ...injected(base), roots: [{ path: base, source: 'plugin' }] });
    expect(unknown.skills.every(s => !s.modelAvailable)).toBe(true);
    expect(unknown.partial).toBe(true);
  });

  it('handles non-directory roots as partial and keeps deterministic scope/name/path ordering', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'zeta'); await skill(base, 'alpha');
    const project = path.join(root, 'repo-skills'); await skill(project, 'repo');
    const bad = await put(path.join(root, 'not-directory'), 'SYNTHETIC_SECRET');
    const opts = { ...injected(base), roots: [
      { path: base, source: 'user' as const, verified: true }, { path: project, source: 'project' as const, verified: true }, { path: bad, source: 'extra' as const },
    ] };
    const first = await discoverCodexSkills(opts); const second = await discoverCodexSkills(opts);
    expect(first.skills.map(s => s.name)).toEqual(['repo', 'alpha', 'zeta']);
    expect(first).toEqual(second);
    expect(first.partial).toBe(true);
    expect(first.diagnostics.some(d => d.code === 'unreadable')).toBe(true);
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET');
  });
});

describe('source and configuration uncertainty', () => {
  it('does not interpret an explicitly missing human config as an empty snapshot', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    const result = await discoverCodexSkills({ ...injected(base), configLayers: [{ source: 'User', file: path.join(root, 'deleted.toml') }] });
    expect(result.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
    expect(result).toMatchObject({ partial: true });
    expect(result.diagnostics.some(d => d.code === 'unreadable')).toBe(true);
  });

  it('rejects explicitly null name instead of inventing the absent-name fallback', async () => {
    const base = path.join(root, 'skills');
    await put(path.join(base, 'one/SKILL.md'), '---\nname: null\ndescription: okay\n---\n');
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.some(d => d.code === 'invalid-name')).toBe(true);
  });

  it('uses native high-to-low User folders and retains canonical file provenance', async () => {
    const lower = path.join(root, 'lower'); const higher = path.join(root, 'higher');
    await skill(path.join(lower, 'skills'), 'one'); const high = await skill(path.join(higher, 'skills'), 'one');
    const result = await discoverCodexSkills({ cwd, homeDir, configLayers: [
      { source: 'User', configFolder: lower, data: {} },
      { source: 'User', configFolder: higher, data: {} },
    ] });
    expect(result.skills.map(s => s.path)).toContain(high);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.every(s => s.source === 'user' && s.modelAvailable)).toBe(true);
  });

  it('rejects supplied project markers that escape the ancestor directory', async () => {
    const result = await discoverCodexSkills({ cwd, homeDir, projectRootMarkers: ['../secret-marker'] });
    expect(result.skills).toEqual([]);
    expect(result).toMatchObject({ partial: true });
    expect(result.diagnostics.some(d => d.code === 'invalid-policy')).toBe(true);
  });

  it('reports root/ancestor bounds and does not guess a narrowed source tree', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    const roots = await discoverCodexSkills({ ...injected(base), roots: [
      { path: base, source: 'user', verified: true }, { path: path.join(root, 'other'), source: 'extra' },
    ], limits: { maxRoots: 1 } });
    expect(roots.partial).toBe(true);
    expect(roots.skills[0]?.modelAvailable).toBe(true);
    const ancestors = await discoverCodexSkills({ cwd, homeDir, projectRootMarkers: ['never-present'], limits: { maxAncestors: 1 } });
    expect(ancestors.skills).toEqual([]);
    expect(ancestors.diagnostics.some(d => d.code === 'traversal-limit')).toBe(true);
  });
});

describe('native plugin and policy boundaries', () => {
  it('does not advertise a direct-child plugin document that resolves outside its verified root', async () => {
    const plugin = path.join(root, 'plugin'); await mkdir(plugin);
    const outside = await skill(path.join(root, 'outside'), 'external');
    await symlink(path.dirname(outside), path.join(plugin, 'linked'));
    const result = await discoverCodexSkills({ ...injected(plugin), roots: [{ path: plugin, source: 'plugin', namespace: 'fixture', verified: true, discoveryMode: 'direct-children' }] });
    expect(result.skills).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it('reports unverified canonical root aliases without disabling a confirmed entry', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    const alias = path.join(root, 'alias'); await symlink(base, alias);
    const result = await discoverCodexSkills({ ...injected(base), roots: [
      { path: base, source: 'user', verified: true }, { path: alias, source: 'extra' },
    ] });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.modelAvailable).toBe(true);
    expect(result.partial).toBe(true);
  });

  it('keeps unsupported product policy unavailable without exposing policy values', async () => {
    const base = path.join(root, 'skills'); await skill(base, 'one');
    await put(path.join(base, 'one/agents/openai.yaml'), 'policy:\n  products: [SYNTHETIC_SECRET]\n');
    const result = await discoverCodexSkills(injected(base));
    expect(result.skills[0]).toMatchObject({ modelAvailable: false, unavailableReason: 'availability-unverified' });
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });
});
