import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectCodexListCatalog, readCodexSkillCatalog } from './context.js';

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-native-skill-context-')));
  cwd = path.join(root, 'project');
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Навык на диске: папка с `SKILL.md` (и, если нужно, `agents/openai.yaml`); возвращает путь к документу. */
async function skillFile(folder: string, policy?: string): Promise<string> {
  const dir = path.join(root, folder);
  await mkdir(path.join(dir, 'agents'), { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await writeFile(file, '---\nname: x\ndescription: x\n---\n');
  if (policy !== undefined) await writeFile(path.join(dir, 'agents/openai.yaml'), policy);
  return file;
}
const entry = (file: string, extra: Record<string, unknown> = {}) =>
  ({ name: 'review', description: 'Review code', path: file, scope: 'user', enabled: true, pluginId: null, ...extra });
const response = (...skills: unknown[]) => ({
  config: { layers: [] }, requirements: { requirements: null }, skills: { data: [{ cwd, errors: [], skills }] },
});
const build = (...skills: unknown[]) => projectCodexListCatalog(cwd, response(...skills));

describe('каталог find_skill из ответа skills/list', () => {
  it('системный, плагинный (путь — папка), repo и user: источник по правилам, путь — канонический SKILL.md, порядок Codex', async () => {
    const system = await skillFile('system/skill-installer');
    const plugin = await skillFile('plugins/p/skills/deploy');
    const repo = await skillFile('repo/review');
    const user = await skillFile('user/notes');
    const catalog = await build(
      entry(system, { name: 'skill-installer', scope: 'system' }),
      entry(path.dirname(plugin), { name: 'p:deploy', pluginId: 'p@market', description: 'Deploy things' }),
      entry(repo, { scope: 'repo' }),
      entry(user, { name: 'notes' }),
    );
    expect(catalog).toMatchObject({ provider: 'codex', partial: false, diagnostics: [] });
    expect(catalog?.skills.map(skill => [skill.name, skill.source, skill.path, skill.modelAvailable, skill.unavailableReason, skill.documentKind])).toEqual([
      ['skill-installer', 'system', system, true, null, 'skill'],
      ['p:deploy', 'plugin', plugin, true, null, 'skill'],
      ['review', 'project', repo, true, null, 'skill'],
      ['notes', 'user', user, true, null, 'skill'],
    ]);
  });

  it('admin и незнакомая область (extra) попадают в каталог: доступность подтвердил сам Codex', async () => {
    const admin = await skillFile('admin/corp');
    const other = await skillFile('other/thing');
    const catalog = await build(entry(admin, { name: 'corp', scope: 'admin' }), entry(other, { name: 'thing', scope: 'somewhere-new' }));
    expect(catalog?.skills.map(skill => [skill.name, skill.source])).toEqual([['corp', 'admin'], ['thing', 'extra']]);
  });

  it('выключенный навык пропускается без диагностики, но форма записи проверяется и у него', async () => {
    const file = await skillFile('user/off');
    const catalog = await build(entry(file, { name: 'off', enabled: false }));
    expect(catalog?.skills).toEqual([]);
    expect(catalog?.diagnostics).toEqual([]);
    expect(await build(entry(file, { enabled: false, scope: 7 }))).toBeNull();
  });

  it('одноимённые навыки из разных папок остаются оба, точный повтор (путь и имя) схлопывается', async () => {
    const first = await skillFile('a/review');
    const second = await skillFile('b/review');
    const catalog = await build(entry(first), entry(second, { scope: 'repo' }), entry(first, { scope: 'repo' }), entry(path.dirname(first)));
    expect(catalog?.skills.map(skill => [skill.name, skill.path, skill.source])).toEqual([
      ['review', first, 'user'], ['review', second, 'project'],
    ]);
  });

  it('пустое описание заменяет interface.shortDescription, затем shortDescription, иначе пустая строка', async () => {
    const [a, b, c, d] = [await skillFile('s/a'), await skillFile('s/b'), await skillFile('s/c'), await skillFile('s/d')];
    const catalog = await build(
      entry(a, { name: 'a', description: '   ', interface: { shortDescription: 'From interface' }, shortDescription: 'Top level' }),
      entry(b, { name: 'b', description: '', interface: { displayName: 'B' }, shortDescription: 'Top level' }),
      entry(c, { name: 'c', description: '\n' }),
      entry(d, { name: 'd', description: 'Own text', shortDescription: 'Ignored' }),
    );
    expect(catalog?.skills.map(skill => skill.description)).toEqual(['From interface', 'Top level', '', 'Own text']);
  });

  it('agents/openai.yaml с allow_implicit_invocation: false — навык не для модели; битый файл, products и иное — доступен', async () => {
    const off = await skillFile('p/off', 'policy:\n  allow_implicit_invocation: false\n');
    const broken = await skillFile('p/broken', 'policy: [unclosed\n  : :');
    const products = await skillFile('p/products', 'policy:\n  products: [codex]\n');
    const on = await skillFile('p/on', 'policy:\n  allow_implicit_invocation: true\n');
    const wrong = await skillFile('p/wrong', 'policy:\n  allow_implicit_invocation: "false"\n');
    const catalog = await build(
      entry(off, { name: 'off' }), entry(broken, { name: 'broken' }), entry(products, { name: 'products' }),
      entry(on, { name: 'on' }), entry(wrong, { name: 'wrong' }),
    );
    expect(catalog?.skills.map(skill => [skill.name, skill.modelAvailable, skill.unavailableReason])).toEqual([
      ['off', false, 'implicit-invocation-disabled'], ['broken', true, null], ['products', true, null],
      ['on', true, null], ['wrong', true, null],
    ]);
    expect(catalog?.diagnostics).toEqual([]);
  });

  it('символическая ссылка — не отказ ответа: путь записи канонический', async () => {
    const real = await skillFile('real/linked');
    const link = path.join(root, 'link-to-skill');
    await symlink(path.dirname(real), link);
    const fileLink = path.join(root, 'file-link.md');
    await symlink(real, fileLink);
    const catalog = await build(entry(link, { name: 'by-folder' }), entry(fileLink, { name: 'by-file' }));
    expect(catalog?.skills.map(skill => [skill.name, skill.path])).toEqual([['by-folder', real], ['by-file', real]]);
  });

  it('нет файла или это не файл — запись пропущена, в диагностике unreadable; остальные записи на месте', async () => {
    const good = await skillFile('g/good');
    const missing = path.join(root, 'gone/SKILL.md');
    const emptyFolder = path.join(root, 'folder-without-skill');
    await mkdir(emptyFolder);
    const documentIsFolder = path.join(root, 'doc-is-folder');
    await mkdir(path.join(documentIsFolder, 'SKILL.md'), { recursive: true });
    const catalog = await build(entry(missing, { name: 'gone', scope: 'system' }), entry(good, { name: 'good' }), entry(emptyFolder, { name: 'empty' }), entry(documentIsFolder, { name: 'odd' }));
    expect(catalog?.skills.map(skill => skill.name)).toEqual(['good']);
    expect(catalog?.diagnostics).toEqual([
      { provider: 'codex', source: 'system', path: missing, code: 'unreadable' },
      { provider: 'codex', source: 'user', path: emptyFolder, code: 'unreadable' },
      { provider: 'codex', source: 'user', path: documentIsFolder, code: 'unreadable' },
    ]);
    expect(catalog?.partial).toBe(false);
  });

  it('непустой errors — не отказ: это навыки, которых Codex не загрузил сам', async () => {
    const file = await skillFile('u/review');
    const native = response(entry(file));
    native.skills.data[0]!.errors = [{ path: '/x', message: 'bad' }] as never;
    expect((await projectCodexListCatalog(cwd, native))?.skills).toHaveLength(1);
  });

  it('не доверяем: нет ответа, чужой cwd, управляемые требования, несколько рабочих папок, слишком длинный перечень', async () => {
    const file = await skillFile('u/review');
    const native = response(entry(file));
    const cases: unknown[] = [
      { ...native, requirements: {} }, { ...native, requirements: { requirements: {} } }, { ...native, requirements: null },
      { ...native, skills: undefined }, { ...native, skills: { data: [] } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, cwd: root }] } },
      { ...native, skills: { data: [native.skills.data[0], native.skills.data[0]] } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, errors: undefined }] } },
      { ...native, skills: { data: [{ ...native.skills.data[0]!, skills: Array.from({ length: 20001 }, () => entry(file)) }] } },
    ];
    for (const value of cases) expect(await projectCodexListCatalog(cwd, value as never)).toBeNull();
    expect(await projectCodexListCatalog(path.join(root, 'no-such-folder'), native)).toBeNull();
    expect(await projectCodexListCatalog('relative', native)).toBeNull();
  });

  it('запись не той формы — весь ответ null', async () => {
    const file = await skillFile('u/review');
    const bad: Array<Record<string, unknown>> = [
      { name: '' }, { name: 'a\0b' }, { name: 5 }, { description: undefined }, { description: 5 }, { path: 'relative/SKILL.md' }, { path: 5 },
      { enabled: 'yes' }, { enabled: undefined }, { scope: undefined }, { pluginId: 5 }, { interface: 'x' }, { interface: null }, { interface: [] },
      { shortDescription: 5 },
    ];
    for (const patch of bad) expect(await build(entry(file), entry(file, patch))).toBeNull();
    expect(await build(entry(file), 'not a record')).toBeNull();
    expect(await build(entry(file), null)).toBeNull();
    // Допустимые отсутствия: нет pluginId, interface, shortDescription.
    const bare: Record<string, unknown> = entry(file);
    delete bare['pluginId'];
    expect((await build(bare))?.skills).toHaveLength(1);
  });
});

describe('readCodexSkillCatalog', () => {
  it('строит каталог из ответа шва read и отдаёт cwd запроса без обхода диска', async () => {
    const file = await skillFile('u/review');
    let asked: { cwd: string; includeSkills: boolean } | undefined;
    const catalog = await readCodexSkillCatalog({ cwd, read: async (options, includeSkills) => { asked = { cwd: options.cwd, includeSkills: includeSkills === true }; return response(entry(file)); } });
    expect(asked).toEqual({ cwd, includeSkills: true });
    expect(catalog?.skills.map(skill => skill.name)).toEqual(['review']);
  });

  it('нет ответа от Codex или ответ не той формы — null', async () => {
    expect(await readCodexSkillCatalog({ cwd, read: async () => null })).toBeNull();
    expect(await readCodexSkillCatalog({ cwd, read: async () => ({ config: {}, requirements: {} }) })).toBeNull();
  });
});
