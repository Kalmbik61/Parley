import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseBranchOf,
  commitProject,
  commitWorktree,
  createWorktree,
  discardWorktree,
  DirtyWorktreeError,
  GitStateError,
  InvalidRevisionError,
  isGitRepo,
  joinDiffFiles,
  mergeCheck,
  mergeWorktree,
  NothingToCommitError,
  parseCommits,
  parseMergeTree,
  parseNameStatusZ,
  parseNumstat,
  parsePorcelainPaths,
  plannedWorktree,
  projectChanges,
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

// ---------------------------------------------------------------------------
// Кусок 8.1 этапа 8: статистика диффа, коммиты ветки, mergeCheck, изменения
// папки проекта. Тесты не читают stderr git: у человека он локализован.
// ---------------------------------------------------------------------------

const z = (...fields: string[]): Buffer => Buffer.from(fields.map((field) => `${field}\0`).join(''), 'utf8');

describe('parseNumstat (-z) — тест 1', () => {
  it('обычный файл, двоичный, переименование и запись --no-index', () => {
    const raw = Buffer.concat([
      z('3\t1\ta.txt'),
      z('-\t-\tbin.dat'),
      z('0\t0\t', 'old.txt', 'new.txt'),
      z('2\t0\t', '/dev/null', 'файл.txt'),
    ]);
    expect(parseNumstat(raw)).toEqual([
      { path: 'a.txt', oldPath: null, additions: 3, deletions: 1 },
      { path: 'bin.dat', oldPath: null, additions: null, deletions: null },
      { path: 'new.txt', oldPath: 'old.txt', additions: 0, deletions: 0 },
      { path: 'файл.txt', oldPath: null, additions: 2, deletions: 0 },
    ]);
  });

  it('пустой вывод — пустой список', () => {
    expect(parseNumstat(Buffer.alloc(0))).toEqual([]);
  });
});

describe('parseNameStatusZ и parsePorcelainPaths — тест 2', () => {
  it('R100\\0old\\0new\\0 — R со старым путём; прочие буквы', () => {
    expect(parseNameStatusZ(z('R100', 'old', 'new', 'M', 'a.txt', 'A', 'файл.txt', 'D', 'gone.txt'))).toEqual([
      { path: 'new', oldPath: 'old', status: 'R' },
      { path: 'a.txt', oldPath: null, status: 'M' },
      { path: 'файл.txt', oldPath: null, status: 'A' },
      { path: 'gone.txt', oldPath: null, status: 'D' },
    ]);
  });

  it('porcelain -z: у R старый путь пропускается', () => {
    expect(parsePorcelainPaths(z('RM new', 'old', '?? файл.txt'))).toEqual(['new', 'файл.txt']);
  });

  it('joinDiffFiles берёт статус из name-status, числа — из numstat того же пути', () => {
    expect(
      joinDiffFiles(
        [
          { path: 'new', oldPath: 'old', status: 'R' },
          { path: 'a.txt', oldPath: null, status: 'M' },
        ],
        [
          { path: 'a.txt', oldPath: null, additions: 1, deletions: 2 },
          { path: 'new', oldPath: 'old', additions: 0, deletions: 0 },
        ],
      ),
    ).toEqual([
      { path: 'new', status: 'R', oldPath: 'old', additions: 0, deletions: 0 },
      { path: 'a.txt', status: 'M', oldPath: null, additions: 1, deletions: 2 },
    ]);
  });

  it('parseCommits — записи через \\n, поля через \\0', () => {
    const raw = `${'a'.repeat(40)}\0тема\0Автор\x002026-09-27T10:00:00+03:00\n${'b'.repeat(40)}\0вторая\0Б\x002026-09-26T10:00:00+03:00\n`;
    expect(parseCommits(raw)).toEqual([
      { hash: 'a'.repeat(40), subject: 'тема', author: 'Автор', at: '2026-09-27T10:00:00+03:00' },
      { hash: 'b'.repeat(40), subject: 'вторая', author: 'Б', at: '2026-09-26T10:00:00+03:00' },
    ]);
    expect(parseCommits('')).toEqual([]);
  });
});

