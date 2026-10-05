import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_SKILL_BUDGET_ENV, CODEX_SKILL_CATALOG_OVERRIDE, claudeSkillReduction, claudeSkillRoute, findJevPluginIds } from './skill-reduction.js';

let root = '';
let config = '';
let cwd = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-reduction-'));
  config = path.join(root, 'config');
  cwd = path.join(root, 'project');
  await mkdir(config, { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await chmod(path.join(config, 'skills', 'locked', '.claude-plugin'), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function manifest(base: string, folder: string, text: string): Promise<void> {
  const dir = path.join(base, 'skills', folder, '.claude-plugin');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), text);
}

describe('константы сокращения', () => {
  it('бюджет Claude и флаг Codex — ровно те, что подтвердила проба 2026-10-05', () => {
    expect(CLAUDE_SKILL_BUDGET_ENV).toEqual({ SLASH_COMMAND_TOOL_CHAR_BUDGET: '1' });
    expect(CODEX_SKILL_CATALOG_OVERRIDE).toBe('skills.include_instructions=false');
  });
});

describe('findJevPluginIds', () => {
  it('нет ни папки скиллов, ни реестра — мод не установлен', async () => {
    expect(await findJevPluginIds(cwd, config)).toEqual([]);
  });

  it('плагин-папка с манифестом jev даёт id по месту установки; чужие плагины и обычные скиллы не считаются', async () => {
    await manifest(config, 'jev-skill-suggestion', '{"name":"jev-skill-suggestion","version":"0.1.0"}');
    await manifest(config, 'other', '{"name":"other-plugin"}');
    await mkdir(path.join(config, 'skills', 'plain-skill'), { recursive: true });
    await writeFile(path.join(config, 'skills', 'stray-file.md'), 'x');
    expect(await findJevPluginIds(cwd, config)).toEqual(['jev-skill-suggestion@skills-dir']);
  });

  it('имя берётся из манифеста, а не из папки; проектная установка тоже находится', async () => {
    await manifest(config, 'my-copy', '{"name":"jev-skill-suggestion"}');
    expect(await findJevPluginIds(cwd, config)).toEqual(['jev-skill-suggestion@skills-dir']);
    await rm(path.join(config, 'skills'), { recursive: true });
    await manifest(path.join(cwd, '.claude'), 'jev-skill-suggestion', '{"name":"jev-skill-suggestion"}');
    expect(await findJevPluginIds(cwd, config)).toEqual(['jev-skill-suggestion@skills-dir']);
    await manifest(path.join(cwd, '.claude'), 'jev-copy', '{"name":"jev-skill-suggestion"}');
    expect(await findJevPluginIds(cwd, config)).toEqual(['jev-skill-suggestion@skills-dir']);
  });

  it('точные ключи реестра плагинов берутся как есть', async () => {
    await mkdir(path.join(config, 'plugins'), { recursive: true });
    await writeFile(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'jev-skill-suggestion@some-market': [{ installPath: '/x' }],
      'superpowers@market': [{ installPath: '/y' }],
    } }));
    expect(await findJevPluginIds(cwd, config)).toEqual(['jev-skill-suggestion@some-market']);
  });

  it('битый манифест не плагин, битый реестр — не сбой чтения', async () => {
    await manifest(config, 'broken', '{not json');
    await mkdir(path.join(config, 'plugins'), { recursive: true });
    await writeFile(path.join(config, 'plugins', 'installed_plugins.json'), '[[[');
    expect(await findJevPluginIds(cwd, config)).toEqual([]);
  });

  it('нечитаемое место установки — «неизвестно», а не «нет мода»', async () => {
    await manifest(config, 'locked', '{"name":"jev-skill-suggestion"}');
    await chmod(path.join(config, 'skills', 'locked', '.claude-plugin'), 0o000);
    expect(await findJevPluginIds(cwd, config)).toBeNull();
  });
});

describe('claudeSkillReduction', () => {
  const base = { nativeRole: false, mcpRoute: true, settingsFile: true };
  beforeEach(() => { claudeSkillRoute.catalogReady = true; });
  afterEach(() => { claudeSkillRoute.catalogReady = false; });

  it('боевого каталога Claude у find_skill нет (выключатель по умолчанию) — список полный', async () => {
    claudeSkillRoute.catalogReady = false;
    expect(await claudeSkillReduction({ ...base, cwd, configDir: config })).toEqual({ reduced: false });
  });

  it('путь подтверждён и мода нет — сокращаем, выключать нечего', async () => {
    expect(await claudeSkillReduction({ ...base, cwd, configDir: config })).toEqual({ reduced: true, disablePlugins: [] });
  });

  it('мод установлен и есть файл настроек — выключаем его по точному id', async () => {
    await manifest(config, 'jev-skill-suggestion', '{"name":"jev-skill-suggestion"}');
    expect(await claudeSkillReduction({ ...base, cwd, configDir: config })).toEqual({
      reduced: true,
      disablePlugins: ['jev-skill-suggestion@skills-dir'],
    });
  });

  it.each([
    ['нативная роль', { nativeRole: true }],
    ['нет сервера parley в шаблоне', { mcpRoute: false }],
  ])('%s — список остаётся полным', async (_name, override) => {
    expect(await claudeSkillReduction({ ...base, ...override, cwd, configDir: config })).toEqual({ reduced: false });
  });

  it('мод установлен, а файла настроек нет — выключить его нечем, список полный', async () => {
    await manifest(config, 'jev-skill-suggestion', '{"name":"jev-skill-suggestion"}');
    expect(await claudeSkillReduction({ ...base, settingsFile: false, cwd, configDir: config })).toEqual({ reduced: false });
  });

  it('место установки не прочитать — список полный', async () => {
    await manifest(config, 'locked', '{"name":"x"}');
    await chmod(path.join(config, 'skills', 'locked', '.claude-plugin'), 0o000);
    expect(await claudeSkillReduction({ ...base, cwd, configDir: config })).toEqual({ reduced: false });
  });
});
