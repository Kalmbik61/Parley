import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INCLUDE_MAX_ENTRIES,
  INCLUDE_MAX_FILE_BYTES,
  listIncludePaths,
  resolveIncludePaths,
  WORKTREE_INCLUDE_FILE,
} from './worktree-include.js';

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

let root = '';
let project = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-include-'));
  project = path.join(root, 'project');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Записать файл, создав каталоги по пути. */
async function put(base: string, rel: string, content = 'x\n'): Promise<void> {
  const file = path.join(base, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** Репозиторий с одним коммитом: `.gitignore` с заданным текстом, README и перечисленные отслеживаемые файлы. */
async function initRepo(dir: string, gitignore: string, tracked: string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-b', 'main', dir]);
  await git(dir, ['config', 'user.email', 'тест@parley']);
  await git(dir, ['config', 'user.name', 'тест']);
  await put(dir, '.gitignore', gitignore);
  await put(dir, 'README.md', 'старт\n');
  for (const rel of tracked) await put(dir, rel);
  await git(dir, ['add', '.gitignore', 'README.md', ...tracked]);
  await git(dir, ['commit', '-m', 'первый']);
}

describe('listIncludePaths', () => {
  it('каталог и шаблон со звёздочкой, отрицание', async () => {
    await initRepo(project, 'node_modules/\ndist/\n');
    await put(project, WORKTREE_INCLUDE_FILE, 'node_modules\npackages/*/dist\n!packages/b/dist\n');
    await put(project, 'node_modules/x.js');
    await put(project, 'packages/a/dist/i.js');
    await put(project, 'packages/b/dist/i.js');
    expect(await listIncludePaths(project)).toEqual(['node_modules', 'packages/a/dist']);
  });

  it('отслеживаемый файл не попадает', async () => {
    await initRepo(project, 'node_modules/\n');
    await put(project, WORKTREE_INCLUDE_FILE, 'README.md\n');
    expect(await listIncludePaths(project)).toEqual([]);
  });

  it('частично отслеживаемый каталог', async () => {
    await initRepo(project, 'gen/*.tmp\n', ['gen/keep.txt']);
    await put(project, 'gen/a.tmp');
    await put(project, WORKTREE_INCLUDE_FILE, 'gen\n');
    expect(await listIncludePaths(project)).toEqual(['gen/a.tmp']);
  });

  it('вложенная запись не дублируется', async () => {
    await initRepo(project, 'node_modules/\n');
    await put(project, WORKTREE_INCLUDE_FILE, 'node_modules\nnode_modules/.bin\n');
    await put(project, 'node_modules/.bin/tool');
    await put(project, 'node_modules/x.js');
    expect(await listIncludePaths(project)).toEqual(['node_modules']);
  });

  it('путь с пробелом', async () => {
    const spaced = path.join(root, 'my project');
    await initRepo(spaced, 'my deps/\n');
    await put(spaced, WORKTREE_INCLUDE_FILE, 'my deps\n');
    await put(spaced, 'my deps/a.js');
    expect(await listIncludePaths(spaced)).toEqual(['my deps']);
  });

  it('симлинк верхнего уровня пропущен', async () => {
    await initRepo(project, 'linked\n');
    await put(project, WORKTREE_INCLUDE_FILE, 'linked\n');
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(project, 'linked'));
    expect(await listIncludePaths(project)).toEqual([]);
  });

  it('нет файла списка', async () => {
    await initRepo(project, 'node_modules/\n');
    await put(project, 'node_modules/x.js');
    expect(await listIncludePaths(project)).toEqual([]);
  });

  it('пустой файл списка', async () => {
    await initRepo(project, 'node_modules/\n');
    await put(project, 'node_modules/x.js');
    await put(project, WORKTREE_INCLUDE_FILE, '');
    expect(await listIncludePaths(project)).toEqual([]);
  });

  it('файл списка больше предела', async () => {
    await initRepo(project, 'node_modules/\n');
    await put(project, 'node_modules/x.js');
    await put(
      project,
      WORKTREE_INCLUDE_FILE,
      `node_modules\n${'#'.repeat(INCLUDE_MAX_FILE_BYTES)}\n`,
    );
    expect(await listIncludePaths(project)).toEqual([]);
  });

  it('больше 1000 записей — первые 1000', async () => {
    await initRepo(project, '*.tmp\n');
    await put(project, WORKTREE_INCLUDE_FILE, '*.tmp\n');
    const total = INCLUDE_MAX_ENTRIES + 1;
    for (let start = 0; start < total; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, total - start) }, (_, i) =>
          put(project, `f${String(start + i).padStart(4, '0')}.tmp`),
        ),
      );
    }
    const paths = await listIncludePaths(project);
    expect(paths).toHaveLength(INCLUDE_MAX_ENTRIES);
    expect(paths[0]).toBe('f0000.tmp');
  }, 30_000);
});

describe('resolveIncludePaths', () => {
  it('правило есть только в основной копии', async () => {
    // В коммите правила для node_modules нет; в основной копии оно добавлено без коммита.
    await initRepo(project, 'other/\n');
    const copy = path.join(root, 'copy');
    await git(project, ['worktree', 'add', '-b', 'copy-branch', copy]);
    await put(project, '.gitignore', 'other/\nnode_modules/\n');
    await put(project, WORKTREE_INCLUDE_FILE, 'node_modules\n');
    await put(project, 'node_modules/x.js');
    expect(await listIncludePaths(project)).toEqual(['node_modules']);
    expect(await resolveIncludePaths(project, copy)).toEqual([]);
  });

  it('каталога в копии ещё нет', async () => {
    await initRepo(project, 'node_modules/\n');
    const copy = path.join(root, 'copy');
    await git(project, ['worktree', 'add', '-b', 'copy-branch', copy]);
    await put(project, WORKTREE_INCLUDE_FILE, 'node_modules\n');
    await put(project, 'node_modules/x.js');
    expect(await resolveIncludePaths(project, copy)).toEqual(['node_modules']);
  });
});
