import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectSharedIgnore, sharedProjectPaths } from './store.js';

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
