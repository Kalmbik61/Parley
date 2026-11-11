import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKTREE_INCLUDE_FILE } from './worktree-include.js';
import { seedWorktree, type SeedDeps } from './worktree-seed.js';

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

let root = '';
let project = '';
let copy = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-seed-'));
  project = path.join(root, 'project');
  copy = path.join(root, 'copy');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(base: string, rel: string, content = 'x\n'): Promise<void> {
  const file = path.join(base, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Репозиторий с одним коммитом и связанной копией `copy`; в основной копии лежит список `.worktreeinclude`. */
async function setup(list: string, tracked: string[] = []): Promise<void> {
  await mkdir(project, { recursive: true });
  await run('git', ['init', '-b', 'main', project]);
  await git(project, ['config', 'user.email', 'тест@parley']);
  await git(project, ['config', 'user.name', 'тест']);
  await put(project, '.gitignore', 'node_modules/\n.env\nbig/\n');
  await put(project, 'README.md', 'старт\n');
  for (const rel of tracked) await put(project, rel);
  await git(project, ['add', '.gitignore', 'README.md', ...tracked]);
  await git(project, ['commit', '-m', 'первый']);
  await git(project, ['worktree', 'add', '-b', 'copy-branch', copy]);
  await put(project, WORKTREE_INCLUDE_FILE, list);
}

async function gitDirOf(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
}

/** Подмена клона на обычное копирование: тесты идут в CI на Linux, настоящего cp -c там нет. */
function fakeDeps(extra: SeedDeps = {}): SeedDeps & { calls: { count: number } } {
  const calls = { count: 0 };
  return {
    platform: 'darwin',
    sameCloneVolume: async () => true,
    clonePath: async (source, stage) => {
      calls.count += 1;
      await cp(source, stage, { recursive: true });
    },
    ...extra,
    calls,
  };
}

describe('seedWorktree', () => {
  it('нет списка — null', async () => {
    await setup('node_modules\n');
    await rm(path.join(project, WORKTREE_INCLUDE_FILE));
    await put(project, 'node_modules/x.js');
    expect(await seedWorktree(project, copy, fakeDeps())).toBeNull();
  });

  it('клон каталога и файла', async () => {
    await setup('node_modules\n.env\n');
    await put(project, 'node_modules/x.js', 'модуль\n');
    await put(project, '.env', 'KEY=1\n');
    const report = await seedWorktree(project, copy, fakeDeps());
    expect(report).not.toBeNull();
    expect(report?.cloned).toEqual(['.env', 'node_modules']);
    expect(report?.skipped).toEqual([]);
    expect(report?.unavailable).toBe(false);
    expect(await readFile(path.join(copy, 'node_modules/x.js'), 'utf8')).toBe('модуль\n');
    expect(await readFile(path.join(copy, '.env'), 'utf8')).toBe('KEY=1\n');
    expect((await git(copy, ['status', '--porcelain'])).stdout).toBe('');
    expect(await exists(path.join(await gitDirOf(copy), 'parley-seed'))).toBe(false);
  });

  it('не macOS — unavailable, cp не зовётся', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const deps = fakeDeps({ platform: 'linux' });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.unavailable).toBe(true);
    expect(report?.cloned).toEqual([]);
    expect(report?.skipped).toEqual([]);
    expect(deps.calls.count).toBe(0);
    expect(await exists(path.join(copy, 'node_modules'))).toBe(false);
  });

  it('другой том — unavailable', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const other = fakeDeps({ sameCloneVolume: async () => false });
    expect((await seedWorktree(project, copy, other))?.unavailable).toBe(true);
    expect(other.calls.count).toBe(0);
    const throwing = fakeDeps({
      sameCloneVolume: async () => {
        throw new Error('df упал');
      },
    });
    expect((await seedWorktree(project, copy, throwing))?.unavailable).toBe(true);
    expect(throwing.calls.count).toBe(0);
  });

  it('цель существует', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    await put(copy, 'node_modules/own.txt', 'свой\n');
    const report = await seedWorktree(project, copy, fakeDeps());
    expect(report?.cloned).toEqual([]);
    expect(report?.skipped).toEqual([]);
    expect(await readFile(path.join(copy, 'node_modules/own.txt'), 'utf8')).toBe('свой\n');
    expect(await exists(path.join(copy, 'node_modules/x.js'))).toBe(false);
  });

  it('предел записей', async () => {
    await setup('big\n.env\n');
    for (let i = 0; i < 5; i += 1) await put(project, `big/f${i}.txt`);
    await put(project, '.env', 'KEY=1\n');
    const report = await seedWorktree(project, copy, fakeDeps({ maxEntries: 3 }));
    expect(report?.skipped).toEqual([{ path: 'big', reason: 'entries' }]);
    expect(report?.cloned).toEqual(['.env']);
    expect(await exists(path.join(copy, 'big'))).toBe(false);
  });

  it('срок шага', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const deps = fakeDeps({
      timeoutMs: 50,
      clonePath: (_source, _stage, _isDirectory, signal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(new Error('прервано'));
          signal.addEventListener('abort', () => reject(new Error('прервано')));
        }),
    });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.skipped).toEqual([{ path: 'node_modules', reason: 'timeout' }]);
    expect(report?.cloned).toEqual([]);
    expect(await exists(path.join(copy, 'node_modules'))).toBe(false);
    expect(await exists(path.join(await gitDirOf(copy), 'parley-seed'))).toBe(false);
  });

  it('сбой клона', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const deps = fakeDeps({
      clonePath: async (_source, stage) => {
        await mkdir(stage, { recursive: true });
        await writeFile(path.join(stage, 'part.js'), 'обрывок\n', 'utf8');
        throw new Error('основная копия изменилась');
      },
    });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.skipped).toEqual([{ path: 'node_modules', reason: 'failed' }]);
    expect(report?.cloned).toEqual([]);
    expect(await exists(path.join(copy, 'node_modules'))).toBe(false);
    expect(await exists(path.join(await gitDirOf(copy), 'parley-seed'))).toBe(false);
  });

  it('остаток прошлого шага', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const stageRoot = path.join(await gitDirOf(copy), 'parley-seed');
    await put(stageRoot, 'old/x');
    const report = await seedWorktree(project, copy, fakeDeps());
    expect(report?.cloned).toEqual(['node_modules']);
    expect(await exists(path.join(stageRoot, 'old'))).toBe(false);
    expect(await exists(stageRoot)).toBe(false);
    expect(await exists(path.join(copy, 'node_modules/x.js'))).toBe(true);
  });

  it('цель появилась во время клона', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const deps = fakeDeps({
      clonePath: async (source, stage) => {
        await cp(source, stage, { recursive: true });
        await put(copy, 'node_modules/own.txt', 'свой\n');
      },
    });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.skipped).toEqual([{ path: 'node_modules', reason: 'failed' }]);
    expect(report?.cloned).toEqual([]);
    expect(await readFile(path.join(copy, 'node_modules/own.txt'), 'utf8')).toBe('свой\n');
    expect(await exists(path.join(copy, 'node_modules/x.js'))).toBe(false);
    expect(await exists(path.join(await gitDirOf(copy), 'parley-seed'))).toBe(false);
  });

  it('lock-файл отличается', async () => {
    await setup('node_modules\n', ['pnpm-lock.yaml', 'packages/a/package-lock.json']);
    await put(project, 'node_modules/x.js');
    await put(project, 'pnpm-lock.yaml', 'другой\n');
    await rm(path.join(project, 'packages/a/package-lock.json'));
    const report = await seedWorktree(project, copy, fakeDeps());
    expect(report?.cloned).toEqual(['node_modules']);
    expect(report?.lockMismatch).toEqual(['packages/a/package-lock.json', 'pnpm-lock.yaml']);
  });

  it('lock-файлы совпадают — расхождений нет', async () => {
    await setup('node_modules\n', ['pnpm-lock.yaml']);
    await put(project, 'node_modules/x.js');
    const report = await seedWorktree(project, copy, fakeDeps());
    expect(report?.lockMismatch).toEqual([]);
  });

  it('pnpm: зависимости старше lock-файла', async () => {
    await setup('node_modules\n', ['pnpm-lock.yaml']);
    await put(project, 'node_modules/.pnpm/lock.yaml', 'другой текст\n');
    const stale = await seedWorktree(project, copy, fakeDeps());
    expect(stale?.cloned).toEqual(['node_modules']);
    expect(stale?.stale).toBe(true);

    await rm(path.join(copy, 'node_modules'), { recursive: true, force: true });
    await put(project, 'node_modules/.pnpm/lock.yaml', 'x\n');
    const fresh = await seedWorktree(project, copy, fakeDeps());
    expect(fresh?.cloned).toEqual(['node_modules']);
    expect(fresh?.stale).toBe(false);
  });
});
