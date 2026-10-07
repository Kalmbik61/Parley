import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillCatalog } from '../skills/catalog.js';
import type { NativeSkill } from '../skills/types.js';
import { nativeContextMatches, projectNativeSkillConfigArgs, readNativeContext, readNativeSkillCatalog, stampNativeContext, writeNativeContext, writeNativeSkillCatalog, type NativeContextDescriptor } from './native-context.js';
let project: string;
let descriptor: NativeContextDescriptor;
const work = 'w-0001'; const session = 's-01';
const file = () => path.join(project, '.parley/local/native-context', work, `${session}.json`);
beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-bound-context-')));
  descriptor = { version: 1, revision: randomUUID(), provider: 'codex', cwd: project, verified: true,
    command: process.execPath, configArgs: [], roots: { homeDir: project } };
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
describe('local participant context descriptor', () => {
  it('writes bounded private data and verifies the own launch revision', async () => {
    expect(await writeNativeContext(project, work, session, descriptor)).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const read = await readNativeContext(project, work, session);
    expect(read).toEqual(descriptor);
    expect(await nativeContextMatches(read!, 'codex', project, descriptor.revision)).toBe(true);
    expect(await nativeContextMatches(read!, 'codex', project, randomUUID())).toBe(false);
    expect(await nativeContextMatches(read!, 'claude', project, descriptor.revision)).toBe(false);
  });
  it('does not bind a stale unbound file without the actual spawned revision', async () => {
    await writeNativeContext(project, work, session, descriptor);
    const started = { pid: 42, startedAtProcess: 'launch-1' };
    await stampNativeContext(project, work, session, started);
    await stampNativeContext(project, work, session, started, randomUUID());
    expect((await readNativeContext(project, work, session))?.process).toBeUndefined();
    await stampNativeContext(project, work, session, started, descriptor.revision);
    expect(await nativeContextMatches((await readNativeContext(project, work, session))!, 'codex', project, undefined, started)).toBe(true);
    await stampNativeContext(project, work, session, { pid: 43, startedAtProcess: 'launch-2' }, descriptor.revision);
    expect((await readNativeContext(project, work, session))?.process).toEqual(started);
  });
  it('permits known last closed context with cleared PID and refuses a changed start stamp', async () => {
    await writeNativeContext(project, work, session, descriptor);
    await stampNativeContext(project, work, session, { pid: 42, startedAtProcess: 'launch-1' }, descriptor.revision);
    const bound = (await readNativeContext(project, work, session))!;
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-1', lifecycle: 'closed' })).toBe(true);
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-2', lifecycle: 'closed' })).toBe(false);
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-1', lifecycle: 'active' })).toBe(false);
  });
  it('failed new write cannot stamp or confirm a previous descriptor for the new process', async () => {
    await writeNativeContext(project, work, session, descriptor);
    const revision = randomUUID();
    expect(await writeNativeContext(project, work, session, { ...descriptor, revision, configArgs: ['SECRET'] })).toBe(false);
    await stampNativeContext(project, work, session, { pid: 99, startedAtProcess: 'new' }, revision);
    const old = (await readNativeContext(project, work, session))!;
    expect(old.process).toBeUndefined();
    expect(await nativeContextMatches(old, 'codex', project, revision)).toBe(false);
    expect(await nativeContextMatches(old, 'codex', project, undefined, { pid: 99, startedAtProcess: 'new' })).toBe(false);
  });
  it('rejects symlink parents and never creates directories through their target', async () => {
    await mkdir(path.join(project, '.parley'));
    const outside = path.join(project, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(project, '.parley/local'));
    expect(await writeNativeContext(project, work, session, descriptor)).toBe(false);
    await expect(stat(path.join(outside, 'native-context'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects broad permissions, extra data, public permissions, oversized content and path traversal', async () => {
    expect(await writeNativeContext(project, work, '../w-0001', descriptor)).toBe(false);
    expect(await writeNativeContext(project, work, session, { ...descriptor, configArgs: ['-c', 'sandbox_mode="danger-full-access"'] })).toBe(false);
    expect(await writeNativeContext(project, work, session, { ...descriptor, secret: 'DO_NOT_STORE' } as NativeContextDescriptor)).toBe(false);
    await writeNativeContext(project, work, session, descriptor);
    await chmod(file(), 0o644);
    expect(await readNativeContext(project, work, session)).toBeNull();
    await chmod(file(), 0o600);
    await writeFile(file(), JSON.stringify(descriptor) + ' '.repeat(32769));
    expect(await readNativeContext(project, work, session)).toBeNull();
  });
  it('serializes only validated human selector fields, excluding raw comments and unknown fields', async () => {
    const args = projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",enabled=false}] # SECRET', '-c', 'project_root_markers=[".git"]']);
    expect(args).toEqual(['-c', 'skills.config=[{name="review",enabled=false}]', '-c', 'project_root_markers=[".git"]']);
    expect(projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",enabled=false,secret="SECRET"}]'])).toBeNull();
    expect(projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",path="/tmp/a",enabled=false}]'])).toBeNull();
    expect(projectNativeSkillConfigArgs(['-c', 'project_root_markers=["../escape"]'])).toBeNull();
    await writeNativeContext(project, work, session, { ...descriptor, configArgs: args! });
    expect(await readFile(file(), 'utf8')).not.toContain('SECRET');
  });
});

describe('каталог навыков Codex рядом с дескриптором', () => {
  const skillsFile = () => path.join(project, '.parley/local/native-context', work, `${session}.skills.json`);
  const skill = (over: Partial<NativeSkill> = {}): NativeSkill => ({ provider: 'codex', documentKind: 'skill', name: 'review-code',
    description: 'Review code', source: 'user', path: '/home/u/.codex/skills/review-code/SKILL.md', modelAvailable: true, unavailableReason: null, ...over });
  const catalogOf = (...skills: NativeSkill[]): SkillCatalog => ({ provider: 'codex', skills, diagnostics: [], partial: false });
  /** Файл каталога записан руками: для форм, которые запись сама не пропустит. */
  const raw = async (value: unknown, mode = 0o600) => {
    await mkdir(path.dirname(skillsFile()), { recursive: true });
    await writeFile(skillsFile(), typeof value === 'string' ? value : JSON.stringify(value), { mode });
    await chmod(skillsFile(), mode);
  };
  const entry = (over: Record<string, unknown> = {}) => ({ name: 'a', description: '', source: 'user', path: '/p/SKILL.md', modelAvailable: true, unavailableReason: null, ...over });

  it('пишет и читает каталог той же ревизии: приватный файл, только шесть полей записи', async () => {
    const catalog = catalogOf(skill(), skill({ name: 'plug:one', source: 'plugin', path: '/p/one/SKILL.md' }),
      skill({ name: 'quiet', path: '/q/SKILL.md', modelAvailable: false, unavailableReason: 'implicit-invocation-disabled' }));
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalog)).toBe(true);
    expect((await stat(skillsFile())).mode & 0o777).toBe(0o600);
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toEqual(catalog);
    const stored = JSON.parse(await readFile(skillsFile(), 'utf8'));
    expect(Object.keys(stored)).toEqual(['version', 'revision', 'skills']);
    expect(Object.keys(stored.skills[0])).toEqual(['name', 'description', 'source', 'path', 'modelAvailable', 'unavailableReason']);
    // Дескриптор лежит рядом и не задет.
    expect(await writeNativeContext(project, work, session, descriptor)).toBe(true);
    expect((await readNativeContext(project, work, session))?.revision).toBe(descriptor.revision);
  });

  it('пустой каталог — записанный каталог, а не отсутствие: читается пустым', async () => {
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf())).toBe(true);
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toEqual(catalogOf());
  });

  it('чужая ревизия, нет файла и непохожая на ревизию строка дают null', async () => {
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
    await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()));
    expect(await readNativeSkillCatalog(project, work, session, randomUUID())).toBeNull();
    expect(await readNativeSkillCatalog(project, work, session, 'not-a-revision')).toBeNull();
    expect(await writeNativeSkillCatalog(project, work, session, 'not-a-revision', catalogOf(skill()))).toBe(false);
  });

  it('новая запись другой ревизии заменяет файл целиком: старый запуск уже не читается', async () => {
    const next = randomUUID();
    await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()));
    await writeNativeSkillCatalog(project, work, session, next, catalogOf(skill({ name: 'fresh' })));
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
    expect((await readNativeSkillCatalog(project, work, session, next))?.skills.map(item => item.name)).toEqual(['fresh']);
  });

  it('отказывается от симлинка вместо файла, симлинка в родителях и широких прав', async () => {
    await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()));
    const real = path.join(project, 'elsewhere.json');
    await writeFile(real, await readFile(skillsFile(), 'utf8'), { mode: 0o600 });
    await rm(skillsFile());
    await symlink(real, skillsFile());
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
    await rm(skillsFile());
    await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()));
    await chmod(skillsFile(), 0o640);
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
    await chmod(skillsFile(), 0o604);
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
    await rm(path.join(project, '.parley'), { recursive: true });
    await mkdir(path.join(project, '.parley'));
    const outside = path.join(project, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(project, '.parley/local'));
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()))).toBe(false);
    await expect(stat(path.join(outside, 'native-context'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('предел размера: большой файл не читается, большая запись не пишется и прежний файл остаётся', async () => {
    await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill()));
    const before = await readFile(skillsFile(), 'utf8');
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill({ description: 'x'.repeat(4 * 1024 * 1024) })))).toBe(false);
    expect(await readFile(skillsFile(), 'utf8')).toBe(before);
    await raw({ version: 1, revision: descriptor.revision, skills: [entry({ description: 'x'.repeat(4 * 1024 * 1024) })] });
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
  });

  it('предел числа записей: 20000 принимаются, 20001 — нет, ни записью, ни чтением', async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => skill({ name: `s-${index}`, description: '' }));
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(...many(20000)))).toBe(true);
    expect((await readNativeSkillCatalog(project, work, session, descriptor.revision))?.skills).toHaveLength(20000);
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(...many(20001)))).toBe(false);
    await raw({ version: 1, revision: descriptor.revision, skills: many(20001).map(({ name, description, source, path: file, modelAvailable, unavailableReason }) => ({ name, description, source, path: file, modelAvailable, unavailableReason })) });
    expect(await readNativeSkillCatalog(project, work, session, descriptor.revision)).toBeNull();
  });

  it('строгая форма: чужая версия, лишние и недостающие поля, относительный путь, чужой источник, несогласованная доступность — null', async () => {
    const withSkills = (...skills: unknown[]) => ({ version: 1, revision: descriptor.revision, skills });
    const refused: unknown[] = [
      { ...withSkills(entry()), version: 2 },
      { ...withSkills(entry()), extra: true },
      { version: 1, revision: descriptor.revision },
      { version: 1, revision: descriptor.revision, skills: 'x' },
      withSkills(entry({ extra: 1 })),
      withSkills(Object.fromEntries(Object.entries(entry()).filter(([key]) => key !== 'description'))),
      withSkills(entry({ name: '' })),
      withSkills(entry({ name: 'a\0b' })),
      withSkills(entry({ description: 5 })),
      withSkills(entry({ path: 'relative/SKILL.md' })),
      withSkills(entry({ source: 'claude.ai' })),
      withSkills(entry({ source: 'elsewhere' })),
      withSkills(entry({ modelAvailable: 'yes' })),
      withSkills(entry({ unavailableReason: 'made-up', modelAvailable: false })),
      withSkills(entry({ modelAvailable: false })),
      withSkills(entry({ modelAvailable: true, unavailableReason: 'shadowed' })),
      withSkills(null),
      [],
      'not json',
    ];
    for (const value of refused) {
      await raw(value);
      expect(await readNativeSkillCatalog(project, work, session, descriptor.revision), JSON.stringify(value)).toBeNull();
    }
    // Запись тех же форм, что она в состоянии выразить, тоже отказывает.
    const bad = (over: Partial<NativeSkill>) => writeNativeSkillCatalog(project, work, session, descriptor.revision, catalogOf(skill(over)));
    expect(await bad({ path: 'relative/SKILL.md' })).toBe(false);
    expect(await bad({ name: '' })).toBe(false);
    expect(await bad({ source: 'claude.ai' })).toBe(false);
    expect(await bad({ modelAvailable: false })).toBe(false);
    expect(await writeNativeSkillCatalog(project, work, session, descriptor.revision, { ...catalogOf(skill()), provider: 'claude' })).toBe(false);
    expect(await writeNativeSkillCatalog(project, work, '../s-01', descriptor.revision, catalogOf(skill()))).toBe(false);
  });
});
