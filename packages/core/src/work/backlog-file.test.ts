import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBacklogItem, parseBacklog } from './backlog.js';
import { setBacklogFile } from './project-preferences.js';
import { inspectSharedIgnore, sharedProjectPaths, withSharedProjectLock } from './store.js';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
let project = '';
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-file-'))); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
const state = (): string => path.join(project, '.parley', 'backlog.md');
const todos = (): string => path.join(project, 'TODOS.md');
async function prefs(value: unknown): Promise<void> {
  await mkdir(path.join(project, '.parley'), { recursive: true });
  await writeFile(path.join(project, '.parley', 'preferences.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('backlog file choice', () => {
  it('keeps the backlog in the state folder without a choice and reports TODOS.md found on disk', async () => {
    await writeFile(todos(), '# TODOS\n');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: state(), backlogChoice: null, todosFile: 'TODOS.md' });
  });
  it('points the chosen backlog at a new TODOS.md, then at TODO.md in its own case, then prefers TODOS.md', async () => {
    await prefs({ version: 1, backlogFile: 'todos' });
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: todos(), backlogChoice: 'todos', todosFile: null });
    await writeFile(path.join(project, 'Todo.md'), '');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: path.join(project, 'Todo.md'), todosFile: 'Todo.md' });
    await writeFile(todos(), '');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: todos(), todosFile: 'TODOS.md' });
  });
  it('falls back to the state folder on malformed preferences or an unknown choice', async () => {
    for (const value of ['{not json', { version: 2, backlogFile: 'todos' }, { version: 1, backlogFile: 'elsewhere' }]) {
      await prefs(value);
      expect(await sharedProjectPaths(project)).toMatchObject({ backlog: state(), backlogChoice: null });
    }
  });
  it('does not blame the state folder when the chosen TODOS.md is ignored by Git', async () => {
    await git(project, 'init', '-q'); await writeFile(path.join(project, '.gitignore'), 'TODOS.md\n');
    await prefs({ version: 1, backlogFile: 'todos' });
    const diagnostics = await inspectSharedIgnore(await sharedProjectPaths(project));
    expect(diagnostics.map(row => row.code)).not.toContain('parley-dir-ignored');
  });
});

