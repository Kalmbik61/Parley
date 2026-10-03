import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addProjectMemory, readProjectMemory, removeProjectMemory, updateProjectMemory } from './project-memory.js';
import { sharedProjectPaths } from './store.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let project = '';
beforeEach(async () => { vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename); project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-memory-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });
const seed = async (source: string) => { const dir = path.join(project, '.parley'); await mkdir(dir, { recursive: true }); const file = path.join(dir, 'memory.md'); await writeFile(file, source); return file; };

describe('lossless project memory', () => {
  it('read never creates state; new writes carry human authorship and monotonic local IDs', async () => {
    expect((await readProjectMemory(project)).items).toEqual([]);
    await expect(readFile(path.join(project, '.parley', 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const first = await addProjectMemory(project, { kind: 'fact', fact: 'Build with pnpm', details: 'Private details' });
    expect(first.id).toBe('m-001'); expect(first.document.items[0]?.provenance?.origin).toBe('human');
    await removeProjectMemory(project, first.id);
    expect((await addProjectMemory(project, { kind: 'lesson', fact: 'Next fact' })).id).toBe('m-002');
    expect((await readProjectMemory(project)).source).not.toContain('memorySeq');
    expect((await sharedProjectPaths(project)).lock).toBe(path.join(project, '.parley', 'backlog.lock'));
  });
  it('preserves BOM/CRLF/unknown text/fences and metadata while assigning handwritten IDs', async () => {
    const source = '\uFEFF# Project memory\r\nA paragraph.\r\n## Facts\r\n- Handwritten\r\n  Details\r\n- Old <!-- m-007 · human · strange: keep -->\r\n## Foreign\r\n- Not memory\r\n```md\r\n## Facts\r\n- Fake <!-- m-999 -->\r\n```\r\n| foreign | table |\r\n## Lessons\r\n';
    await seed(source);
    const result = await addProjectMemory(project, { kind: 'fact', fact: 'New' });
    expect(result.id).toBe('m-009'); expect(result.document.items.map(row => row.fact)).toEqual(['Handwritten', 'Old', 'New']);
    expect(result.document.source).toContain(source.slice(source.indexOf('## Foreign')));
    expect(result.document.source).toContain('Handwritten <!-- m-008 -->\r\n');
    await updateProjectMemory(project, 'm-007', { fact: 'Edited' });
    const final = (await readProjectMemory(project)).source;
    expect(final.startsWith('\uFEFF# Project memory\r\n')).toBe(true);
    expect(final).toContain('strange: keep'); expect(final).toContain('  Details\r\n');
  });
  it.each(['\u2028', '\u2029'])('keeps Unicode line separators %j inside phrases and foreign metadata', async separator => {
    await seed(`# Project memory\n## Facts\n- A${separator}B <!-- m-001 · foreign: X${separator}Y -->\n`);
    expect((await readProjectMemory(project)).items[0]?.fact).toBe(`A${separator}B`);
    await updateProjectMemory(project, 'm-001', { fact: `C${separator}D` });
    expect((await readProjectMemory(project)).source).toContain(`foreign: X${separator}Y`);
  });
  it('version-bound original handwritten index assigns IDs in one transaction without rewriting a long phrase', async () => {
    const long = 'x'.repeat(4097); await seed(`# Project memory\n## Facts\n- ${long}\n- Second\n`);
    const before = await readProjectMemory(project);
    await expect(updateProjectMemory(project, 0, {})).rejects.toMatchObject({ code: 'memory-invalid' });
    const result = await updateProjectMemory(project, 0, {}, { expectedVersion: before.version });
    expect(result.id).toBe('m-001'); expect(result.document.source).toContain(`- ${long} <!-- m-001 -->\n`);
    await expect(updateProjectMemory(project, 1, { fact: 'Wrong version' }, { expectedVersion: before.version })).rejects.toMatchObject({ code: 'memory-conflict' });
  });
  it('does not lose an intervening human edit when append rebuilds its latest base', async () => {
    const file = await seed('# Project memory\n## Facts\n- Original <!-- m-001 -->\n');
    let edits = 0;
    const result = await addProjectMemory(project, { kind: 'fact', fact: 'Appended' }, { beforeCommit: async () => {
      if (edits++ === 0) await writeFile(file, '# Project memory\n## Facts\n- Human edited <!-- m-001 -->\n');
    } });
    expect(result.document.items.map(row => row.fact)).toEqual(['Human edited', 'Appended']); expect(result.id).toBe('m-002');
  });
  it('fails safely when an intervening handwritten ID occupies a reserved identity', async () => {
    const file = await seed('# Project memory\n## Facts\n'); let edit = true;
    await expect(addProjectMemory(project, { kind: 'fact', fact: 'Reserved' }, { operationId: 'collision', beforeCommit: async () => {
      if (edit) { edit = false; await writeFile(file, '# Project memory\n## Facts\n- Human <!-- m-001 -->\n'); }
    } })).rejects.toMatchObject({ code: 'memory-conflict' });
    expect((await readProjectMemory(project)).items).toHaveLength(1);
    expect((await addProjectMemory(project, { kind: 'fact', fact: 'Different explicit operation' })).id).toBe('m-002');
    await removeProjectMemory(project, 'm-001');
    await expect(addProjectMemory(project, { kind: 'fact', fact: 'Reserved' }, { operationId: 'collision' })).rejects.toMatchObject({ code: 'memory-conflict' });
  });
  it('recovers a shared-write success/local-finalization failure using its reserved operation identity', async () => {
    const original = vi.mocked(fs.rename).getMockImplementation()!; let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('memory-suggestions.json') && (await readProjectMemory(project)).items.length > 0) {
        failed = true; throw Object.assign(new Error('private'), { code: 'ENOSPC' });
      }
      return original(from, to);
    });
    await expect(addProjectMemory(project, { kind: 'fact', fact: 'One' }, { operationId: 'retry' })).rejects.toMatchObject({ code: 'ENOSPC' });
    vi.restoreAllMocks();
    expect((await addProjectMemory(project, { kind: 'fact', fact: 'One' }, { operationId: 'retry' })).id).toBe('m-001');
    expect((await readProjectMemory(project)).items).toHaveLength(1);
  });
  it('serializes concurrent additions and performs case-insensitive dedup without reusing terminal IDs', async () => {
    const added = await Promise.all(Array.from({ length: 6 }, (_, n) => addProjectMemory(project, { kind: 'fact', fact: `Fact ${n}` })));
    expect(new Set(added.map(row => row.id)).size).toBe(6);
    const same = await addProjectMemory(project, { kind: 'agreement', fact: 'FACT 0' });
    expect(same.duplicate).toBe(true); expect((await readProjectMemory(project)).items).toHaveLength(6);
    await removeProjectMemory(project, same.id);
    expect((await addProjectMemory(project, { kind: 'fact', fact: 'FACT 0' })).id).toBe('m-007');
  });
  it('refuses merge conflicts, duplicated IDs, invalid UTF-8, symlinks and oversized files without modifying bytes', async () => {
    const file = await seed('# Project memory\n<<<<<<< human\n');
    await expect(addProjectMemory(project, { kind: 'fact', fact: 'X' })).rejects.toMatchObject({ code: 'memory-merge-conflict' });
    await writeFile(file, '## Facts\n- A <!-- m-001 -->\n- B <!-- m-001 -->\n');
    await expect(readProjectMemory(project)).rejects.toMatchObject({ code: 'memory-invalid' });
    await writeFile(file, Buffer.from([0xff])); await expect(readProjectMemory(project)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    await rm(file); const outside = path.join(project, 'outside'); await writeFile(outside, 'secret'); await symlink(outside, file);
    await expect(readProjectMemory(project)).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    await rm(file); await writeFile(file, 'x'.repeat(1024 * 1024 + 1)); await expect(readProjectMemory(project)).rejects.toMatchObject({ code: 'shared-file-too-large' });
  });
  it('linked worktrees and explicit nested folders share only the verified matching main project', async () => {
    const run = promisify(execFile); const git = (...args: string[]) => run('git', ['-C', project, ...args]);
    await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(path.join(project, 'nested')); await writeFile(path.join(project, 'nested', 'seed'), 'fixture');
    await git('add', '.'); await git('commit', '-m', 'fixture');
    const checkout = path.join(project, 'checkout'); await git('worktree', 'add', '-b', 'fixture', checkout);
    await addProjectMemory(path.join(project, 'nested'), { kind: 'fact', fact: 'Nested main' });
    expect((await readProjectMemory(path.join(checkout, 'nested'))).items[0]?.fact).toBe('Nested main');
    expect((await readProjectMemory(checkout)).items).toEqual([]);
  });
});

it('unclosed foreign fences fail safely rather than hiding a successfully added fact', async () => {
  const source = '# Project memory\n## Facts\n```md\nForeign code'; await seed(source);
  await expect(addProjectMemory(project, { kind: 'fact', fact: 'Would be hidden' })).rejects.toMatchObject({ code: 'memory-invalid' });
  expect((await readProjectMemory(project)).source).toBe(source);
});

it('detail/state/fact edits preserve foreign comment segments byte for byte and retain unknown author origin', async () => {
  const foreign = ' ·  custom:  value\u2028and\u2029more  ·\tprivate: keep\t';
  await seed(`## Facts\r\n-  Original  <!-- m-001${foreign} -->\r\n  Before\r\n`);
  await updateProjectMemory(project, 'm-001', { details: 'After' });
  const amended = await readProjectMemory(project);
  expect(amended.source).toContain(`-  Original  <!-- m-001${foreign} · amended by human -->\r\n`);
  expect(amended.items[0]?.provenance).toBeUndefined(); expect(amended.items[0]?.amendedByHuman).toBe(true);
  await updateProjectMemory(project, 'm-001', { fact: 'Current human text', state: 'superseded' });
  const final = await readProjectMemory(project);
  expect(final.source).toContain(foreign); expect(final.items[0]?.factAmendedByHuman).toBe(true); expect(final.items[0]?.state).toBe('superseded');
});

it('rejects non-scalar add/update/operation input before reservation and preserves valid Unicode', async () => {
  const bad = String.fromCharCode(0xd800);
  for (const [input, options] of [
    [{ kind: 'fact' as const, fact: bad }, {}],
    [{ kind: 'fact' as const, fact: 'Valid', details: bad }, {}],
    [{ kind: 'fact' as const, fact: 'Valid' }, { operationId: bad }],
  ] as const) {
    await expect(addProjectMemory(project, input, options)).rejects.toMatchObject({ code: 'memory-invalid' });
    expect(await fs.readdir(project)).toEqual([]);
  }
  const fact = 'Use 😀 across\u2028lines\u2029safely';
  const details = 'Details 😀\u2028and\u2029text';
  await addProjectMemory(project, { kind: 'fact', fact, details }, { operationId: 'op:😀\u2028valid' });
  const paths = await sharedProjectPaths(project);
  const before = await Promise.all([paths.memory, paths.memorySuggestions, path.join(paths.dir, '.gitignore')].map(file => readFile(file)));
  for (const patch of [{ fact: bad }, { details: bad }]) {
    await expect(updateProjectMemory(project, 'm-001', patch)).rejects.toMatchObject({ code: 'memory-invalid' });
    expect(await Promise.all([paths.memory, paths.memorySuggestions, path.join(paths.dir, '.gitignore')].map(file => readFile(file)))).toEqual(before);
  }
  expect((await readProjectMemory(project)).items[0]).toMatchObject({ fact, details });
});
