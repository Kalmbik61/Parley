import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseBranchOf,
  commitWorktree,
  createWorktree,
  discardWorktree,
  DirtyWorktreeError,
  isGitRepo,
  mergeWorktree,
  plannedWorktree,
  worktreeDiff,
} from './worktree.js';

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

// Машина теста может не иметь глобального user.email/name (как и продакшен-машина
// без настроенного git) — коммит без identity падает, поэтому она задаётся на
// каждый репозиторий локально, а не читается из окружения разработчика.
// Последовательно: одновременная запись `.git/config` двумя вызовами git
// временами ловит собственную же блокировку файла настроек.
async function setIdentity(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'тест@harnas']);
  await git(dir, ['config', 'user.name', 'тест']);
}

let root = '';
let project = '';
let worktreeRoot = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harnas-worktree-'));
  project = path.join(root, 'project');
  worktreeRoot = path.join(root, 'worktrees');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Репозиторий с одним коммитом на ветке `main` — общая точка отсчёта тестов. */
async function initProject(): Promise<void> {
  await run('git', ['init', '-b', 'main', project]);
  await setIdentity(project);
  await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
  await git(project, ['add', 'README.md']);
  await git(project, ['commit', '-m', 'первый']);
}

describe('plannedWorktree', () => {
  it('строит путь и ветку по формату спеки: <root>/<проект>-<хеш6>/<workId>-<sessionId>', () => {
    const info = plannedWorktree('/tmp/my-project', 'w-0001', 's-02', 'main', worktreeRoot);

    expect(info.branch).toBe('harnas/w-0001/s-02');
    expect(info.base).toBe('main');
    expect(info.createdAt).toBeNull();
    expect(path.dirname(path.dirname(info.path))).toBe(worktreeRoot);
    expect(path.basename(info.path)).toBe('w-0001-s-02');
    expect(path.basename(path.dirname(info.path))).toMatch(/^my-project-[0-9a-f]{6}$/);
  });

  it('хеш от пути проекта устойчив: разные сессии той же работы делят каталог', () => {
    const a = plannedWorktree('/tmp/my-project', 'w-0001', 's-01', 'main', worktreeRoot);
    const b = plannedWorktree('/tmp/my-project', 'w-0002', 's-05', 'main', worktreeRoot);

    expect(path.dirname(a.path)).toBe(path.dirname(b.path));
    expect(path.dirname(a.path)).not.toBe(path.dirname(plannedWorktree('/tmp/other', 'w-0001', 's-01', 'main', worktreeRoot).path));
  });

  it('путь проекта с пробелом не ломает построение имени каталога', () => {
    const info = plannedWorktree('/tmp/my project', 'w-0001', 's-01', 'main', worktreeRoot);
    expect(path.basename(path.dirname(info.path))).toMatch(/^my project-[0-9a-f]{6}$/);
  });

  it('тильда в root раскрывается в домашнюю папку', () => {
    const info = plannedWorktree('/tmp/proj', 'w-0001', 's-01', 'main', '~/harnas/worktrees');
    expect(info.path.startsWith(homedir())).toBe(true);
  });
});

describe('isGitRepo', () => {
  it('не git — false, после init — true', async () => {
    expect(await isGitRepo(project)).toBe(false);
    await initProject();
    expect(await isGitRepo(project)).toBe(true);
  });
});

describe('createWorktree', () => {
  it('заводит каталог с веткой из плана', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);

    await createWorktree(project, info);

    const branch = (await git(info.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    expect(branch).toBe(info.branch);
    await expect(readFile(path.join(info.path, 'README.md'), 'utf8')).resolves.toContain('старт');
  });
});

describe('worktreeDiff', () => {
  it('видит и коммит в ветке, и незакоммиченный файл', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);

    await writeFile(path.join(info.path, 'feature.md'), 'фича\n', 'utf8');
    await git(info.path, ['add', 'feature.md']);
    await git(info.path, ['commit', '-m', 'фича']);

    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    const diff = await worktreeDiff(project, info);

    expect(diff.uncommitted).toBe(true);
    expect(diff.files.map((file) => file.path).sort()).toEqual(['draft.md', 'feature.md']);
    expect(diff.files.find((file) => file.path === 'draft.md')?.status).toBe('A');
    expect(diff.files.find((file) => file.path === 'feature.md')?.status).toBe('A');
    expect(diff.patch).toContain('фича');
    expect(diff.baseDirty).toBe(false);
    // Путь базового чекаута git отдаёт по-своему разрешённым (симлинки /tmp на
    // macOS) — сверяем не строкой, а тем, что каталог и правда основной.
    expect(diff.baseCheckout).not.toBeNull();
    if (diff.baseCheckout !== null) {
      await expect(readFile(path.join(diff.baseCheckout, 'README.md'), 'utf8')).resolves.toContain(
        'старт',
      );
    }
  });
});

describe('worktreeDiff — untracked-файлы', () => {
  it('содержимое untracked-файла попадает в patch, индекс при этом не трогается', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);

    await writeFile(path.join(info.path, 'untracked.md'), 'непрослеженное\n', 'utf8');

    const diff = await worktreeDiff(project, info);

    expect(diff.patch).toContain('непрослеженное');
    expect(diff.files.find((file) => file.path === 'untracked.md')?.status).toBe('A');
    // `--no-index` не должен ничего добавить в индекс — иначе следующий коммит
    // подхватил бы файл без ведома пользователя.
    expect((await git(info.path, ['status', '--porcelain'])).stdout.trim()).toBe('?? untracked.md');
  });
});

