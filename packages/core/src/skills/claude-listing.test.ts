import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeListedNames, readClaudeSkillCatalog } from './claude-listing.js';
import { searchSkills } from './search.js';

const UUID = '85bfa23b-c5fe-4e9e-9de1-5242ad278b23';
let root: string;
let home: string;
let cwd: string;
let projects: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-claude-listing-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'work');
  projects = path.join(root, 'projects');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(projects, '-some-project'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
const listing = (names: string[], isInitial = true): string => JSON.stringify({
  type: 'attachment',
  attachment: { type: 'skill_listing', content: names.map(name => `- ${name}`).join('\n'), skillCount: names.length, isInitial, names },
});
const other = JSON.stringify({ type: 'user', message: { content: 'hi' } });
const transcript = (...lines: string[]): Promise<void> => put(path.join(projects, '-some-project', `${UUID}.jsonl`), lines.join('\n') + '\n');
const skillFile = (directory: string, description: string, extra = ''): Promise<void> =>
  put(path.join(directory, 'SKILL.md'), `---\nname: decorative\ndescription: ${description}\n${extra}---\nBODY\n`);
const read = (providerSessionId: string | null = UUID, extra: { windowBytes?: number } = {}) =>
  readClaudeSkillCatalog({ cwd, homeDir: home, providerSessionId, roots: [projects], ...extra });

describe('имена, которые Claude показал модели', () => {
  it('берёт полный список из последнего вложения и добавляет к нему поздние добавки', async () => {
    await transcript(other, listing(['old-a', 'old-b']), other, listing(['alpha', 'beta']), listing(['gamma'], false));
    expect(await readClaudeListedNames(UUID, { roots: [projects] })).toEqual({ status: 'ok', names: ['alpha', 'beta', 'gamma'] });
  });

  it('пропускает битые строки JSON и вложения чужого вида', async () => {
    await transcript('{"attachment": {"type": "skill_listing", "names": ["bro', listing(['alpha']), JSON.stringify({ attachment: { type: 'skill_listing', names: 'not-an-array' } }),
      JSON.stringify({ attachment: { type: 'other', names: ['ghost'] } }));
    expect(await readClaudeListedNames(UUID, { roots: [projects] })).toEqual({ status: 'ok', names: ['alpha'] });
  });

  it('отличает отсутствие транскрипта от отсутствия вложения', async () => {
    expect(await readClaudeListedNames(UUID, { roots: [projects] })).toEqual({ status: 'no-transcript' });
    await transcript(other);
    expect(await readClaudeListedNames(UUID, { roots: [projects] })).toEqual({ status: 'no-listing' });
    expect(await readClaudeListedNames('../../etc/passwd', { roots: [projects] })).toEqual({ status: 'no-transcript' });
  });

  it('не открывает транскрипт-симлинк', async () => {
    const real = path.join(root, 'elsewhere.jsonl');
    await put(real, listing(['alpha']) + '\n');
    await symlink(real, path.join(projects, '-some-project', `${UUID}.jsonl`));
    expect(await readClaudeListedNames(UUID, { roots: [projects] })).toEqual({ status: 'no-transcript' });
  });

  it('у большого файла читает только окна с начала и с конца', async () => {
    const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(400) });
    const fill = Array.from({ length: 200 }, () => filler);
    // Вложение в начале и в конце читается, в середине (вне окон) — нет.
    await transcript(listing(['head']), ...fill, listing(['middle'], false), ...fill, listing(['tail'], false));
    expect(await readClaudeListedNames(UUID, { roots: [projects], windowBytes: 4096 })).toEqual({ status: 'ok', names: ['head', 'tail'] });
    await transcript(...fill, listing(['middle']), ...fill);
    expect(await readClaudeListedNames(UUID, { roots: [projects], windowBytes: 4096 })).toEqual({ status: 'no-listing' });
  });
});

