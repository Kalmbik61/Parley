import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSpawnCount, resetProjectContextCache, resolveMainCheckout, resolveSharedProjectContext, sharedPathIgnored } from './project-context.js';
import { addBacklogItem } from './backlog.js';
import { readProjectPreferences, setBacklogRule } from './project-preferences.js';
import { readSharedFile, sharedProjectPaths, workPaths } from './store.js';

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
  it('skips prunable linked worktrees whose folders were deleted', async () => {
    const main = await repository(); const gone = path.join(root, 'gone'); const live = path.join(root, 'live');
    await git(main, 'worktree', 'add', '-b', 'gone', gone); await git(main, 'worktree', 'add', '-b', 'live', live);
    await rm(gone, { recursive: true, force: true });
    expect(await resolveSharedProjectContext(main)).toMatchObject({ kind: 'git', projectPath: main, mainRoot: main });
    expect(await resolveSharedProjectContext(live)).toMatchObject({ kind: 'git', projectPath: main, checkoutRoot: live, mainRoot: main });
    expect(await resolveMainCheckout(live)).toBe(main);
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

describe('кэш git-контекста проекта', () => {
  beforeEach(() => { resetProjectContextCache(); });
  afterEach(() => { vi.useRealTimers(); });

  it('10 вызовов sharedProjectPaths подряд запускают git один набор раз (4 процесса)', async () => {
    const main = await repository();
    const before = gitSpawnCount();
    for (let index = 0; index < 10; index += 1) await sharedProjectPaths(main);
    expect(gitSpawnCount() - before).toBe(4);
  });

  it('10 одновременных вызовов делят один набор процессов', async () => {
    const main = await repository();
    const before = gitSpawnCount();
    await Promise.all(Array.from({ length: 10 }, () => sharedProjectPaths(main)));
    expect(gitSpawnCount() - before).toBe(4);
  });

  it('после 10 с проход повторяется', async () => {
    const main = await repository();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    await sharedProjectPaths(main);
    const before = gitSpawnCount();
    vi.setSystemTime(1_000_000 + 9_999);
    await sharedProjectPaths(main);
    expect(gitSpawnCount() - before).toBe(0);
    vi.setSystemTime(1_000_000 + 10_001);
    await sharedProjectPaths(main);
    expect(gitSpawnCount() - before).toBe(4);
  });

  it('изменение .git (новый mtime) сбрасывает кэш', async () => {
    const main = await repository();
    await sharedProjectPaths(main);
    const before = gitSpawnCount();
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(main, '.git'), later, later);
    await sharedProjectPaths(main);
    expect(gitSpawnCount() - before).toBe(4);
  });

  it('git init после закэшированного non-git виден сразу', async () => {
    const plain = path.join(root, 'plain'); await mkdir(plain);
    expect(await resolveSharedProjectContext(plain)).toEqual({ kind: 'non-git', projectPath: plain });
    const before = gitSpawnCount();
    expect(await resolveSharedProjectContext(plain)).toEqual({ kind: 'non-git', projectPath: plain });
    expect(gitSpawnCount() - before).toBe(0);
    await git(plain, 'init', '-b', 'main');
    expect(await resolveSharedProjectContext(plain)).toMatchObject({ kind: 'git', mainRoot: plain });
  });

  it('вложенный репозиторий, созданный после кэша, виден сразу', async () => {
    const main = await repository(); const nested = path.join(main, 'nested');
    expect(await resolveMainCheckout(nested)).toBe(main);
    await git(nested, 'init', '-b', 'main');
    expect(await resolveMainCheckout(nested)).toBe(nested);
  });

  it('удалённый worktree не обслуживается из кэша', async () => {
    const main = await repository(); const linked = path.join(root, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', linked);
    expect(await resolveSharedProjectContext(linked)).toMatchObject({ kind: 'git', mainRoot: main });
    await git(main, 'worktree', 'remove', '--force', linked);
    expect(await resolveSharedProjectContext(linked)).toEqual({ kind: 'unavailable', reason: 'project-unavailable' });
  });

  it('unavailable не кэшируется: второй вызов снова запускает git', async () => {
    const bare = path.join(root, 'bare'); await git(root, 'init', '--bare', bare);
    const before = gitSpawnCount();
    expect((await resolveSharedProjectContext(bare)).kind).toBe('unavailable');
    expect((await resolveSharedProjectContext(bare)).kind).toBe('unavailable');
    expect(gitSpawnCount() - before).toBe(4);
  });

  it('sharedPathIgnored: повторные вызовы — один check-ignore; правки всех видимых .gitignore и exclude сбрасывают', async () => {
    const main = await repository();
    const context = (await sharedProjectPaths(main)).context;
    if (context.kind !== 'git') throw new Error('expected a git context');
    const file = path.join(main, '.parley', 'backlog.md');
    const before = gitSpawnCount();
    for (let index = 0; index < 5; index += 1) expect(await sharedPathIgnored(context, file)).toBe(false);
    expect(gitSpawnCount() - before).toBe(1);

    await writeFile(path.join(main, '.gitignore'), '.parley/\n');
    expect(await sharedPathIgnored(context, file)).toBe(true);
    expect(await sharedPathIgnored(context, file)).toBe(true);
    expect(gitSpawnCount() - before).toBe(2);

    await rm(path.join(main, '.gitignore'));
    expect(await sharedPathIgnored(context, file)).toBe(false);
    await mkdir(path.join(main, '.parley'));
    await writeFile(path.join(main, '.parley', '.gitignore'), '*\n');
    expect(await sharedPathIgnored(context, file)).toBe(true);

    await rm(path.join(main, '.parley'), { recursive: true });
    expect(await sharedPathIgnored(context, file)).toBe(false);
    await mkdir(path.join(main, '.git', 'info'), { recursive: true });
    await writeFile(path.join(main, '.git', 'info', 'exclude'), '.parley/\n');
    expect(await sharedPathIgnored(context, file)).toBe(true);
  });

  it('сбой git в check-ignore не кэшируется и не считается «игнорируется»', async () => {
    const nowhere = path.join(root, 'nowhere');
    const context = { kind: 'git', projectPath: nowhere, mainRoot: nowhere, checkoutRoot: nowhere } as const;
    const before = gitSpawnCount();
    expect(await sharedPathIgnored(context, path.join(nowhere, 'a'))).toBe(false);
    expect(await sharedPathIgnored(context, path.join(nowhere, 'a'))).toBe(false);
    expect(gitSpawnCount() - before).toBe(2);
  });

  it('с options.readGit кэш не используется', async () => {
    const plain = path.join(root, 'plain'); await mkdir(plain);
    let calls = 0;
    const readGit = async (args: readonly string[]) => {
      calls += 1;
      return args[0] === 'rev-parse' && args[1] === '--local-env-vars'
        ? { code: 0, stdout: 'GIT_DIR\n', stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' };
    };
    const before = gitSpawnCount();
    expect(await resolveSharedProjectContext(plain, { readGit })).toEqual({ kind: 'non-git', projectPath: plain });
    expect(await resolveSharedProjectContext(plain, { readGit })).toEqual({ kind: 'non-git', projectPath: plain });
    expect(calls).toBe(4);
    expect(gitSpawnCount() - before).toBe(0);
  });
});
