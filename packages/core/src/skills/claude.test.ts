import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverClaudeSkills, type ClaudeDiscoveryOptions } from './claude.js';

let root: string;
let homeDir: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-claude-skills-'));
  homeDir = path.join(root, 'home');
  cwd = path.join(root, 'worktree');
  await mkdir(homeDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(file: string, text: string | Uint8Array): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
const options = (): ClaudeDiscoveryOptions => ({
  cwd,
  homeDir,
  nativeEvidence: { cwd, policyVerified: true, loadToolAvailable: true },
});

async function skill(
  directory: string,
  description = 'Valid description',
  extra = '',
): Promise<string> {
  return put(
    path.join(directory, 'SKILL.md'),
    `---\nname: decorative-name\ndescription: ${description}\n${extra}---\nSECRET_BODY\n`,
  );
}

describe('Claude native skill discovery', () => {
  it('preserves discovery kind independently of canonical filename and decorative YAML name', async () => {
    const target = await put(path.join(root, 'external/document.md'), '---\nname: display-only\ndescription: Review code\n---\n');
    const directory = path.join(cwd, '.claude/skills/review');
    await mkdir(directory, { recursive: true });
    await symlink(target, path.join(directory, 'SKILL.md'));
    const command = await put(path.join(cwd, '.claude/commands/SKILL.md'), '---\ndescription: Command file\n---\n');
    const awaitTarget = await realpath(target);
    const awaitCommand = await realpath(command);
    const result = await discoverClaudeSkills(options());
    expect(result.skills.find(skill => skill.path === awaitTarget)).toMatchObject({ documentKind: 'skill', name: 'review' });
    expect(result.skills.find(skill => skill.path === awaitCommand)).toMatchObject({ documentKind: 'command', name: 'SKILL' });
  });

  it.each([
    ['user', 'skill', 'SYNCED'],
    ['project', 'skill', 'synced'],
    ['user', 'skill', 'anthropic-skills'],
    ['project', 'skill', 'Anthropic-Skills:gate'],
    ['project', 'skill', 'anthropic-skills__gate'],
    ['user', 'skill', 'synced.'],
    ['project', 'command', 'anthropic-skills:gate'],
    ['user', 'command', 'anthropic-skills/nested'],
    ['project', 'command', 'safe/anthropic-skills/gate'],
  ])('rejects reserved account names in local %s %s: %s', async (source, kind, name) => {
    const base = source === 'user' ? path.join(homeDir, '.claude') : path.join(cwd, '.claude');
    if (kind === 'skill') await skill(path.join(base, 'skills', name));
    else
      await put(
        path.join(base, 'commands', name + '.md'),
        '---\ndescription: Local reserved command\n---\n',
      );
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it.each([
    'anthropic-skills:gate',
    'Ａnthropic-skills：gate',
    'anthropic–skills:gate',
    'anthropic-\u200bskills:gate',
  ])(
    'rejects a local reserved frontmatter name %s without globally filtering plugin/account sources',
    async (name) => {
      await put(
        path.join(cwd, '.claude/skills/ordinary/SKILL.md'),
        `---\nname: ${name}\ndescription: Reserved metadata\n---\n`,
      );
      expect((await discoverClaudeSkills(options())).skills).toEqual([]);
    },
  );

  it('preserves genuine reserved plugin namespaces and the allowed local synced command', async () => {
    const installPath = path.join(root, 'reserved-plugin');
    await put(path.join(installPath, '.claude-plugin/plugin.json'), '{"name":"anthropic-skills"}');
    await skill(path.join(installPath, 'skills/synced'));
    await put(
      path.join(cwd, '.claude/commands/synced.md'),
      '---\ndescription: Allowed command\n---\n',
    );
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: {
        ...options().nativeEvidence!,
        plugins: [
          {
            id: 'anthropic-skills@fixture',
            namespace: 'anthropic-skills',
            installPath,
            enabled: true,
            verified: true,
          },
        ],
      },
    });
    expect(result.skills.map((item) => [item.name, item.modelAvailable])).toEqual([
      ['anthropic-skills:synced', true],
      ['synced', true],
    ]);
  });

  it('uses the directory load name and the complete description with a canonical document path', async () => {
    const file = await skill(
      path.join(homeDir, '.claude/skills/native'),
      '|\n  first line\n  last line',
    );
    const result = await discoverClaudeSkills(options());
    expect(result).toEqual({
      skills: [
        {
          provider: 'claude',
          documentKind: 'skill',
          name: 'native',
          description: 'first line\nlast line\n',
          source: 'user',
          path: await realpath(file),
          modelAvailable: true,
          unavailableReason: null,
        },
      ],
      diagnostics: [],
      partial: false,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_BODY');
  });
});

describe('source context and native naming', () => {
  it('returns a complete empty catalog when confirmed optional roots are absent', async () => {
    expect(await discoverClaudeSkills(options())).toEqual({
      skills: [],
      diagnostics: [],
      partial: false,
    });
  });

  it('uses configDir and the participant cwd without reading the main checkout or .agents skills', async () => {
    const configDir = path.join(root, 'custom-config');
    await skill(path.join(homeDir, '.claude/skills/wrong-home'));
    await skill(path.join(root, 'main/.claude/skills/lead-only'));
    await skill(path.join(cwd, '.agents/skills/not-claude'));
    await skill(path.join(configDir, 'skills/custom-user'));
    await skill(path.join(cwd, '.claude/skills/participant'));
    const result = await discoverClaudeSkills({ ...options(), configDir });
    expect(result.skills.map((s) => s.name)).toEqual(['custom-user', 'participant']);
  });

  it('keeps the observed user winner and the shadowed project inventory', async () => {
    await skill(path.join(homeDir, '.claude/skills/collision'), 'User winner');
    await skill(path.join(cwd, '.claude/skills/collision'), 'Project loser');
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user',
          description: 'User winner',
          modelAvailable: true,
        }),
        expect.objectContaining({
          source: 'project',
          description: 'Project loser',
          modelAvailable: false,
          unavailableReason: 'shadowed',
        }),
      ]),
    );
    expect(result.partial).toBe(false);
  });

  it('includes commands with native nested names and records headerless commands as invalid metadata', async () => {
    await put(
      path.join(cwd, '.claude/commands/nested/run.md'),
      '---\ndescription: Command description\n---\nSECRET_BODY',
    );
    await put(path.join(cwd, '.claude/commands/body-only.md'), 'description: body is not metadata');
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'nested:run',
          modelAvailable: true,
          description: 'Command description',
        }),
        expect.objectContaining({
          name: 'body-only',
          modelAvailable: false,
          description: '',
          unavailableReason: 'invalid-metadata',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('SECRET_BODY');
  });

  it('marks unverified command/skill name collisions unavailable instead of guessing precedence', async () => {
    await skill(path.join(cwd, '.claude/skills/same'));
    await put(path.join(cwd, '.claude/commands/same.md'), '---\ndescription: Command\n---\n');
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toHaveLength(2);
    expect(
      result.skills.every(
        (s) => !s.modelAvailable && s.unavailableReason === 'availability-unverified',
      ),
    ).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ambiguous-name' })]),
    );
  });

  it('does not borrow evidence or local source files from another cwd', async () => {
    await skill(path.join(cwd, '.claude/skills/here'));
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { cwd: elsewhere, policyVerified: true, loadToolAvailable: true },
    });
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.partial).toBe(true);
    const missing = await discoverClaudeSkills({
      ...options(),
      cwd: path.join(root, 'deleted-worktree'),
    });
    expect(missing.skills).toEqual([]);
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'missing-context' })]),
    );
  });
});

