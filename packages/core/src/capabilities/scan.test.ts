import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    const skills = Object.fromEntries(caps.skills.map((s) => [s.name, s]));
    expect(Object.keys(skills).sort()).toEqual(['alpha', 'beta', 'gamma', 'git:sync', 'ship', 'tools:lint']);
    expect(skills.alpha).toMatchObject({ source: 'user', description: 'A skill' });
    expect(skills.beta).toMatchObject({ source: 'project', description: 'B skill' });
    expect(skills.gamma).toMatchObject({ source: 'project', description: null });
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
      { name: 'plain', description: null, source: 'user', path: path.join(home, '.claude/skills/plain') },
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
    await symlink(path.join(root, 'outside/evil'), path.join(skills, 'evil'));
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toEqual([]);
  });

  it('дубли: project побеждает user, user побеждает plugin', async () => {
    await put(path.join(home, '.claude/skills/dup/SKILL.md'), '---\ndescription: user\n---\n');
    await put(path.join(project, '.claude/skills/dup/SKILL.md'), '---\ndescription: project\n---\n');
    await put(path.join(home, '.claude/agents/a.md'), '---\ndescription: user\n---\n');
    await put(path.join(home, '.claude/plugins/cache/m/p/1/agents/a.md'), '---\nname: a\ndescription: plugin\n---\n');
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills).toHaveLength(1);
    expect(caps.skills[0]).toMatchObject({ source: 'project', description: 'project' });
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
    const caps = await scanClaudeCapabilities({ home, projectPath: project });
    expect(caps.skills.length).toBe(500);
  });
});
