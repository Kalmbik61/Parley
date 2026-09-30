import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitBranch } from './git.js';

const run = promisify(execFile);

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-git-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gitBranch', () => {
  it('берёт имя ветки из символической ссылки настоящего репозитория', async () => {
    await run('git', ['init', '-b', 'feat/pay', dir]);
    expect(await gitBranch(dir)).toBe('feat/pay');
  });

  it('у отсоединённой головы показывает короткий хэш', async () => {
    await run('git', ['init', '-b', 'main', dir]);
    await run('git', [
      '-C',
      dir,
      '-c',
      'user.email=тест@parley',
      '-c',
      'user.name=тест',
      'commit',
      '--allow-empty',
      '-m',
      'первый',
    ]);
    await run('git', ['-C', dir, 'checkout', '--detach']);

    const branch = await gitBranch(dir);
    expect(branch).toMatch(/^[0-9a-f]{7}$/);
  });

  it('в worktree `.git` — файл `gitdir:`, ветка берётся по ссылке', async () => {
    await run('git', ['init', '-b', 'main', dir]);
    await run('git', [
      '-C',
      dir,
      '-c',
      'user.email=тест@parley',
      '-c',
      'user.name=тест',
      'commit',
      '--allow-empty',
      '-m',
      'первый',
    ]);
    const tree = path.join(dir, '..', path.basename(dir) + '-wt');
    await run('git', ['-C', dir, 'worktree', 'add', '-b', 'feat/pay', tree]);

    try {
      expect(await gitBranch(tree)).toBe('feat/pay');
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });

  it('не репозиторий и пустой HEAD — ветки нет', async () => {
    expect(await gitBranch(dir)).toBeNull();
    await run('git', ['init', '-b', 'main', dir]);
    await writeFile(path.join(dir, '.git', 'HEAD'), '\n');
    expect(await gitBranch(dir)).toBeNull();
  });

  it('тег в HEAD за ветку не выдаётся', async () => {
    await run('git', ['init', '-b', 'main', dir]);
    await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/tags/v1\n');
    expect(await gitBranch(dir)).toBeNull();
  });
});