describe('effective human settings and semantic metadata', () => {
  it('applies user/project/local/flag/managed precedence without losing unrelated overrides', async () => {
    for (const name of ['one', 'two', 'three', 'four', 'name-only'])
      await skill(path.join(cwd, '.claude/skills', name));
    await put(
      path.join(homeDir, '.claude/settings.json'),
      JSON.stringify({
        skillOverrides: { one: 'off', two: 'user-invocable-only', 'name-only': 'name-only' },
      }),
    );
    await put(
      path.join(cwd, '.claude/settings.json'),
      JSON.stringify({ skillOverrides: { one: 'on', three: 'off' } }),
    );
    await put(
      path.join(cwd, '.claude/settings.local.json'),
      JSON.stringify({ skillOverrides: { one: 'off' } }),
    );
    const result = await discoverClaudeSkills({
      ...options(),
      settings: {
        flag: { skillOverrides: { one: 'on', four: 'on' } },
        managed: { skillOverrides: { four: 'off' } },
      },
    });
    const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
    expect(byName.one).toMatchObject({ modelAvailable: true });
    expect(byName.two).toMatchObject({ unavailableReason: 'user-invocable-only' });
    expect(byName.three).toMatchObject({ unavailableReason: 'human-disabled' });
    expect(byName.four).toMatchObject({ unavailableReason: 'human-disabled' });
    expect(byName['name-only']).toMatchObject({
      modelAvailable: true,
      description: 'Valid description',
    });
  });

  it('retains missing/non-string descriptions as unavailable inventory with no coercion', async () => {
    await skill(path.join(cwd, '.claude/skills/no-description'), '[one, two]');
    await put(path.join(cwd, '.claude/skills/headerless/SKILL.md'), '# body');
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toHaveLength(2);
    expect(
      result.skills.every(
        (s) =>
          s.description === '' && s.unavailableReason === 'invalid-metadata' && !s.modelAvailable,
      ),
    ).toBe(true);
  });

  it('honors real disable-model-invocation and rejects string booleans without expanding access', async () => {
    await skill(
      path.join(cwd, '.claude/skills/manual'),
      'Manual',
      'disable-model-invocation: true\n',
    );
    await skill(
      path.join(cwd, '.claude/skills/wrong'),
      'Wrong',
      'disable-model-invocation: "false"\n',
    );
    const result = await discoverClaudeSkills(options());
    expect(result.skills.find((s) => s.name === 'manual')).toMatchObject({
      unavailableReason: 'disable-model-invocation',
    });
    expect(result.skills.find((s) => s.name === 'wrong')).toMatchObject({
      unavailableReason: 'invalid-metadata',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-policy' })]),
    );
  });

  it('does not guess native policy or role tool access', async () => {
    await skill(path.join(cwd, '.claude/skills/local'));
    const unknown = await discoverClaudeSkills({ cwd, homeDir });
    expect(unknown.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    const noTool = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { cwd, policyVerified: true, loadToolAvailable: false },
    });
    expect(noTool.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'load-tool-unavailable',
    });
  });

  it('treats malformed settings as unknown human restrictions with safe diagnostics', async () => {
    await skill(path.join(cwd, '.claude/skills/local'));
    await put(path.join(homeDir, '.claude/settings.json'), '{"secret":"TOP_SECRET",');
    const result = await discoverClaudeSkills(options());
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-json' })]),
    );
    expect(JSON.stringify(result)).not.toContain('TOP_SECRET');
    expect(result.partial).toBe(true);
  });

  it('rejects malformed override values instead of treating them as enabled', async () => {
    await skill(path.join(cwd, '.claude/skills/local'));
    const result = await discoverClaudeSkills({
      ...options(),
      settings: { flag: { skillOverrides: { local: false } } },
    });
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-settings' })]),
    );
  });
});