describe('backlog writes under the chosen file', () => {
  it('a writer that waited for the lock during a switch lands in the new file', async () => {
    const paths = await sharedProjectPaths(project);
    let pending: Promise<unknown> = Promise.resolve();
    await withSharedProjectLock(paths, async () => {
      pending = addBacklogItem(project, { title: 'Late' });
      // Писатель успевает вычислить пути (ещё .parley) и ждёт замок; таймаут замка — 3 с.
      await new Promise(resolve => setTimeout(resolve, 500));
      await writeFile(paths.preferences, JSON.stringify({ version: 1, backlogFile: 'todos' }));
    });
    await pending;
    expect(await readFile(todos(), 'utf8')).toContain('Late');
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resolves the project context once per backlog write', async () => {
    // Под замком перечитывается только выбор файла: повторный git на каждую запись замедлял бэклог в разы.
    let calls = 0;
    const readGit = async (args: readonly string[], env: NodeJS.ProcessEnv) => {
      calls++;
      try { const result = await run('git', [...args], { env }); return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
      catch (error) {
        const failed = error as { code?: unknown; stdout?: string; stderr?: string };
        return { code: typeof failed.code === 'number' ? failed.code : null, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    };
    await sharedProjectPaths(project, { readGit });
    const perResolution = calls; calls = 0;
    await addBacklogItem(project, { title: 'Once' }, { readGit });
    expect(perResolution).toBeGreaterThan(0);
    expect(calls).toBe(perResolution);
  });
  it('keeps the mode of an existing backlog file', async () => {
    await prefs({ version: 1, backlogFile: 'todos' });
    await writeFile(todos(), '# TODOS\n'); await chmod(todos(), 0o755);
    await addBacklogItem(project, { title: 'Keeps mode' });
    expect((await stat(todos())).mode & 0o777).toBe(0o755);
  });
});

async function seedState(source: string): Promise<void> {
  await mkdir(path.join(project, '.parley'), { recursive: true }); await writeFile(state(), source);
}
const rows = async (file: string) => parseBacklog(await readFile(file, 'utf8'))
  .map(({ id, title, section, details, checked }) => ({ id, title, section, details, checked }));

describe('switching the backlog file', () => {
  it('moves state items with sections, details and IDs into TODOS.md and removes the state file', async () => {
    await writeFile(todos(), '# TODOS\n\nFree text stays.\n\n## Bugs\n- [ ] Mine\n');
    await seedState('# Backlog\n- [ ] First <!-- b-001 · by: s-01 -->\n  Detail line\n## Bugs\n- [x] Fixed <!-- b-002 · done: 2026-10-07 -->\n- [ ] Handwritten\n');
    await setBacklogFile(project, 'todos');
    const text = await readFile(todos(), 'utf8');
    expect(text.startsWith('# TODOS\n\nFree text stays.\n\n## Bugs\n- [ ] Mine')).toBe(true);
    expect(await rows(todos())).toEqual([
      { id: null, title: 'Mine', section: 'Bugs', details: '', checked: false },
      { id: 'b-002', title: 'Fixed', section: 'Bugs', details: '', checked: true },
      { id: 'b-003', title: 'Handwritten', section: 'Bugs', details: '', checked: false },
      { id: 'b-001', title: 'First', section: 'Backlog', details: 'Detail line', checked: false },
    ]);
    expect(parseBacklog(text).find(item => item.id === 'b-001')).toMatchObject({ by: 's-01' });
    expect(parseBacklog(text).find(item => item.id === 'b-002')).toMatchObject({ done: '2026-10-07' });
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await sharedProjectPaths(project)).backlogChoice).toBe('todos');
  });
  it('creates TODOS.md from the state file when the project has none', async () => {
    await seedState('# Backlog\n- [ ] Only <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect(await readFile(todos(), 'utf8')).toBe('# Backlog\n- [ ] Only <!-- b-001 -->\n');
  });
  it('a repeated move after a crash does not duplicate items', async () => {
    // Сбой после записи TODOS.md и до удаления файла состояния.
    await writeFile(todos(), '# TODOS\n\n## Backlog\n- [ ] Once <!-- b-001 -->\n');
    await seedState('# Backlog\n- [ ] Once <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.id)).toEqual(['b-001']);
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps moved items on their own lines in a CRLF TODOS.md without a final newline', async () => {
    await writeFile(todos(), '# TODOS\r\n- [ ] Mine <!-- b-009 -->');
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.title)).toEqual(['Mine', 'Moved']);
    // Перенесённые строки получают окончания строк TODOS.md, без смеси CRLF и LF.
    expect((await readFile(todos(), 'utf8')).replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
  it('keeps human notes of the state file there and moves only the items', async () => {
    await writeFile(todos(), '# TODOS\n');
    await seedState('# Backlog\nNotes: keep me.\n\n- [ ] Moved <!-- b-001 -->\n  Detail\n| A | B |\n');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.title)).toEqual(['Moved']);
    expect(await readFile(state(), 'utf8')).toBe('# Backlog\nNotes: keep me.\n\n| A | B |\n');
  });
  it('refuses duplicate IDs or a symlinked TODOS.md and changes nothing', async () => {
    await seedState('# Backlog\n- [ ] Stay <!-- b-001 -->\n');
    await writeFile(todos(), '- [ ] One <!-- b-007 -->\n- [ ] Two <!-- b-007 -->\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-invalid' });
    await rm(todos()); await writeFile(path.join(project, 'elsewhere.md'), ''); await symlink(path.join(project, 'elsewhere.md'), todos());
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    expect(await readFile(state(), 'utf8')).toContain('Stay');
    expect((await sharedProjectPaths(project)).backlogChoice).toBeNull();
  });
  it('refuses a TODOS.md item with the same ID but other text instead of losing the state item', async () => {
    await seedState('# Backlog\n- [ ] Refactor store <!-- b-005 -->\n');
    await writeFile(todos(), '# TODOS\n- [ ] Fix login <!-- b-005 -->\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(state(), 'utf8')).toContain('Refactor store');
    expect((await sharedProjectPaths(project)).backlogChoice).toBeNull();
  });
  it('refuses an unreadable TODOS.md even when there is nothing to move', async () => {
    await writeFile(todos(), '# TODOS\n```\n- [ ] Open <!-- b-001 -->\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-invalid' });
    await writeFile(todos(), '<<<<<<< ours\n- [ ] A\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-merge-conflict' });
    await rm(todos()); await mkdir(todos());
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    expect((await sharedProjectPaths(project)).backlogChoice).toBeNull();
  });
  it('refuses an unclosed code block in TODOS.md when every state ID is already there', async () => {
    await seedState('# Backlog\n- [ ] Once <!-- b-001 -->\n');
    await writeFile(todos(), '# TODOS\n- [ ] Once <!-- b-001 -->\n```\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-invalid' });
    expect((await sharedProjectPaths(project)).backlogChoice).toBeNull();
  });
  it('refuses the switch over malformed preferences before touching files', async () => {
    await seedState('# Backlog\n- [ ] Stay <!-- b-001 -->\n'); await prefs('{broken');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'preferences-invalid' });
    expect(await readFile(state(), 'utf8')).toContain('Stay');
    await expect(lstat(todos())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('switching back leaves TODOS.md untouched and new items go to the state file', async () => {
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    const before = await readFile(todos(), 'utf8');
    await setBacklogFile(project, 'state');
    await addBacklogItem(project, { title: 'Back home' });
    expect(await readFile(todos(), 'utf8')).toBe(before);
    expect(await readFile(state(), 'utf8')).toContain('Back home');
  });
  it('keeps IDs unique across both files after switching back and forth, so nothing is lost on the next move', async () => {
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos'); await setBacklogFile(project, 'state');
    expect((await addBacklogItem(project, { title: 'Back home' })).id).toBe('b-002');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.title)).toEqual(['Moved', 'Back home']);
  });
  it('moves into TODOS.md of the main checkout when switched from a linked worktree', async () => {
    const main = path.join(project, 'main'); await mkdir(main);
    await git(main, 'init', '-q', '-b', 'main'); await writeFile(path.join(main, 'a'), 'a'); await git(main, 'add', '.');
    await git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture');
    const linked = path.join(project, 'linked'); await git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
    await addBacklogItem(linked, { title: 'From worktree' });
    await setBacklogFile(linked, 'todos');
    expect(await readFile(path.join(main, 'TODOS.md'), 'utf8')).toContain('From worktree');
    await expect(lstat(path.join(linked, 'TODOS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