describe('parseMergeTree — тест 6', () => {
  const tree = 'c'.repeat(40);

  it('0 и id — clean; 1 и id — conflicts без дублей; 129 — null (старый git — проба версии в mergeCheck)', () => {
    expect(parseMergeTree(0, `${tree}\0`)).toEqual({ status: 'clean' });
    expect(parseMergeTree(1, `${tree}\0a.txt\0a.txt\0файл.txt\0`)).toEqual({
      status: 'conflicts',
      files: ['a.txt', 'файл.txt'],
    });
    expect(parseMergeTree(129, '')).toBeNull();
  });

  it('код 1 без id дерева (ветки нет) и прочие коды — null', () => {
    expect(parseMergeTree(1, '')).toBeNull();
    expect(parseMergeTree(128, '')).toBeNull();
  });
});

/** Worktree сессии поверх `initProject`. */
async function freshWorktree() {
  const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
  await createWorktree(project, info);
  return info;
}

describe('worktreeDiff — числа, коммиты, uncommittedPaths (тест 3)', () => {
  it('две правки, переименование и новый файл: числа, сумма, коммиты свежими первыми', async () => {
    await initProject();
    await writeFile(path.join(project, 'a.txt'), 'a1\na2\n', 'utf8');
    await writeFile(path.join(project, 'b.txt'), 'b1\n', 'utf8');
    await writeFile(path.join(project, 'old.txt'), 'неизменное содержимое для переименования\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'файлы']);
    const info = await freshWorktree();

    await writeFile(path.join(info.path, 'a.txt'), 'a1\nA2\nA3\n', 'utf8');
    await git(info.path, ['commit', '-am', 'первая правка']);
    await git(info.path, ['mv', 'old.txt', 'new.txt']);
    await writeFile(path.join(info.path, 'b.txt'), 'b1\nb2\n', 'utf8');
    await git(info.path, ['commit', '-am', 'вторая правка']);
    await writeFile(path.join(info.path, 'fresh.txt'), 'f1\nf2\n', 'utf8');

    const diff = await worktreeDiff(project, info);

    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get('a.txt')).toEqual({ path: 'a.txt', status: 'M', oldPath: null, additions: 2, deletions: 1 });
    expect(byPath.get('b.txt')).toEqual({ path: 'b.txt', status: 'M', oldPath: null, additions: 1, deletions: 0 });
    expect(byPath.get('new.txt')).toEqual({ path: 'new.txt', status: 'R', oldPath: 'old.txt', additions: 0, deletions: 0 });
    expect(byPath.get('fresh.txt')).toEqual({ path: 'fresh.txt', status: 'A', oldPath: null, additions: 2, deletions: 0 });
    expect(diff.files).toHaveLength(4);
    expect(diff.stats).toEqual({ additions: 5, deletions: 1 });
    expect(diff.commits.map((commit) => commit.subject)).toEqual(['вторая правка', 'первая правка']);
    expect(diff.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.commits[0]?.author).toBe('тест');
    expect(Number.isNaN(Date.parse(diff.commits[0]?.at ?? ''))).toBe(false);
    expect(diff.mergeBase).toBe((await git(project, ['rev-parse', 'main'])).stdout.trim());
    expect(diff.uncommittedPaths).toEqual(['fresh.txt']);
    expect(diff.uncommitted).toBe(true);
  });

  it('после git commit -a uncommittedPaths пуст, а файлы коммита остались в files', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'README.md'), 'старт\nещё\n', 'utf8');

    const before = await worktreeDiff(project, info);
    expect(before.uncommittedPaths).toEqual(['README.md']);

    await git(info.path, ['commit', '-am', 'правка']);
    const after = await worktreeDiff(project, info);
    expect(after.uncommittedPaths).toEqual([]);
    expect(after.uncommitted).toBe(false);
    expect(after.files).toEqual([{ path: 'README.md', status: 'M', oldPath: null, additions: 1, deletions: 0 }]);
  });

  it('двоичный файл — числа null, в сумму не входят', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    await writeFile(path.join(info.path, 'README.md'), 'старт\nещё\n', 'utf8');

    const diff = await worktreeDiff(project, info);
    expect(diff.files.find((file) => file.path === 'bin.dat')).toMatchObject({ additions: null, deletions: null });
    expect(diff.stats).toEqual({ additions: 1, deletions: 0 });
  });
});

