import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_SKILL_BUDGET_ENV, CODEX_SKILL_CATALOG_OVERRIDE, CODEX_SKILL_CATALOG_TTL_MS, claudeSkillReduction, claudeSkillRoute, codexSkillRoute, findJevPluginIds, resetCodexSkillCatalogCache } from './skill-reduction.js';

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
  afterEach(() => { claudeSkillRoute.catalogReady = true; });

  it('каталог Claude у find_skill есть: выключатель по умолчанию включён', async () => {
    vi.resetModules();
    expect((await import('./skill-reduction.js')).claudeSkillRoute.catalogReady).toBe(true);
  });

  it('выключатель выключен — список Claude полный', async () => {
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

describe('codexSkillRoute.catalog: кэш чтения', () => {
  // Шов `read` — то, что в настоящем запуске запускает `codex app-server` (`readCodexNativeContext`). Ответ той формы,
  // которую принимает `projectCodexListCatalog`: один каталог для канонического cwd и пустой список навыков.
  const spy = (answers: Array<'ok' | 'null' | 'throw'> = ['ok']) => {
    let calls = 0;
    return vi.fn(async (read: { cwd: string }) => {
      const answer = answers[Math.min(calls++, answers.length - 1)];
      if (answer === 'throw') throw new Error('app-server failed');
      if (answer === 'null') return null;
      return { config: {}, requirements: { requirements: null }, skills: { data: [{ cwd: await realpath(read.cwd), skills: [], errors: [] }] } } as never;
    });
  };
  const ask = (read: ReturnType<typeof spy>, extra: { cwd?: string; env?: Record<string, string> } = {}) =>
    codexSkillRoute.catalog({ cwd, command: 'codex', configArgs: ['-c', 'a=1'], env: { HOME: '/h', CODEX_HOME: '/h/.codex' }, read, ...extra });

  beforeEach(() => { resetCodexSkillCatalogCache(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); resetCodexSkillCatalogCache(); });

  it('пять одновременных запросов с одним ключом читают каталог один раз', async () => {
    const read = spy();
    const results = await Promise.all(Array.from({ length: 5 }, () => ask(read)));
    expect(read).toHaveBeenCalledTimes(1);
    expect(results[0]).not.toBeNull();
    expect(results.every(result => result === results[0])).toBe(true);
  });

  it('ответ держится 30 с и перечитывается после', async () => {
    const read = spy();
    await ask(read);
    vi.setSystemTime(CODEX_SKILL_CATALOG_TTL_MS - 1);
    await ask(read);
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(CODEX_SKILL_CATALOG_TTL_MS + 1);
    await ask(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('null и ошибка не кэшируются: следующий запуск читает заново', async () => {
    const read = spy(['null', 'throw', 'ok']);
    expect(await ask(read)).toBeNull();
    expect(await ask(read)).toBeNull();
    expect(await ask(read)).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    await ask(read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('упавшее чтение в полёте не отравляет следующие запуски', async () => {
    const read = spy(['throw', 'ok']);
    const first = await Promise.all([ask(read), ask(read)]);
    expect(first).toEqual([null, null]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await ask(read)).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('другой cwd, CODEX_HOME, HOME, команда или аргументы читают заново', async () => {
    const read = spy();
    await ask(read);
    const other = path.join(root, 'other');
    await mkdir(other, { recursive: true });
    await ask(read, { cwd: other });
    await ask(read, { env: { HOME: '/h', CODEX_HOME: '/elsewhere' } });
    await ask(read, { env: { HOME: '/other', CODEX_HOME: '/h/.codex' } });
    await codexSkillRoute.catalog({ cwd, command: 'codex2', configArgs: ['-c', 'a=1'], env: { HOME: '/h', CODEX_HOME: '/h/.codex' }, read });
    await codexSkillRoute.catalog({ cwd, command: 'codex', configArgs: ['-c', 'a=2'], env: { HOME: '/h', CODEX_HOME: '/h/.codex' }, read });
    expect(read).toHaveBeenCalledTimes(6);
  });
});