describe('каталог скиллов Claude-сессии', () => {
  it('сопоставляет имена с диском: свои, проектные, плагин с префиксом, claude.ai; недоступное модели не возвращает', async () => {
    await skillFile(path.join(home, '.claude/skills/mine'), 'Own skill for reviewing code');
    await skillFile(path.join(cwd, '.claude/skills/proj'), 'Project skill for deployment');
    // Есть на диске, но Claude его модели не показал: скрыт человеком.
    await skillFile(path.join(home, '.claude/skills/hidden'), 'Hidden skill for reviewing code', 'disable-model-invocation: true\n');
    const plugin = path.join(root, 'cache/superpowers');
    await put(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'superpowers' }));
    await skillFile(path.join(plugin, 'skills/writing-plans'), 'Use when you have a spec for a multi-step task, before touching code');
    await put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2,
      plugins: { 'superpowers@market': [{ scope: 'user', installPath: plugin }] } }));
    await skillFile(path.join(home, '.claude/skills/synced/acc_1/docs'), 'Editable docs people share');
    await transcript(listing(['mine', 'proj', 'superpowers:writing-plans', 'anthropic-skills:docs']));
    const built = await read();
    if (!('catalog' in built)) throw new Error(built.reason);
    const byName = Object.fromEntries(built.catalog.skills.map(skill => [skill.name, skill]));
    expect(Object.keys(byName).sort()).toEqual(['anthropic-skills:docs', 'mine', 'proj', 'superpowers:writing-plans']);
    expect(byName['mine']).toMatchObject({ source: 'user', modelAvailable: true, description: 'Own skill for reviewing code' });
    expect(byName['proj']).toMatchObject({ source: 'project', description: 'Project skill for deployment' });
    expect(byName['superpowers:writing-plans']).toMatchObject({ source: 'plugin', description: expect.stringContaining('spec for a multi-step task') });
    expect(byName['anthropic-skills:docs']).toMatchObject({ source: 'claude.ai', description: 'Editable docs people share' });
    expect(built.catalog.partial).toBe(false);
  });

  it('имя без файла на диске возвращается без описания', async () => {
    await transcript(listing(['simplify', 'ghost-plugin:thing']));
    const built = await read();
    if (!('catalog' in built)) throw new Error(built.reason);
    expect(built.catalog.skills).toMatchObject([
      { name: 'simplify', description: '', source: 'system', modelAvailable: true },
      { name: 'ghost-plugin:thing', description: '', source: 'plugin', modelAvailable: true },
    ]);
    // Поиск по имени находит такой скилл и без описания.
    expect(searchSkills(built.catalog.skills, 'simplify').map(match => match.skill.name)).toEqual(['simplify']);
  });

  it('поиск по каталогу сессии возвращает описания с диска', async () => {
    const plugin = path.join(root, 'cache/superpowers');
    await put(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'superpowers' }));
    await skillFile(path.join(plugin, 'skills/writing-plans'), 'Use when you have a spec or requirements for a multi-step task');
    await skillFile(path.join(plugin, 'skills/brainstorming'), 'Explore intent and design before creative work');
    await put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2,
      plugins: { 'superpowers@market': [{ scope: 'user', installPath: plugin }] } }));
    await transcript(listing(['superpowers:writing-plans', 'superpowers:brainstorming']));
    const built = await read();
    if (!('catalog' in built)) throw new Error(built.reason);
    const found = searchSkills(built.catalog.skills, 'write an implementation plan');
    expect(found[0]?.skill).toMatchObject({ name: 'superpowers:writing-plans', description: expect.stringContaining('multi-step task') });
  });

  it('честная причина: нет id разговора, транскрипта или вложения', async () => {
    expect(await read(null)).toEqual({ reason: expect.stringContaining('no Claude conversation id') });
    expect(await read()).toEqual({ reason: expect.stringContaining('not readable') });
    await transcript(other);
    expect(await read()).toEqual({ reason: expect.stringContaining('has not listed skills') });
  });
});
