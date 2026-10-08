import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMainCheckout, resolveSharedProjectContext } from './project-context.js';
import { addBacklogItem } from './backlog.js';
import { readProjectPreferences, setBacklogRule } from './project-preferences.js';
import { readSharedFile, workPaths } from './store.js';

const run = promisify(execFile);
let root = '';
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-project-context-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function repository(name = 'main'): Promise<string> {
  const main = path.join(root, name); await mkdir(main);
  await git(main, 'init', '-b', 'main');
  await mkdir(path.join(main, 'nested')); await writeFile(path.join(main, 'nested', 'a'), 'a');
  await git(main, 'add', '.');
  await git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  return main;
}

describe('shared project identity', () => {
  it('proves non-Git canonical directories, including aliases, without inventing a main root', async () => {
    const actual = path.join(root, 'plain'); await mkdir(actual);
    const alias = path.join(root, 'alias'); await symlink(actual, alias);
    expect(await resolveSharedProjectContext(alias)).toEqual({ kind: 'non-git', projectPath: actual });
    expect(await resolveMainCheckout(alias)).toBeNull();
  });
  it('proves non-Git under a stub .git ancestor that holds no HEAD, objects or refs', async () => {
    // The `~/.git` stub GitKraken leaves behind: Git itself skips it.
    const home = path.join(root, 'home'); const project = path.join(home, 'project');
    await mkdir(path.join(home, '.git', 'gk'), { recursive: true }); await mkdir(path.join(home, '.git', 'info'));
    await writeFile(path.join(home, '.git', 'gk', 'config'), ''); await writeFile(path.join(home, '.git', 'info', 'exclude'), '');
    await mkdir(project);
    expect(await resolveSharedProjectContext(project)).toEqual({ kind: 'non-git', projectPath: project });
  });
  it('proves non-Git next to lone HEAD/objects/refs entries that are not a bare repository', async () => {
    for (const [name, made] of [['HEAD', 'file'], ['objects', 'dir'], ['refs', 'dir']] as const) {
      const area = path.join(root, `area-${name}`); const project = path.join(area, 'project');
      await mkdir(project, { recursive: true });
      if (made === 'file') await writeFile(path.join(area, name), ''); else await mkdir(path.join(area, name));
      expect(await resolveSharedProjectContext(project)).toEqual({ kind: 'non-git', projectPath: project });
    }
  });
  it('keeps broken repository look-alikes ambiguous', async () => {
    // A broken `.git` (HEAD present, Git rejects it) and a folder with all three bare parts prove nothing.
    const broken = path.join(root, 'broken'); await mkdir(path.join(broken, '.git'), { recursive: true });
    await writeFile(path.join(broken, '.git', 'HEAD'), ''); await mkdir(path.join(broken, 'project'));
    expect(await resolveSharedProjectContext(path.join(broken, 'project'))).toEqual({ kind: 'unavailable', reason: 'git-context-unverified' });
    const bare = path.join(root, 'bare-like'); await mkdir(path.join(bare, 'objects'), { recursive: true });
    await mkdir(path.join(bare, 'refs')); await writeFile(path.join(bare, 'HEAD'), ''); await mkdir(path.join(bare, 'project'));
    expect(await resolveSharedProjectContext(path.join(bare, 'project'))).toEqual({ kind: 'unavailable', reason: 'git-context-unverified' });
  });
  it('maps root and explicit nested folders to the same folder in the main checkout', async () => {
    const main = await repository(); const linked = path.join(root, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', linked);
    expect(await resolveSharedProjectContext(linked)).toMatchObject({ kind: 'git', projectPath: main, mainRoot: main });
    expect(await resolveSharedProjectContext(path.join(linked, 'nested'))).toMatchObject({
      kind: 'git', projectPath: path.join(main, 'nested'), checkoutRoot: linked, mainRoot: main,
    });
  });
  it('does not substitute another folder when the corresponding main folder is missing', async () => {
    const main = await repository(); const linked = path.join(root, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', linked); await mkdir(path.join(linked, 'only-linked'));
    expect(await resolveSharedProjectContext(path.join(linked, 'only-linked'))).toEqual({ kind: 'unavailable', reason: 'main-project-unavailable' });
    expect(await resolveMainCheckout(path.join(linked, 'only-linked'))).toBe(main);
  });
  it('preserves newline checkout/folder names through native NUL records and one final LF', async () => {
    const main = await repository('main\nfolder'); const linked = path.join(root, 'linked\nfolder');
    await git(main, 'worktree', 'add', '-b', 'linked', linked);
    expect(await resolveMainCheckout(linked)).toBe(main);
    expect(await resolveSharedProjectContext(path.join(linked, 'nested'))).toMatchObject({ projectPath: path.join(main, 'nested') });
  });
  it('writes shared backlog/preferences in the corresponding nested main folder while runtime paths stay local', async () => {
    const main = await repository(); const linked = path.join(root, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', linked);
    const participant = path.join(linked, 'nested');
    await addBacklogItem(participant, { title: 'Shared nested' }); await setBacklogRule(participant, 'ask');
    expect((await readSharedFile(path.join(main, 'nested', '.parley', 'backlog.md'))).text).toContain('Shared nested');
    expect(await readProjectPreferences(path.join(main, 'nested'))).toEqual({ backlogRule: 'ask' });
    expect((await readSharedFile(path.join(main, '.parley', 'backlog.md'))).version).toBe('missing');
    expect((await readSharedFile(path.join(participant, '.parley', 'backlog.md'))).version).toBe('missing');
    expect(workPaths(participant, 'w-0001').dir).toBe(path.join(participant, '.parley', 'works', 'w-0001'));
  });
  it('isolates inherited repository/config/discovery selectors', async () => {
    const main = await repository();
    expect(await resolveMainCheckout(main, { env: { ...process.env, GIT_DIR: '/missing', GIT_WORK_TREE: '/wrong',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true', GIT_CEILING_DIRECTORIES: root } })).toBe(main);
  });
  it('refuses malformed .git, bare repositories and corresponding symlink escape', async () => {
    const bad = path.join(root, 'bad'); await mkdir(bad); await writeFile(path.join(bad, '.git'), 'gitdir: /missing');
    expect((await resolveSharedProjectContext(bad)).kind).toBe('unavailable');
    const bare = path.join(root, 'bare'); await git(root, 'init', '--bare', bare);
    expect((await resolveSharedProjectContext(bare)).kind).toBe('unavailable');
    const main = await repository(); const linked = path.join(root, 'linked'); await git(main, 'worktree', 'add', '-b', 'linked', linked);
    await mkdir(path.join(linked, 'escape')); await symlink(root, path.join(main, 'escape'));
    expect((await resolveSharedProjectContext(path.join(linked, 'escape'))).kind).toBe('unavailable');
  });
  it('does not treat transport/config failure as proof of non-Git', async () => {
    expect((await resolveSharedProjectContext(root, { readGit: async () => ({ code: null, stdout: '', stderr: '' }) })).kind).toBe('unavailable');
    let calls = 0;
    expect((await resolveSharedProjectContext(root, { readGit: async () => ++calls === 1 ?
      { code: 0, stdout: 'GIT_DIR\n', stderr: '' } : { code: 128, stdout: '', stderr: 'fatal: bad config\n' } })).kind).toBe('unavailable');
  });
  it('rejects unlisted roots and missing directories', async () => {
    const responses = ['GIT_DIR\n', 'true\n', `worktree ${root}\0HEAD x\0\0`, `${root}/missing\n`];
    expect((await resolveSharedProjectContext(root, { readGit: async () => ({ code: 0, stdout: responses.shift() ?? '', stderr: '' }) })).kind).toBe('unavailable');
    expect((await resolveSharedProjectContext(path.join(root, 'deleted'))).kind).toBe('unavailable');
  });
});