describe('кириллица в путях — тест 4', () => {
  it('новый файл.txt в worktree: дифф не падает, путь как есть', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'файл.txt'), 'текст\n', 'utf8');

    const diff = await worktreeDiff(project, info);
    expect(diff.files.map((file) => file.path)).toEqual(['файл.txt']);
    expect(diff.uncommittedPaths).toEqual(['файл.txt']);
    expect(diff.patch).toContain('текст');
  });

  it('конфликт в файл.txt: mergeCheck и отказ mergeWorktree называют путь как есть', async () => {
    await initProject();
    await writeFile(path.join(project, 'файл.txt'), 'основа\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'основа']);
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'файл.txt'), 'ветка\n', 'utf8');
    await git(info.path, ['commit', '-am', 'ветка']);
    await writeFile(path.join(project, 'файл.txt'), 'база\n', 'utf8');
    await git(project, ['commit', '-am', 'база']);

    expect(await mergeCheck(project, info)).toEqual({ status: 'conflicts', files: ['файл.txt'] });
    expect(await mergeWorktree(project, info, 'влить')).toEqual({
      ok: false,
      reason: 'conflict',
      files: ['файл.txt'],
    });
  });
});

describe('mergeCheck — тест 5', () => {
  it('непересекающиеся правки — clean, рабочие копии не тронуты', async () => {
    await initProject();
    await writeFile(path.join(project, 'a.txt'), 'a\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'a']);
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'b.txt'), 'b\n', 'utf8');
    await git(info.path, ['add', '.']);
    await git(info.path, ['commit', '-m', 'b']);
    await writeFile(path.join(project, 'a.txt'), 'a2\n', 'utf8');
    await git(project, ['commit', '-am', 'a2']);
    const headBefore = (await git(project, ['rev-parse', 'HEAD'])).stdout;

    expect(await mergeCheck(project, info)).toEqual({ status: 'clean' });
    expect((await git(project, ['status', '--porcelain'])).stdout).toBe('');
    expect((await git(info.path, ['status', '--porcelain'])).stdout).toBe('');
    expect((await git(project, ['rev-parse', 'HEAD'])).stdout).toBe(headBefore);
  });

  it('правка одной строки в базе и в ветке — conflicts: [a.txt]', async () => {
    await initProject();
    await writeFile(path.join(project, 'a.txt'), 'строка\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'a']);
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'a.txt'), 'из ветки\n', 'utf8');
    await git(info.path, ['commit', '-am', 'ветка']);
    await writeFile(path.join(project, 'a.txt'), 'из базы\n', 'utf8');
    await git(project, ['commit', '-am', 'база']);

    expect(await mergeCheck(project, info)).toEqual({ status: 'conflicts', files: ['a.txt'] });
    expect((await git(project, ['status', '--porcelain'])).stdout).toBe('');
    expect((await git(info.path, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('несуществующая база — ошибка, а не «конфликт без файлов»', async () => {
    await initProject();
    const info = await freshWorktree();
    await expect(mergeCheck(project, { ...info, base: 'нет-такой-ветки' })).rejects.toThrow();
  });
});

describe('mergeCheck — ревизии из карты и старый git (раунд исправлений 1)', () => {
  const exists = (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );

  it('флаг вместо базы или ветки — InvalidRevisionError, не unsupported; канарейки нет', async () => {
    await initProject();
    const info = await freshWorktree();
    const canary = path.join(root, 'canary');
    for (const bad of ['-c', `--upload-pack=touch ${canary}`]) {
      await expect(mergeCheck(project, { ...info, base: bad })).rejects.toBeInstanceOf(InvalidRevisionError);
      await expect(mergeCheck(project, { ...info, branch: bad })).rejects.toBeInstanceOf(InvalidRevisionError);
      await expect(worktreeDiff(project, { ...info, base: bad })).rejects.toBeInstanceOf(InvalidRevisionError);
    }
    // Диапазон вместо ветки — тоже не имя ревизии.
    await expect(mergeCheck(project, { ...info, branch: 'HEAD~1..' })).rejects.toBeInstanceOf(InvalidRevisionError);
    expect(await exists(canary)).toBe(false);
    // Нормальные ветка и база — как раньше.
    expect(await mergeCheck(project, info)).toEqual({ status: 'clean' });
  });

  it('SHA вместо базы (отсоединённая голова) — проходит', async () => {
    await initProject();
    const info = await freshWorktree();
    const sha = (await git(project, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(await mergeCheck(project, { ...info, base: sha })).toEqual({ status: 'clean' });
  });

  it('git 2.37 (подмена в PATH) — unsupported, merge-tree не вызывается', async () => {
    await initProject();
    const info = await freshWorktree();
    const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
    const fakeBin = path.join(root, 'fake-bin');
    const calls = path.join(root, 'calls.log');
    await mkdir(fakeBin);
    await writeFile(
      path.join(fakeBin, 'git'),
      `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$1" = "--version" ]; then echo "git version 2.37.0"; exit 0; fi\nexec '${realGit}' "$@"\n`,
      'utf8',
    );
    await chmod(path.join(fakeBin, 'git'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${saved ?? ''}`;
    try {
      expect(await mergeCheck(project, info)).toEqual({ status: 'unsupported' });
    } finally {
      process.env.PATH = saved;
    }
    expect(await readFile(calls, 'utf8')).not.toContain('merge-tree');
  });
});

describe('ревизии из карты в mergeWorktree, createWorktree, discardWorktree (раунд исправлений 2)', () => {
  const exists = (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );
  const bads = (canary: string): string[] => ['-c', `--upload-pack=touch ${canary}`];

  it('mergeWorktree: флаг вместо базы или ветки — InvalidRevisionError, канарейки нет; нормальная ветка — как раньше', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'feature.md'), 'фича\n', 'utf8');
    await git(info.path, ['add', 'feature.md']);
    await git(info.path, ['commit', '-m', 'фича']);
    const canary = path.join(root, 'canary');
    for (const bad of bads(canary)) {
      await expect(mergeWorktree(project, { ...info, base: bad }, 'влить')).rejects.toBeInstanceOf(
        InvalidRevisionError,
      );
      await expect(mergeWorktree(project, { ...info, branch: bad }, 'влить')).rejects.toBeInstanceOf(
        InvalidRevisionError,
      );
    }
    expect(await exists(canary)).toBe(false);
    const result = await mergeWorktree(project, info, 'влить');
    expect(result.ok).toBe(true);
  });

  it('createWorktree: флаг вместо базы или ветки — InvalidRevisionError, каталога и канарейки нет', async () => {
    await initProject();
    const info = plannedWorktree(project, 'w-0001', 's-02', 'main', worktreeRoot);
    const canary = path.join(root, 'canary');
    for (const bad of bads(canary)) {
      await expect(createWorktree(project, { ...info, base: bad })).rejects.toBeInstanceOf(InvalidRevisionError);
      await expect(createWorktree(project, { ...info, branch: bad })).rejects.toBeInstanceOf(InvalidRevisionError);
    }
    expect(await exists(canary)).toBe(false);
    expect(await exists(info.path)).toBe(false);
    await createWorktree(project, info);
    expect(await exists(info.path)).toBe(true);
  });

  it('discardWorktree: флаг вместо ветки — InvalidRevisionError до удаления каталога; нормальная — как раньше', async () => {
    await initProject();
    const info = await freshWorktree();
    const canary = path.join(root, 'canary');
    for (const bad of bads(canary)) {
      await expect(discardWorktree(project, { ...info, branch: bad }, { force: true })).rejects.toBeInstanceOf(
        InvalidRevisionError,
      );
    }
    expect(await exists(canary)).toBe(false);
    expect(await exists(info.path)).toBe(true);
    await discardWorktree(project, info);
    expect(await exists(info.path)).toBe(false);
    expect((await git(project, ['branch', '--list', info.branch])).stdout.trim()).toBe('');
  });
});

describe('вложенный репозиторий и .harnas в worktree (раунд исправлений 1)', () => {
  async function nestedRepo(dir: string): Promise<void> {
    const nested = path.join(dir, 'nested');
    await run('git', ['init', '-b', 'main', nested]);
    await setIdentity(nested);
    await writeFile(path.join(nested, 'inner.txt'), 'i\n', 'utf8');
    await git(nested, ['add', '.']);
    await git(nested, ['commit', '-m', 'inner']);
  }

  it('неотслеживаемый вложенный репозиторий в папке проекта — один элемент, не падает', async () => {
    await initProject();
    await nestedRepo(project);
    await writeFile(path.join(project, 'a.txt'), 'a\n', 'utf8');

    const changes = await projectChanges(project);
    expect(changes.files.map((file) => file.path)).toEqual(['a.txt', 'nested/']);
    expect(changes.files.find((file) => file.path === 'nested/')?.status).toBe('A');
  });

  it('неотслеживаемый вложенный репозиторий в worktree — один элемент, не падает', async () => {
    await initProject();
    const info = await freshWorktree();
    await nestedRepo(info.path);

    const diff = await worktreeDiff(project, info);
    expect(diff.files.map((file) => file.path)).toEqual(['nested/']);
    expect(diff.uncommittedPaths).toEqual(['nested/']);
  });

  it('.harnas/ внутри worktree — не в files, не в uncommittedPaths и патче, не в коммите', async () => {
    await initProject();
    const info = await freshWorktree();
    await mkdir(path.join(info.path, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(info.path, '.harnas', 'works', 'w', 'log.jsonl'), '{"harnas":1}\n', 'utf8');
    await writeFile(path.join(info.path, 'a.txt'), 'a\n', 'utf8');

    const diff = await worktreeDiff(project, info);
    expect(diff.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(diff.uncommittedPaths).toEqual(['a.txt']);
    expect(diff.patch).not.toContain('harnas');

    const commit = await commitWorktree(info, 'прогресс');
    const names = (await git(info.path, ['show', '--name-only', '--format=', commit])).stdout.trim();
    expect(names).toBe('a.txt');
  });
});

describe('projectChanges и причины — тест 7', () => {
  it('правка — files и branch; detached HEAD — branch: null', async () => {
    await initProject();
    await writeFile(path.join(project, 'README.md'), 'старт\nещё\n', 'utf8');
    await writeFile(path.join(project, 'новый.txt'), 'н\n', 'utf8');

    const changes = await projectChanges(project);
    expect(changes.branch).toBe('main');
    expect(changes.files).toEqual([
      { path: 'README.md', status: 'M', oldPath: null, additions: 1, deletions: 0 },
      { path: 'новый.txt', status: 'A', oldPath: null, additions: 1, deletions: 0 },
    ]);
    expect(changes.stats).toEqual({ additions: 2, deletions: 0 });
    expect(changes.patch).toContain('ещё');
    expect(changes.patch).toContain('н');

    await git(project, ['checkout', '--detach']);
    expect((await projectChanges(project)).branch).toBeNull();
  });

  it('папка без коммитов — no-commits; не под git — not-a-repo', async () => {
    await run('git', ['init', '-b', 'main', project]);
    await expect(projectChanges(project)).rejects.toMatchObject({ reason: 'no-commits' });
    await expect(projectChanges(project)).rejects.toBeInstanceOf(GitStateError);

    const plain = path.join(root, 'plain');
    await mkdir(plain);
    await expect(projectChanges(plain)).rejects.toMatchObject({ reason: 'not-a-repo' });
  });

  it('PATH без git — git-missing', async () => {
    await initProject();
    const emptyBin = path.join(root, 'empty-bin');
    await mkdir(emptyBin);
    const saved = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await expect(projectChanges(project)).rejects.toMatchObject({ reason: 'git-missing' });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('проект — подкаталог репозитория (тест 8)', () => {
  it('пути от sub, правки вне sub нет', async () => {
    await initProject();
    const sub = path.join(project, 'sub');
    await mkdir(sub);
    await writeFile(path.join(sub, 'a.txt'), '1\n', 'utf8');
    await writeFile(path.join(project, 'top.txt'), 't\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'sub']);
    await writeFile(path.join(sub, 'a.txt'), '2\n', 'utf8');
    await writeFile(path.join(sub, 'новый.txt'), 'н\n', 'utf8');
    await writeFile(path.join(project, 'top.txt'), 't2\n', 'utf8');

    const changes = await projectChanges(sub);
    expect(changes.files.map((file) => file.path)).toEqual(['a.txt', 'новый.txt']);
  });

  it('неотслеживаемый sub/.harnas/works/w/log.jsonl в базе — baseDirty: false', async () => {
    await initProject();
    const sub = path.join(project, 'sub');
    await mkdir(sub);
    await writeFile(path.join(sub, 'a.txt'), '1\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'sub']);
    const info = plannedWorktree(sub, 'w-0001', 's-02', 'main', worktreeRoot);
    await createWorktree(sub, info);
    await mkdir(path.join(sub, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(sub, '.harnas', 'works', 'w', 'log.jsonl'), '{}\n', 'utf8');

    expect((await worktreeDiff(sub, info)).baseDirty).toBe(false);
  });
});

describe('.harnas/ — не изменения проекта (тест 9)', () => {
  async function harnasLog(dir: string): Promise<void> {
    await mkdir(path.join(dir, '.harnas', 'works', 'w-01', 'events'), { recursive: true });
    await writeFile(path.join(dir, '.harnas', 'works', 'w-01', 'events', 's-01.jsonl'), '{}\n', 'utf8');
  }

  it('в files только a.txt; коммит без .harnas/', async () => {
    await initProject();
    await harnasLog(project);
    await writeFile(path.join(project, 'a.txt'), 'a\n', 'utf8');

    expect((await projectChanges(project)).files.map((file) => file.path)).toEqual(['a.txt']);

    const { commit } = await commitProject(project, 'коммит папки');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(project, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(commit);
    const names = (await git(project, ['show', '--name-only', '--format=', commit])).stdout.trim();
    expect(names).toBe('a.txt');
    expect((await git(project, ['log', '-1', '--pretty=%s'])).stdout.trim()).toBe('коммит папки');
  });

  it('изменён только .harnas/ — NothingToCommitError, коммита нет', async () => {
    await initProject();
    await harnasLog(project);
    const head = (await git(project, ['rev-parse', 'HEAD'])).stdout;

    await expect(commitProject(project, 'пусто')).rejects.toBeInstanceOf(NothingToCommitError);
    expect((await git(project, ['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it('.harnas/ в .gitignore: коммит проходит, изменён только .harnas/ — NothingToCommitError', async () => {
    await initProject();
    await writeFile(path.join(project, '.gitignore'), '.harnas/\n', 'utf8');
    await git(project, ['add', '.gitignore']);
    await git(project, ['commit', '-m', 'игнор']);
    await harnasLog(project);

    await expect(commitProject(project, 'пусто')).rejects.toBeInstanceOf(NothingToCommitError);

    await writeFile(path.join(project, 'a.txt'), 'a\n', 'utf8');
    const { commit } = await commitProject(project, 'с игнором');
    expect((await git(project, ['show', '--name-only', '--format=', commit])).stdout.trim()).toBe('a.txt');
  });

  it('проект — подкаталог: подготовленное человеком вне него в коммит не попало и осталось подготовленным', async () => {
    await initProject();
    const sub = path.join(project, 'sub');
    await mkdir(sub);
    await writeFile(path.join(sub, 'a.txt'), '1\n', 'utf8');
    await writeFile(path.join(project, 'top.txt'), 't\n', 'utf8');
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'sub']);
    await writeFile(path.join(sub, 'a.txt'), '2\n', 'utf8');
    await writeFile(path.join(project, 'top.txt'), 't2\n', 'utf8');
    await git(sub, ['add', '../top.txt']);
    await harnasLog(sub);

    const { commit } = await commitProject(sub, 'только sub');
    expect((await git(project, ['show', '--name-only', '--format=', commit])).stdout.trim()).toBe('sub/a.txt');
    expect((await git(project, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('top.txt');
  });
});

describe('чтение не трогает индекс (тест 10)', () => {
  it('после worktreeDiff и projectChanges индексы побайтно прежние, git diff --cached пуст', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'untracked.md'), 'u\n', 'utf8');
    await writeFile(path.join(project, 'untracked.md'), 'u\n', 'utf8');
    // Сдвинутое mtime отслеживаемого файла: git без --no-optional-locks
    // освежил бы stat-данные и переписал бы индекс.
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(project, 'README.md'), future, future);
    await utimes(path.join(info.path, 'README.md'), future, future);

    const indexOf = async (dir: string): Promise<string> =>
      path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', 'index'])).stdout.trim());
    const projectIndex = await indexOf(project);
    const worktreeIndex = await indexOf(info.path);
    const projectBefore = await readFile(projectIndex);
    const worktreeBefore = await readFile(worktreeIndex);

    const diff = await worktreeDiff(project, info);
    const changes = await projectChanges(project);
    // Сдвинутый stat без правки содержимого — не изменение.
    expect(diff.files.map((file) => file.path)).toEqual(['untracked.md']);
    expect(changes.files.map((file) => file.path)).toEqual(['untracked.md']);

    expect((await readFile(projectIndex)).equals(projectBefore)).toBe(true);
    expect((await readFile(worktreeIndex)).equals(worktreeBefore)).toBe(true);
    expect((await git(project, ['diff', '--cached'])).stdout).toBe('');
    expect((await git(info.path, ['diff', '--cached'])).stdout).toBe('');
  });
});

describe('patch: false (тест 11)', () => {
  it('патч пуст, files и stats те же; без параметра — патч как раньше', async () => {
    await initProject();
    const info = await freshWorktree();
    await writeFile(path.join(info.path, 'README.md'), 'старт\nещё\n', 'utf8');
    await writeFile(path.join(info.path, 'new.md'), 'новое\n', 'utf8');

    const full = await worktreeDiff(project, info);
    const bare = await worktreeDiff(project, info, { patch: false });
    expect(full.patch).toContain('ещё');
    expect(full.patch).toContain('новое');
    expect(bare.patch).toBe('');
    expect(bare.files).toEqual(full.files);
    expect(bare.stats).toEqual(full.stats);

    await writeFile(path.join(project, 'README.md'), 'старт\nи тут\n', 'utf8');
    expect((await projectChanges(project, { patch: false })).patch).toBe('');
    expect((await projectChanges(project)).patch).toContain('и тут');
  });
});