describe('native plugin and synced evidence', () => {
  async function plugin(name = 'fixture') {
    const installPath = path.join(root, 'plugins', name);
    await put(
      path.join(installPath, '.claude-plugin/plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
    await skill(path.join(installPath, 'skills/review'));
    return {
      id: name + '@fixture-market',
      namespace: name,
      installPath,
      enabled: true,
      verified: true,
    };
  }

  it('uses verified plugin namespaces and ignores ordinary skillOverrides for plugin skills', async () => {
    const nativePlugin = await plugin();
    const result = await discoverClaudeSkills({
      ...options(),
      settings: { flag: { skillOverrides: { 'fixture:review': 'off' } } },
      nativeEvidence: { ...options().nativeEvidence!, plugins: [nativePlugin] },
    });
    expect(result.skills[0]).toMatchObject({
      name: 'fixture:review',
      source: 'plugin',
      modelAvailable: true,
    });
  });

  it('applies effective enabledPlugins false while true cannot upgrade unverified plugin state', async () => {
    const nativePlugin = await plugin();
    const disabled = await discoverClaudeSkills({
      ...options(),
      settings: { local: { enabledPlugins: { [nativePlugin.id]: false } } },
      nativeEvidence: { ...options().nativeEvidence!, plugins: [nativePlugin] },
    });
    expect(disabled.skills[0]).toMatchObject({ unavailableReason: 'plugin-disabled' });
    const unknown = await discoverClaudeSkills({
      ...options(),
      settings: { flag: { enabledPlugins: { [nativePlugin.id]: true } } },
      nativeEvidence: {
        ...options().nativeEvidence!,
        plugins: [{ ...nativePlugin, verified: false }],
      },
    });
    expect(unknown.skills[0]).toMatchObject({ unavailableReason: 'availability-unverified' });
    expect(unknown.partial).toBe(true);
  });

  it('reads installed registry as unavailable inventory, not as effective enabled evidence', async () => {
    const nativePlugin = await plugin();
    await put(
      path.join(homeDir, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { [nativePlugin.id]: [{ scope: 'user', installPath: nativePlugin.installPath }] },
      }),
    );
    const result = await discoverClaudeSkills(options());
    expect(result.skills[0]).toMatchObject({
      name: 'fixture:review',
      source: 'plugin',
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.partial).toBe(true);
  });

  it('ignores arbitrary cache contents and excludes registry project entries for another cwd', async () => {
    await skill(path.join(homeDir, '.claude/plugins/cache/market/arbitrary/1.0.0/skills/cached'));
    const nativePlugin = await plugin();
    await put(
      path.join(homeDir, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [nativePlugin.id]: [
            {
              scope: 'project',
              projectPath: path.join(root, 'other'),
              installPath: nativePlugin.installPath,
            },
          ],
        },
      }),
    );
    expect((await discoverClaudeSkills(options())).skills).toEqual([]);
  });

  it('never reads plugin symlink documents outside the verified install root', async () => {
    const nativePlugin = await plugin();
    await rm(path.join(nativePlugin.installPath, 'skills/review'), { recursive: true });
    const outside = path.join(root, 'outside');
    await skill(outside);
    await symlink(outside, path.join(nativePlugin.installPath, 'skills/review'));
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, plugins: [nativePlugin] },
    });
    expect(result.skills).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'outside-source' })]),
    );
  });

  it('keeps missing plugin manifests unavailable even with stale positive evidence', async () => {
    const nativePlugin = await plugin();
    await rm(path.join(nativePlugin.installPath, '.claude-plugin'), { recursive: true });
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, plugins: [nativePlugin] },
    });
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.partial).toBe(true);
  });

  it('diagnoses conflicting verified plugin namespaces for the same canonical install path', async () => {
    const nativePlugin = await plugin();
    const alias = { ...nativePlugin, id: 'other@fixture-market', namespace: 'other' };
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, plugins: [nativePlugin, alias] },
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'alias-conflict' })]),
    );
  });

  it('does not advertise arbitrary synced folders or select an account by directory order', async () => {
    await skill(path.join(homeDir, '.claude/skills/synced/account/cloud'));
    await skill(path.join(cwd, '.claude/skills/local'));
    const result = await discoverClaudeSkills(options());
    expect(result.skills.map((s) => s.name)).toEqual(['local']);
    expect(result.skills[0]?.modelAvailable).toBe(true);
    expect(result.partial).toBe(true);
  });

  it('loads only supplied account/manifest entries and applies the syncClaudeAiSkills veto', async () => {
    const file = await skill(path.join(homeDir, '.claude/skills/synced/account/cloud'));
    await skill(path.join(homeDir, '.claude/skills/synced/other/other'));
    const nativeEvidence = {
      ...options().nativeEvidence!,
      synced: {
        account: 'account',
        accountVerified: true,
        manifestVerified: true,
        skills: [{ name: 'anthropic-skills:cloud', path: file }],
      },
    };
    const result = await discoverClaudeSkills({ ...options(), nativeEvidence });
    expect(result.skills.map((s) => [s.name, s.source, s.modelAvailable])).toEqual([
      ['anthropic-skills:cloud', 'claude.ai', true],
    ]);
    const disabled = await discoverClaudeSkills({
      ...options(),
      nativeEvidence,
      settings: { flag: { syncClaudeAiSkills: false } },
    });
    expect(disabled.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'human-disabled',
    });
  });

  it('rejects an active-account symlink into another account or outside the sync-owned root', async () => {
    const syncedRoot = path.join(homeDir, '.claude/skills/synced');
    const file = await skill(path.join(syncedRoot, 'other/cloud'));
    await symlink(path.join(syncedRoot, 'other'), path.join(syncedRoot, 'account'));
    const synced = {
      account: 'account',
      accountVerified: true,
      manifestVerified: true,
      skills: [{ name: 'anthropic-skills:cloud', path: file }],
    };
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, synced },
    });
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'outside-source' })]),
    );
  });

  it('keeps manifest entries unavailable when account evidence is unknown and rejects account escapes', async () => {
    const file = await skill(path.join(homeDir, '.claude/skills/synced/account/cloud'));
    const synced = {
      account: 'account',
      accountVerified: false,
      manifestVerified: true,
      skills: [{ name: 'anthropic-skills:cloud', path: file }],
    };
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, synced },
    });
    expect(result.skills[0]).toMatchObject({ unavailableReason: 'availability-unverified' });
    const escaped = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, synced: { ...synced, account: '../other' } },
    });
    expect(escaped.skills).toEqual([]);
    expect(escaped.partial).toBe(true);
  });
});

