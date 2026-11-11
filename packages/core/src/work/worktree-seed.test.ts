import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKTREE_INCLUDE_FILE } from './worktree-include.js';
import { describeSeed, seedWorktree, toWorktreeSeed, type SeedDeps, type SeedReport } from './worktree-seed.js';
import type { WorktreeSeed } from './types.js';

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
    const throwingSync = fakeDeps({
      sameCloneVolume: () => {
        throw new Error('df упал сразу');
      },
    });
    expect((await seedWorktree(project, copy, throwingSync))?.unavailable).toBe(true);
    expect(throwingSync.calls.count).toBe(0);
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

  it('пустая цель появилась во время клона — не заменена', async () => {
    await setup('node_modules\n');
    await put(project, 'node_modules/x.js');
    const deps = fakeDeps({
      clonePath: async (source, stage) => {
        await cp(source, stage, { recursive: true });
        await mkdir(path.join(copy, 'node_modules'));
      },
    });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.skipped).toEqual([{ path: 'node_modules', reason: 'failed' }]);
    expect(report?.cloned).toEqual([]);
    expect(await exists(path.join(copy, 'node_modules'))).toBe(true);
    expect(await readdir(path.join(copy, 'node_modules'))).toEqual([]);
    expect(await exists(path.join(await gitDirOf(copy), 'parley-seed'))).toBe(false);
  });

  it('после срока остальные пути не клонируются', async () => {
    await setup('node_modules\n.env\n');
    await put(project, 'node_modules/x.js');
    await put(project, '.env', 'KEY=1\n');
    let calls = 0;
    const deps = fakeDeps({
      timeoutMs: 500,
      clonePath: (_source, _stage, _isDirectory, signal) => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(new Error('прервано'));
          signal.addEventListener('abort', () => reject(new Error('прервано')));
        });
      },
    });
    const report = await seedWorktree(project, copy, deps);
    expect(report?.skipped).toEqual([
      { path: '.env', reason: 'timeout' },
      { path: 'node_modules', reason: 'timeout' },
    ]);
    expect(report?.cloned).toEqual([]);
    expect(calls).toBeLessThanOrEqual(1);
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

function reportOf(extra: Partial<SeedReport> = {}): SeedReport {
  return { sourceRoot: '/main', cloned: [], skipped: [], lockMismatch: [], stale: false, unavailable: false, ...extra };
}

describe('toWorktreeSeed', () => {
  const at = '2026-11-11T10:00:00.000Z';

  it('ничего и без отказов — null', () => {
    expect(toWorktreeSeed(reportOf(), at)).toBeNull();
  });

  it('unavailable — null', () => {
    expect(toWorktreeSeed(reportOf({ unavailable: true }), at)).toBeNull();
  });

  it('обрезка', () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ path: `p${i}`, reason: 'failed' as const }));
    const lockMismatch = ['a', 'b', 'c', 'd', 'e'];
    const seed = toWorktreeSeed(reportOf({ cloned: ['node_modules'], skipped, lockMismatch }), at);
    expect(seed?.skipped).toHaveLength(5);
    expect(seed?.lockMismatch).toHaveLength(3);
  });

  it('ключей нет, когда пусто', () => {
    expect(toWorktreeSeed(reportOf({ cloned: ['node_modules'] }), at)).toEqual({
      at,
      cloned: 1,
      first: 'node_modules',
    });
  });
});

describe('describeSeed', () => {
  const base: WorktreeSeed = { at: '2026-11-11T10:00:00.000Z', cloned: 1, first: 'node_modules' };

  it('один путь, lock-файлы совпали', () => {
    expect(describeSeed(base)).toBe(
      'Dependencies: `node_modules` was cloned from the main checkout; lock files match, no install is needed.',
    );
  });

  it('несколько путей', () => {
    expect(describeSeed({ ...base, cloned: 3 })).toBe(
      'Dependencies: `node_modules` and 2 more ignored paths were cloned from the main checkout; lock files match, no install is needed.',
    );
  });

  it('расхождение двух lock-файлов главнее stale', () => {
    expect(describeSeed({ ...base, lockMismatch: ['pnpm-lock.yaml', 'yarn.lock'], stale: true })).toBe(
      "Dependencies: `node_modules` was cloned from the main checkout, but `pnpm-lock.yaml`, `yarn.lock` differ from the main checkout — run the project's install before you build or test.",
    );
  });

  it('расхождение одного lock-файла', () => {
    expect(describeSeed({ ...base, lockMismatch: ['pnpm-lock.yaml'] })).toBe(
      "Dependencies: `node_modules` was cloned from the main checkout, but `pnpm-lock.yaml` differs from the main checkout — run the project's install before you build or test.",
    );
  });

  it('только stale', () => {
    expect(describeSeed({ ...base, stale: true })).toBe(
      "Dependencies: `node_modules` was cloned from the main checkout, but they are older than this worktree's lock file — run the project's install before you build or test.",
    );
  });

  it('ничего не склонировано, отказ entries', () => {
    expect(
      describeSeed({ ...base, cloned: 0, first: null, skipped: [{ path: 'node_modules', reason: 'entries' }] }),
    ).toBe('Dependencies: nothing was cloned from the main checkout. Not cloned: `node_modules` (too many files).');
  });

  it('хвост с тремя причинами', () => {
    expect(
      describeSeed({
        ...base,
        skipped: [
          { path: 'a', reason: 'entries' },
          { path: 'b', reason: 'timeout' },
          { path: 'c', reason: 'failed' },
        ],
      }),
    ).toBe(
      'Dependencies: `node_modules` was cloned from the main checkout; lock files match, no install is needed. Not cloned: `a` (too many files), `b` (timed out), `c` (failed).',
    );
  });

  it('имя с переводом строки и обратной кавычкой не ломает строку', () => {
    const text = describeSeed({
      ...base,
      first: 'a\nb`c',
      skipped: [{ path: 'x\ny`z', reason: 'failed' }],
    });
    expect(text).not.toContain('\n');
    expect((text.match(/`/g) ?? []).length % 2).toBe(0);
  });
});