describe('commitWorktree', () => {
  it('коммитит всё незакоммиченное одной записью', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    const sha = await commitWorktree(info, 'бэкенд: черновик');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(info.path, ['log', '-1', '--pretty=%s'])).stdout.trim()).toBe(
      'бэкенд: черновик',
    );
    expect((await git(info.path, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });
});

describe('mergeWorktree', () => {
  /** Ветка с одним коммитом поверх свежесозданного worktree. */
  async function withCommittedFeature() {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'feature.md'), 'фича\n', 'utf8');
    await git(info.path, ['add', 'feature.md']);
    await git(info.path, ['commit', '-m', 'фича']);
    return info;
  }

  it('чистая база — merge-коммит с двумя родителями', async () => {
    const info = await withCommittedFeature();

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const parents = (
        await git(project, ['rev-list', '--parents', '-n', '1', result.commit])
      ).stdout.trim().split(' ');
      // Сам коммит + два родителя — признак merge, а не fast-forward.
      expect(parents).toHaveLength(3);
    }
    await expect(readFile(path.join(project, 'feature.md'), 'utf8')).resolves.toContain('фича');
  });

  it('грязная база — base_dirty, слияния не было', async () => {
    const info = await withCommittedFeature();
    await writeFile(path.join(project, 'dirty.md'), 'грязь\n', 'utf8');

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');

    expect(result).toMatchObject({ ok: false, reason: 'base_dirty' });
    await expect(readFile(path.join(project, 'feature.md'), 'utf8')).rejects.toThrow();
  });

  it('база нигде не выгружена — base_not_checked_out', async () => {
    await initProject();
    // Ветка-база существует, но чекаута с ней нет ни в основном каталоге
    // (там сейчас main), ни в отдельном worktree.
    await git(project, ['branch', 'feature-base', 'main']);
    const info = plannedWorktree(project, 'w-0001', 's-02', 'feature-base', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'feature.md'), 'фича\n', 'utf8');
    await git(info.path, ['add', 'feature.md']);
    await git(info.path, ['commit', '-m', 'фича']);

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');

    expect(result).toMatchObject({ ok: false, reason: 'base_not_checked_out' });
  });

  it('изменения только в .harnas/ базы без .gitignore — не грязь, слияние проходит', async () => {
    const info = await withCommittedFeature();
    // .harnas/ — своё состояние гарнеса внутри проекта; если проект его не
    // игнорирует, `git status` в базе всегда видит эти файлы. baseDirty должен
    // их не замечать, иначе слияние никогда бы не проходило ни у одного
    // проекта без .gitignore на .harnas/.
    await mkdir(path.join(project, '.harnas'), { recursive: true });
    await writeFile(path.join(project, '.harnas', 'state.json'), '{}\n', 'utf8');

    const diff = await worktreeDiff(project, info);
    expect(diff.baseDirty).toBe(false);

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');
    expect(result.ok).toBe(true);
  });

  it('незакоммиченное в worktree — uncommitted', async () => {
    const info = await withCommittedFeature();
    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');

    expect(result).toMatchObject({ ok: false, reason: 'uncommitted' });
  });

  it('конфликт — список файлов, база остаётся чистой', async () => {
    await initProject();
    await writeFile(path.join(project, 'shared.md'), 'основа\n', 'utf8');
    await git(project, ['add', 'shared.md']);
    await git(project, ['commit', '-m', 'shared']);

    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'shared.md'), 'из worktree\n', 'utf8');
    await git(info.path, ['add', 'shared.md']);
    await git(info.path, ['commit', '-m', 'правка в worktree']);

    // База меняет ту же строку того же файла — слияние не сможет разрешиться само.
    await writeFile(path.join(project, 'shared.md'), 'из базы\n', 'utf8');
    await git(project, ['add', 'shared.md']);
    await git(project, ['commit', '-m', 'правка в базе']);

    const result = await mergeWorktree(project, info, 'harnas: влить фичу');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('conflict');
      expect(result.files).toEqual(['shared.md']);
    }
    expect((await git(project, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });
});

describe('discardWorktree', () => {
  it('грязный без force — DirtyWorktreeError, ничего не тронуто', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    await expect(discardWorktree(project, info)).rejects.toBeInstanceOf(DirtyWorktreeError);
    await expect(readFile(path.join(info.path, 'draft.md'), 'utf8')).resolves.toContain(
      'черновик',
    );
  });

  it('с force — каталога и ветки больше нет', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(project, info);
    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    await discardWorktree(project, info, { force: true });

    await expect(readFile(path.join(info.path, 'draft.md'), 'utf8')).rejects.toThrow();
    expect((await git(project, ['branch', '--list', info.branch])).stdout.trim()).toBe('');
  });
});

describe('baseBranchOf', () => {
  it('обычный чекаут — имя ветки', async () => {
    await initProject();
    expect(await baseBranchOf(project)).toBe('main');
  });

  it('отсоединённая голова — SHA коммита', async () => {
    await initProject();
    const sha = (await git(project, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(project, ['checkout', '--detach']);

    expect(await baseBranchOf(project)).toBe(sha);
  });
});