describe('canonical identity, bounded traversal and partial diagnostics', () => {
  it('deduplicates canonical documents without silently choosing a conflicting symlink load name', async () => {
    const directory = path.join(homeDir, '.claude/skills/original');
    await skill(directory);
    await symlink(directory, path.join(homeDir, '.claude/skills/alias'));
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'alias-conflict' })]),
    );
    expect(result.partial).toBe(true);
  });

  it('prevents command symlink cycles and diagnoses broken symlinks without losing valid independent entries', async () => {
    await put(path.join(cwd, '.claude/commands/good.md'), '---\ndescription: Good\n---\n');
    await symlink(path.join(cwd, '.claude/commands'), path.join(cwd, '.claude/commands/loop'));
    await symlink(path.join(root, 'missing'), path.join(cwd, '.claude/commands/broken.md'));
    const result = await discoverClaudeSkills(options());
    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'good', modelAvailable: true }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'symlink-cycle' }),
        expect.objectContaining({ code: 'unreadable' }),
      ]),
    );
    expect(result.partial).toBe(true);
  });

  it('distinguishes absent optional roots from unreadable roots while retaining other confirmed sources', async () => {
    await put(path.join(homeDir, '.claude/skills'), 'not a directory');
    await skill(path.join(cwd, '.claude/skills/good'));
    const result = await discoverClaudeSkills(options());
    expect(result.skills[0]).toMatchObject({ name: 'good', modelAvailable: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'user', code: 'unreadable' })]),
    );
    expect(result.partial).toBe(true);
  });

  it('keeps malformed/oversized documents out and safely reports invalid metadata', async () => {
    await put(
      path.join(cwd, '.claude/skills/broken/SKILL.md'),
      '---\ndescription: [TOP_SECRET\n---\n',
    );
    await put(
      path.join(cwd, '.claude/skills/oversized/SKILL.md'),
      '---\ndescription: Short\n---\n' + 'x'.repeat(65536),
    );
    await skill(path.join(cwd, '.claude/skills/good'));
    const result = await discoverClaudeSkills(options());
    expect(result.skills.map((s) => s.name)).toEqual(['good']);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-yaml' }),
        expect.objectContaining({ code: 'file-too-large' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('TOP_SECRET');
  });

  it('reports its directory/entry/depth safeguards as partial instead of claiming a native exhaustive list', async () => {
    for (const name of ['a', 'b', 'c']) await skill(path.join(cwd, '.claude/skills', name));
    const limited = await discoverClaudeSkills({ ...options(), limits: { maxEntries: 2 } });
    expect(limited.partial).toBe(true);
    expect(limited.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'discovery-limit' })]),
    );
    expect(limited.skills.every((s) => s.modelAvailable)).toBe(true);
    await put(
      path.join(cwd, '.claude/commands/nested/deeper/run.md'),
      '---\ndescription: Deep\n---\n',
    );
    const deep = await discoverClaudeSkills({ ...options(), limits: { maxCommandDepth: 1 } });
    expect(deep.skills.map((s) => s.name)).not.toContain('nested:deeper:run');
    expect(deep.partial).toBe(true);
  });
});

