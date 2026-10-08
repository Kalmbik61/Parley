import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanClaudeCapabilities } from './scan.js';

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-caps-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('scanClaudeCapabilities', () => {
  it('preserves legacy directory/file paths from origin, including SKILL.md commands and aliases', async () => {
    const target = path.join(root, 'external/document.md');
    await put(target, '---\nname: decorative-name\ndescription: Review code\n---\n');
    await mkdir(path.join(project, '.claude/skills/review'), { recursive: true });
    await symlink(target, path.join(project, '.claude/skills/review/SKILL.md'));
    const command = path.join(project, '.claude/commands/SKILL.md');
    await put(command, '---\ndescription: Native command\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toEqual([
      { name: 'review', description: 'Review code', source: 'project', path: path.dirname(await realpath(target)) },
      { name: 'SKILL', description: 'Native command', source: 'project', path: await realpath(command) },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    const skillDirectory = caps.skills.find(skill => skill.name === 'review')!.path;
    const commandFile = caps.skills.find(skill => skill.name === 'SKILL')!.path;
    expect((await stat(skillDirectory)).isDirectory()).toBe(true);
    expect(await readFile(commandFile, 'utf8')).toBe('---\ndescription: Native command\n---\n');
    expect(Object.keys(caps).sort()).toEqual(['agents', 'commands', 'skills']);
    expect(Object.keys(caps.skills[0]!).sort()).toEqual(['description', 'name', 'path', 'source']);
  });

  it('reads full descriptions beyond the legacy agent head without indexing the body', async () => {
    const description = `Review code ${'long '.repeat(1000)}\nSecond line\n`;
    await put(path.join(project, '.claude/skills/review/SKILL.md'),
      `---\ndescription: |\n  ${description.trimEnd().replaceAll('\n', '\n  ')}\n---\nPRIVATE_BODY`);
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills[0]?.description).toBe(description);
    expect(JSON.stringify(caps)).not.toContain('PRIVATE_BODY');
  });

  it('retains disabled and unknown manual inventory instead of applying the model-search filter', async () => {
    for (const name of ['hidden', 'unknown'])
      await put(path.join(project, `.claude/skills/${name}/SKILL.md`), '---\ndescription: Review code\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project, settings: { flag: { skillOverrides: { hidden: 'off' } } } });
    expect(caps.skills.map(skill => skill.name)).toEqual(['hidden', 'unknown']);
  });

  it('forwards config directory and session snapshot while leaving wire source labels unchanged', async () => {
    const configDir = path.join(root, 'custom-config');
    await put(path.join(configDir, 'skills/user/SKILL.md'), '---\ndescription: User skill\n---\n');
    await put(path.join(configDir, 'commands/ship.md'), '---\ndescription: Ship command\n---\n');
    await put(path.join(configDir, 'agents/helper.md'), '---\ndescription: Helps\n---\n');
    const synced = path.join(configDir, 'skills/synced/account/review/SKILL.md');
    await put(synced, '---\ndescription: Account skill\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project, configDir,
      nativeEvidence: { cwd: project, policyVerified: true, loadToolAvailable: true,
        synced: { account: 'account', accountVerified: true, manifestVerified: true,
          skills: [{ name: 'anthropic-skills:review', path: synced }] },
      },
    });
    expect(caps.skills.map(skill => skill.name)).toEqual(['ship', 'user']);
    expect(caps.skills.every(skill => skill.source === 'user')).toBe(true);
    expect(caps.agents.map(agent => agent.name)).toEqual(['helper']);
  });

  it('resolves relative config roots from canonical participant cwd for skills, agents and plugin-agent containment', async () => {
    const configDir = path.join(project, 'session-config');
    await put(path.join(configDir, 'skills/review/SKILL.md'), '---\ndescription: Review code\n---\n');
    await put(path.join(configDir, 'agents/helper.md'), '---\nname: helper\ndescription: Helps\n---\n');
    const plugin = path.join(configDir, 'plugins/cache/market/tools/1');
    await put(path.join(plugin, 'agents/critic.md'), '---\nname: critic\ndescription: Critic\n---\n');
    const outside = path.join(root, 'outside.md');
    await put(outside, '---\nname: escape\ndescription: Outside plugin\n---\n');
    await symlink(outside, path.join(plugin, 'agents/escape.md'));
    const aliases = path.join(root, 'aliases');
    await mkdir(aliases);
    const alias = path.join(aliases, 'participant');
    await symlink(project, alias);
    // A lexical alias-parent root is a different source and must never substitute for cwd's root.
    await put(path.join(aliases, 'project/session-config/agents/decoy.md'), '---\nname: decoy\ndescription: Wrong root\n---\n');
    const canonicalConfig = await realpath(configDir);
    for (const participant of [project, alias]) {
      for (const configDir of ['session-config', '../project/session-config']) {
        const absolute = await scanClaudeCapabilities({ home, projectPath: participant, configDir: canonicalConfig });
        const relative = await scanClaudeCapabilities({ home, projectPath: participant, configDir });
        expect(relative).toEqual(absolute);
        expect(relative.skills.map(skill => skill.name)).toEqual(['review']);
        expect(relative.agents).toEqual([
          { name: 'helper', description: 'Helps', source: 'user', path: path.join(canonicalConfig, 'agents/helper.md') },
          { name: 'tools:critic', description: 'Critic', source: 'plugin', path: path.join(canonicalConfig, 'plugins/cache/market/tools/1/agents/critic.md') },
        ]);
      }
    }
  });

  it('keeps legacy command nesting at four directories and the agent 4096-byte head bound', async () => {
    await put(path.join(project, '.claude/commands/a/b/c/d/keep.md'), '---\ndescription: Kept\n---\n');
    await put(path.join(project, '.claude/commands/a/b/c/d/e/deep.md'), '---\ndescription: Too deep\n---\n');
    const header = '---\nname: helper\ndescription: Helps\n---\n';
    // The head ends inside a body scalar; a valid earlier YAML header must survive truncation.
    await put(path.join(project, '.claude/agents/helper.md'), header + 'a'.repeat(4096 - Buffer.byteLength(header) - 1) + 'Ж body');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills.map(skill => skill.name)).toEqual(['a:b:c:d:keep']);
    expect(caps.agents).toEqual([{ name: 'helper', description: 'Helps', source: 'project', path: path.join(project, '.claude/agents/helper.md') }]);
  });

  it('пустой дом и проект — только встроенные команды', async () => {
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toEqual([]);
    expect(caps.agents).toEqual([]);
    expect(caps.commands.length).toBeGreaterThan(0);
  });

  it('несуществующий проект — не ошибка', async () => {
    const caps = await scanClaudeCapabilities({ home: path.join(root, 'нет'), projectPath: path.join(root, 'нет2') });
    expect(caps.skills).toEqual([]);
  });

  it('все источники: скиллы, свои команды, субагенты, плагины', async () => {
    await put(path.join(home, '.claude/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: A skill\n---\n');
    await put(path.join(project, '.claude/skills/beta/SKILL.md'), '---\ndescription: B skill\n---\n');
    await put(path.join(project, '.agents/skills/gamma/SKILL.md'), '---\nname: gamma\n---\n');
    await put(path.join(home, '.claude/commands/ship.md'), '---\ndescription: Ship it\n---\n');
    await put(path.join(project, '.claude/commands/git/sync.md'), 'без шапки');
    await put(path.join(home, '.claude/agents/helper.md'), '---\nname: helper\ndescription: Helps\n---\n');
    await put(path.join(project, '.claude/agents/scout.md'), '---\ndescription: Scouts\n---\n');
    const plug = path.join(home, '.claude/plugins/cache/market/tools/1.0.0');
    await put(path.join(plug, 'skills/lint/SKILL.md'), '---\ndescription: Lints\n---\n');
    await put(path.join(plug, 'agents/critic.md'), '---\nname: critic\n---\n');
    await put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@market': [{ scope: 'user', installPath: plug }] } }));

    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    const skills = Object.fromEntries(caps.skills.map((s) => [s.name, s]));
    expect(Object.keys(skills).sort()).toEqual(['alpha', 'beta', 'git:sync', 'ship', 'tools:lint']);
    expect(skills.alpha).toMatchObject({ source: 'user', description: 'A skill' });
    expect(skills.beta).toMatchObject({ source: 'project', description: 'B skill' });
    // Unlinked .agents skills are not a Claude native source.
    expect(skills.gamma).toBeUndefined();
    expect(skills['git:sync']).toMatchObject({ source: 'project', description: null });
    expect(skills.ship).toMatchObject({ source: 'user', description: 'Ship it' });
    expect(skills['tools:lint']).toMatchObject({ source: 'plugin', description: 'Lints' });
    expect(caps.agents.map((a) => [a.name, a.source])).toEqual([
      ['helper', 'user'],
      ['scout', 'project'],
      ['tools:critic', 'plugin'],
    ]);
  });

  it('скилл без шапки получает имя папки', async () => {
    await put(path.join(home, '.claude/skills/plain/SKILL.md'), '# Plain\nтекст');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toEqual([
      { name: 'plain', description: null, source: 'user', path: await realpath(path.join(home, '.claude/skills/plain')) },
    ]);
  });

  it('папка скилла — симлинк (как .claude/skills/parley → .agents/skills/parley)', async () => {
    await put(path.join(project, '.agents/skills/parley/SKILL.md'), '---\ndescription: Linked\n---\n');
    await mkdir(path.join(project, '.claude/skills'), { recursive: true });
    await symlink(path.join(project, '.agents/skills/parley'), path.join(project, '.claude/skills/parley'));
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills.map((s) => s.name)).toEqual(['parley']);
    expect(caps.skills[0]?.description).toBe('Linked');
  });

  it('симлинк внутри плагина наружу не ведёт', async () => {
    await put(path.join(root, 'outside/evil/SKILL.md'), '---\ndescription: evil\n---\n');
    const skills = path.join(home, '.claude/plugins/cache/m/p/1/skills');
    await mkdir(skills, { recursive: true });
    await put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: path.dirname(skills) }] } }));
    await symlink(path.join(root, 'outside/evil'), path.join(skills, 'evil'));
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toEqual([]);
  });

  it('native skill collision keeps user; agent namespaces remain unchanged', async () => {
    await put(path.join(home, '.claude/skills/dup/SKILL.md'), '---\ndescription: user\n---\n');
    await put(path.join(project, '.claude/skills/dup/SKILL.md'), '---\ndescription: project\n---\n');
    await put(path.join(home, '.claude/agents/a.md'), '---\ndescription: user\n---\n');
    await put(path.join(home, '.claude/plugins/cache/m/p/1/agents/a.md'), '---\nname: a\ndescription: plugin\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toHaveLength(1);
    expect(caps.skills[0]).toMatchObject({ source: 'user', description: 'user' });
    // у плагина имя `p:a`, у человека `a` — разные записи.
    expect(caps.agents.map((a) => a.name)).toEqual(['a', 'p:a']);
  });

  it('списки отсортированы по имени', async () => {
    for (const n of ['zeta', 'alpha', 'mid']) await put(path.join(home, `.claude/skills/${n}/SKILL.md`), '');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('предел 500 записей', async () => {
    for (let i = 0; i < 520; i += 1) await put(path.join(home, `.claude/skills/s${i}/SKILL.md`), '');
    await put(path.join(project, '.claude/agents/scout.md'), '---\ndescription: Scout\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills.length + caps.agents.length).toBe(500);
    expect(caps.agents.map(agent => agent.name)).toEqual(['scout']);
  });
});