describe('additional integrity boundaries', () => {
  it('sorts repeated names by UTF-8 canonical paths, not UTF-16 locale order', async () => {
    const plugins = [];
    for (const directory of ['\ue000', '\u{10000}']) {
      const installPath = path.join(root, directory);
      await put(path.join(installPath, '.claude-plugin/plugin.json'), '{"name":"fixture"}');
      await skill(path.join(installPath, 'skills/review'));
      plugins.push({
        id: 'fixture@market',
        namespace: 'fixture',
        installPath,
        enabled: true,
        verified: true,
      });
    }
    const result = await discoverClaudeSkills({
      ...options(),
      nativeEvidence: { ...options().nativeEvidence!, plugins },
    });
    const actual = result.skills.map((s) => s.path);
    expect(actual).toEqual(
      [...actual].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
  });

  it('distinguishes invalid UTF-8 settings and does not silently restore availability', async () => {
    await skill(path.join(cwd, '.claude/skills/local'));
    await put(path.join(homeDir, '.claude/settings.json'), Buffer.from([0xc3, 0x28]));
    const result = await discoverClaudeSkills(options());
    expect(result.skills[0]).toMatchObject({
      modelAvailable: false,
      unavailableReason: 'availability-unverified',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-utf8' })]),
    );
  });

  it('reports its directory limit while keeping already verified documents available', async () => {
    await skill(path.join(cwd, '.claude/skills/local'));
    await put(path.join(cwd, '.claude/commands/command.md'), '---\ndescription: Command\n---\n');
    const result = await discoverClaudeSkills({ ...options(), limits: { maxDirectories: 1 } });
    expect(result.skills[0]).toMatchObject({ name: 'local', modelAvailable: true });
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'discovery-limit' })]),
    );
  });
});
