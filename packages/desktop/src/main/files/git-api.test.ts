import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot, GrepQuery } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import {
  createGitApi,
  createGitRunner,
  createGrepParser,
  gitRootOf,
  isSafeRev,
  parseGitStatus,
  parseLsFiles,
  runGrepWorker,
  walkFiles,
  type GitRunner,
} from './git-api.js';

/** Воркер из исходника: Node 22 снимает типы сам, в сборке его создаёт `?nodeWorker`. */
const spawnWorker = (): Worker => new Worker(new URL('./grep-worker.ts', import.meta.url));

const ROOT: FileRoot = { workKey: '/p w-1', spec: { kind: 'project' } };
const Q = (text: string, extra: Partial<GrepQuery> = {}): GrepQuery => ({
  text,
  caseSensitive: true,
  wholeWord: false,
  regex: false,
  ...extra,
});

let dir = '';

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-gitapi-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

function commitAll(repo: string, message = 'c'): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

function api(rootPath: string, runner: GitRunner = createGitRunner(process.env), extra: Partial<Parameters<typeof createGitApi>[0]> = {}) {
  return createGitApi({ git: runner, roots: { rootPath: () => rootPath }, spawnWorker, ...extra });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'failed';
  }
  return 'resolved';
}

describe('isSafeRev', () => {
  it('HEAD и 7–40 hex с ^ на конце; прочее — нет', () => {
    for (const rev of ['HEAD', 'abcdef0', 'abcdef0^', 'a'.repeat(40), `${'0'.repeat(40)}^`]) expect(isSafeRev(rev)).toBe(true);
    for (const rev of ['', 'head', 'abcdef', 'a'.repeat(41), '--output=/tmp/x', 'HEAD;rm', 'ABCDEF0', 'main', 'HEAD~1', 'abcdef0^^'])
      expect(isSafeRev(rev)).toBe(false);
  });
});

describe('gitRootOf', () => {
  it('корень репозитория — prefix пустой, подкаталог — sub/, не git — null; кэш на корень', async () => {
    await initRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    const runner = createGitRunner(process.env);
    const spy = vi.spyOn(runner, 'run');
    expect(await gitRootOf(runner, dir)).toEqual({ prefix: '' });
    expect(await gitRootOf(runner, path.join(dir, 'sub'))).toEqual({ prefix: 'sub/' });
    await mkdir(path.join(dir, 'папка й'));
    expect(await gitRootOf(runner, path.join(dir, 'папка й'))).toEqual({ prefix: 'папка й/' });
    expect(await gitRootOf(runner, dir)).toEqual({ prefix: '' });
    expect(spy).toHaveBeenCalledTimes(3);
    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-plain-')));
    try {
      expect(await gitRootOf(runner, plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('lsFiles и parseLsFiles (тест 2)', () => {
  it('отслеживаемый и новый неигнорируемый есть; игнорируемого и .harnas/ нет', async () => {
    await initRepo(dir);
    await writeFile(path.join(dir, '.gitignore'), '*.log\n');
    await writeFile(path.join(dir, 'tracked.ts'), 'x');
    commitAll(dir);
    await writeFile(path.join(dir, 'new.ts'), 'y');
    await writeFile(path.join(dir, 'debug.log'), 'z');
    await mkdir(path.join(dir, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(dir, '.harnas', 'works', 'w', 'map.json'), '{}');
    const files = await api(dir).lsFiles(ROOT);
    expect(files.sort()).toEqual(['.gitignore', 'new.ts', 'tracked.ts']);
  });

  it('parseLsFiles: -z, кириллица и пробелы как есть', () => {
    expect(parseLsFiles(Buffer.from('a b.ts\0папка/файл.md\0'))).toEqual(['a b.ts', 'папка/файл.md']);
    expect(parseLsFiles(Buffer.alloc(0))).toEqual([]);
  });

  it('не-git корень — обход без node_modules и .harnas', async () => {
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'x', 'i.js'), '');
    await mkdir(path.join(dir, '.harnas'), { recursive: true });
    await writeFile(path.join(dir, '.harnas', 'log'), '');
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.ts'), '');
    await writeFile(path.join(dir, 'b.md'), '');
    expect((await api(dir).lsFiles(ROOT)).sort()).toEqual(['b.md', 'src/a.ts']);
  });
});

describe('grep (тесты 3 и 4)', () => {
  beforeEach(async () => {
    await initRepo(dir);
    await writeFile(path.join(dir, 'a.txt'), 'Foo bar\nfoo\nfoobar baz\n');
    await writeFile(path.join(dir, 'b.txt'), 'nothing here\n');
    commitAll(dir);
  });

  it('регистр, слово, регулярка; ranges стоят на совпадениях', async () => {
    const a = api(dir);
    const exact = await a.grep(ROOT, Q('foo'), 's1');
    expect(exact.truncated).toBe(false);
    expect(exact.files).toEqual([
      {
        path: 'a.txt',
        hits: [
          { line: 2, text: 'foo', ranges: [[0, 3]] },
          { line: 3, text: 'foobar baz', ranges: [[0, 3]] },
        ],
      },
    ]);
    const nocase = await a.grep(ROOT, Q('foo', { caseSensitive: false }), 's2');
    expect(nocase.files[0]?.hits.map((h) => h.line)).toEqual([1, 2, 3]);
    expect(nocase.files[0]?.hits[0]?.ranges).toEqual([[0, 3]]);
    const word = await a.grep(ROOT, Q('foo', { wholeWord: true }), 's3');
    expect(word.files[0]?.hits.map((h) => h.line)).toEqual([2]);
    const regex = await a.grep(ROOT, Q('ba[rz]', { regex: true }), 's4');
    expect(regex.files[0]?.hits).toEqual([
      { line: 1, text: 'Foo bar', ranges: [[4, 7]] },
      { line: 3, text: 'foobar baz', ranges: [[3, 6], [7, 10]] },
    ]);
  });

  it('3000 совпадений → 2000 и truncated', async () => {
    await writeFile(path.join(dir, 'many.txt'), 'hit\n'.repeat(3000));
    const result = await api(dir).grep(ROOT, Q('hit'), 's');
    expect(result.truncated).toBe(true);
    expect(result.files.reduce((n, f) => n + f.hits.length, 0)).toBe(2000);
  });

  it('новый неотслеживаемый файл находится (--untracked); .harnas/ — нет', async () => {
    await writeFile(path.join(dir, 'fresh.txt'), 'needle\n');
    await mkdir(path.join(dir, '.harnas'));
    await writeFile(path.join(dir, '.harnas', 'log'), 'needle\n');
    const result = await api(dir).grep(ROOT, Q('needle'), 's');
    expect(result.files.map((f) => f.path)).toEqual(['fresh.txt']);
  });

  it('-f/etc/hosts и --open-files-in-pager=x ищутся как текст (тест 4)', async () => {
    await writeFile(path.join(dir, 'c.txt'), 'use -f/etc/hosts here\nlocalhost\nopt --open-files-in-pager=x\n');
    const runner = createGitRunner(process.env);
    const spy = vi.spyOn(runner, 'run');
    const a = api(dir, runner);
    const f = await a.grep(ROOT, Q('-f/etc/hosts'), 's1');
    expect(f.files).toEqual([{ path: 'c.txt', hits: [{ line: 1, text: 'use -f/etc/hosts here', ranges: [[4, 16]] }] }]);
    const pager = await a.grep(ROOT, Q('--open-files-in-pager=x'), 's2');
    expect(pager.files).toEqual([
      { path: 'c.txt', hits: [{ line: 3, text: 'opt --open-files-in-pager=x', ranges: [[4, 27]] }] },
    ]);
    // Запрос — только сразу после -e.
    for (const [args] of spy.mock.calls.filter(([args]) => args.includes('grep'))) {
      const at = args.indexOf('-e');
      expect(at).toBeGreaterThan(0);
      expect(['-f/etc/hosts', '--open-files-in-pager=x']).toContain(args[at + 1]);
      expect(args.filter((arg) => arg === '-f/etc/hosts' || arg === '--open-files-in-pager=x')).toHaveLength(1);
    }
  });

  it('чтения git — с --no-optional-locks и -c diff.autoRefreshIndex=false', async () => {
    const runner = createGitRunner(process.env);
    const spy = vi.spyOn(runner, 'run');
    const a = api(dir, runner);
    await a.grep(ROOT, Q('foo'), 's');
    await a.gitStatus(ROOT);
    await a.lsFiles(ROOT);
    const calls = spy.mock.calls.map(([args]) => args).filter((args) => !args.includes('rev-parse'));
    expect(calls).toHaveLength(3);
    for (const args of calls) expect(args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false']);
  });
});

describe('createGrepParser', () => {
  it('кусками, с разрывом записи посреди; ranges пустые', () => {
    const parser = createGrepParser({ hits: 2000, files: 200 });
    const out = Buffer.from('a.ts\x001\x00one\nпапка/б.ts\x0012\x00two\n');
    expect(parser.push(out.subarray(0, 7))).toBe(true);
    expect(parser.push(out.subarray(7))).toBe(true);
    expect(parser.result()).toEqual({
      files: [
        { path: 'a.ts', hits: [{ line: 1, text: 'one', ranges: [] }] },
        { path: 'папка/б.ts', hits: [{ line: 12, text: 'two', ranges: [] }] },
      ],
      truncated: false,
    });
  });

  it('предел файлов: 201-й файл — false и truncated', () => {
    const parser = createGrepParser({ hits: 2000, files: 200 });
    const lines = Array.from({ length: 201 }, (_, i) => `f${i}\x001\x00x\n`).join('');
    expect(parser.push(Buffer.from(lines))).toBe(false);
    expect(parser.result().files).toHaveLength(200);
    expect(parser.result().truncated).toBe(true);
  });
});

describe('поиск без git (тест 5)', () => {
  it('(a+)+$ по 100 000 a с b: cancel → ответ меньше секунды, таймер вызова вовремя', async () => {
    await writeFile(path.join(dir, 'evil.txt'), `${'a'.repeat(100_000)}b\n`);
    const a = api(dir);
    const started = Date.now();
    const pending = a.grep(ROOT, Q('(a+)+$', { regex: true }), 'evil');
    // Таймер потока вызова срабатывает вовремя: регулярка не в нём.
    const lag = await new Promise<number>((resolve) => {
      const planned = Date.now();
      setTimeout(() => resolve(Date.now() - planned), 200);
    });
    expect(lag).toBeLessThan(400);
    await a.cancel('evil');
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000 + 200);
    expect(result.truncated).toBe(true);
  });

  it('без cancel — ответ по пределу времени с truncated', async () => {
    await writeFile(path.join(dir, 'ok.txt'), 'aaa\n');
    await writeFile(path.join(dir, 'zz-evil.txt'), `${'a'.repeat(100_000)}b\n`);
    const started = Date.now();
    const result = await api(dir, createGitRunner(process.env), { grepTimeoutMs: 500 }).grep(ROOT, Q('(a+)+$', { regex: true }), 's');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.truncated).toBe(true);
  });

  it('runGrepWorker: walk — только совпадения, двоичные и большие пропущены', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'x needle y needle\nno\n');
    await writeFile(path.join(dir, 'bin.dat'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]));
    const result = await runGrepWorker(
      { kind: 'walk', query: Q('needle'), rootPath: dir, paths: ['a.txt', 'bin.dat', 'missing.txt'] },
      { signal: new AbortController().signal, timeoutMs: 10_000, spawn: spawnWorker },
    );
    expect(result).toEqual({
      files: [{ path: 'a.txt', hits: [{ line: 1, text: 'x needle y needle', ranges: [[2, 8], [11, 17]] }] }],
      truncated: false,
    });
  });
});

describe('gitShow (тесты 6 и 12)', () => {
  let head = '';
  let rootCommit = '';

  beforeEach(async () => {
    await initRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.ts'), 'top\n');
    await writeFile(path.join(dir, 'sub', 'a.ts'), 'in sub\n');
    rootCommit = commitAll(dir, 'first');
    await writeFile(path.join(dir, 'gone.ts'), 'was here\n');
    head = commitAll(dir, 'second');
  });

  it('файла нет в ревизии → null; блоб больше maxBytes → files:too-large', async () => {
    const a = api(dir, createGitRunner(process.env), { showMaxBytes: 5 });
    expect(await a.gitShow(ROOT, 'HEAD', 'nope.ts')).toBeNull();
    expect(await codeOf(a.gitShow(ROOT, 'HEAD', 'gone.ts'))).toBe('files:too-large');
    expect(await a.gitShow(ROOT, 'HEAD', 'a.ts')).toMatchObject({ text: 'top\n', binary: false, utf8: true, readOnlyReason: null });
  });

  it('D: файла на диске нет — текст из ревизии', async () => {
    await unlink(path.join(dir, 'gone.ts'));
    expect((await api(dir).gitShow(ROOT, head.slice(0, 7), 'gone.ts'))?.text).toBe('was here\n');
  });

  it('rev --output=/tmp/x и HEAD;rm → bad_request, файл не создан', async () => {
    const out = path.join(dir, 'x-out');
    const runner = createGitRunner(process.env);
    const spy = vi.spyOn(runner, 'run');
    const a = api(dir, runner);
    expect(await codeOf(a.gitShow(ROOT, `--output=${out}`, 'a.ts'))).toBe('bad_request');
    expect(await codeOf(a.gitShow(ROOT, 'HEAD;rm', 'a.ts'))).toBe('bad_request');
    expect(existsSync(out)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('путь лексически: абсолютный, .., NUL → bad_request', async () => {
    const a = api(dir);
    for (const p of ['/etc/hosts', '../x', 'a/../../x', 'a\0b', '']) expect(await codeOf(a.gitShow(ROOT, 'HEAD', p))).toBe('bad_request');
  });

  it('<корневой коммит>^ → null', async () => {
    expect(await api(dir).gitShow(ROOT, `${rootCommit}^`, 'a.ts')).toBeNull();
  });

  it('папка проекта — подкаталог: HEAD и a.ts дают файл этой папки', async () => {
    expect((await api(path.join(dir, 'sub')).gitShow(ROOT, 'HEAD', 'a.ts'))?.text).toBe('in sub\n');
  });
});

describe('gitStatus (тесты 7 и 8)', () => {
  it('M, U у файла в новой папке, D, R на новом пути, конфликт UU → M', async () => {
    await initRepo(dir);
    await writeFile(path.join(dir, 'mod.ts'), '1\n');
    await writeFile(path.join(dir, 'del.ts'), 'd\n');
    await writeFile(path.join(dir, 'old.ts'), 'rename me please, long enough\n');
    await writeFile(path.join(dir, 'conf.ts'), 'base\n');
    commitAll(dir);
    git(dir, 'checkout', '-q', '-b', 'other');
    await writeFile(path.join(dir, 'conf.ts'), 'other\n');
    commitAll(dir);
    git(dir, 'checkout', '-q', 'main');
    await writeFile(path.join(dir, 'conf.ts'), 'mine\n');
    commitAll(dir);
    try {
      git(dir, 'merge', '-q', 'other');
    } catch {
      // Конфликт и нужен.
    }
    await writeFile(path.join(dir, 'mod.ts'), '2\n');
    await unlink(path.join(dir, 'del.ts'));
    git(dir, 'mv', 'old.ts', 'new.ts');
    await mkdir(path.join(dir, 'fresh'));
    await writeFile(path.join(dir, 'fresh', 'n.ts'), 'n\n');
    expect(await api(dir).gitStatus(ROOT)).toEqual({ 'mod.ts': 'M', 'del.ts': 'D', 'new.ts': 'R', 'conf.ts': 'M', 'fresh/n.ts': 'U' });
  });

  it('корень — подкаталог sub/: пути от sub, top.txt вне корня нет', async () => {
    await initRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'top.txt'), '1\n');
    await writeFile(path.join(dir, 'sub', 'a.txt'), '1\n');
    commitAll(dir);
    await writeFile(path.join(dir, 'top.txt'), '2\n');
    await writeFile(path.join(dir, 'sub', 'a.txt'), '2\n');
    await mkdir(path.join(dir, 'sub', '.harnas'));
    await writeFile(path.join(dir, 'sub', '.harnas', 'log'), 'x');
    expect(await api(path.join(dir, 'sub')).gitStatus(ROOT)).toEqual({ 'a.txt': 'M' });
  });

  it('parseGitStatus: таблица XY, старый путь R и C пропускается, вне prefix — нет', () => {
    const out = Buffer.from(
      ['?? sub/u.ts', 'AA sub/c1.ts', 'DU sub/c2.ts', 'R  sub/new.ts', 'sub/old.ts', 'C  sub/copy.ts', 'sub/src.ts', ' D sub/d.ts', 'A  sub/a.ts', ' T sub/t.ts', 'MM sub/m.ts', ' M top.ts', 'R  sub/moved.ts', 'top-old.ts', ''].join('\0'),
    );
    expect(parseGitStatus(out, 'sub/')).toEqual({
      'u.ts': 'U',
      'c1.ts': 'M',
      'c2.ts': 'M',
      'new.ts': 'R',
      'copy.ts': 'A',
      'd.ts': 'D',
      'a.ts': 'A',
      't.ts': 'M',
      'm.ts': 'M',
      'moved.ts': 'R',
    });
  });

  it('имя __proto__ — собственное поле, прототип не тронут', () => {
    const status = parseGitStatus(Buffer.from('?? __proto__\0'), '');
    expect(Object.keys(status)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(status)).toBe(Object.prototype);
  });
});

describe('не git (тест 9)', () => {
  const enoent: GitRunner = {
    run: async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    },
  };

  for (const [name, runner] of [
    ['git нет в PATH (ENOENT)', enoent],
    ['папка без git (выход 128)', createGitRunner(process.env)],
  ] as const) {
    it(`${name}: gitStatus {}, checkIgnored пусто, lsFiles и grep обходом`, async () => {
      await writeFile(path.join(dir, 'a.txt'), 'needle\n');
      const a = api(dir, runner);
      expect(await a.gitStatus(ROOT)).toEqual({});
      expect(await a.checkIgnored(ROOT, '', ['a.txt'])).toEqual(new Set());
      expect(await a.lsFiles(ROOT)).toEqual(['a.txt']);
      expect((await a.grep(ROOT, Q('needle'), 's')).files).toEqual([
        { path: 'a.txt', hits: [{ line: 1, text: 'needle', ranges: [[0, 6]] }] },
      ]);
    });
  }

  it('createGitRunner: git нет в PATH — отказ с code ENOENT', async () => {
    const runner = createGitRunner({ ...process.env, PATH: dir });
    await expect(runner.run(['--version'], dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('checkIgnored', () => {
  it('игнорируемые — в наборе; выход 1 — пустой набор без ошибки', async () => {
    await initRepo(dir);
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n*.log\n');
    await mkdir(path.join(dir, 'node_modules'));
    await mkdir(path.join(dir, 'src'));
    const a = api(dir);
    expect(await a.checkIgnored(ROOT, '', ['node_modules', 'a.log', 'src', 'b.ts'])).toEqual(new Set(['node_modules', 'a.log']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await a.checkIgnored(ROOT, 'src', ['x.ts'])).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('папка за каталогом-ссылкой (git выходит с 128): предупреждение один раз на папку, ignored пусто (раунд fix-7.1b, п.4)', async () => {
    await initRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    await mkdir(path.join(dir, 'other'));
    await symlink(path.join(dir, 'sub'), path.join(dir, 'lnk'));
    await symlink(path.join(dir, 'other'), path.join(dir, 'lnk2'));
    const a = api(dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect(await a.checkIgnored(ROOT, 'lnk', ['x.ts'])).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await a.checkIgnored(ROOT, 'lnk2', ['y.ts'])).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('walkFiles и поиск без git (тест 11)', () => {
  it('каталог-ссылка наружу не обходится; файл-ссылка наружу — нет, внутри — да; FIFO — нет, поиск не виснет', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-outside-')));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'needle secret\n');
      await mkdir(path.join(dir, 'docs'));
      await symlink(outside, path.join(dir, 'docs', 'home'));
      await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'out-link.txt'));
      await writeFile(path.join(dir, 'real.txt'), 'needle real\n');
      await symlink(path.join(dir, 'real.txt'), path.join(dir, 'in-link.txt'));
      await mkdir(path.join(dir, '.harnas'));
      await writeFile(path.join(dir, '.harnas', 'map.json'), 'needle map\n');
      await symlink(path.join(dir, '.harnas', 'map.json'), path.join(dir, 'map-link.txt'));
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      expect((await walkFiles(dir, 50_000)).paths.sort()).toEqual(['in-link.txt', 'real.txt']);
      const enoent: GitRunner = {
        run: async () => {
          throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
        },
      };
      const result = await api(dir, enoent).grep(ROOT, Q('needle'), 's');
      expect(result.files.map((f) => f.path).sort()).toEqual(['in-link.txt', 'real.txt']);
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('предел обхода', async () => {
    for (let i = 0; i < 5; i++) await writeFile(path.join(dir, `f${i}`), '');
    expect(await walkFiles(dir, 3)).toEqual({ paths: expect.any(Array), truncated: true });
    expect((await walkFiles(dir, 3)).paths).toHaveLength(3);
    expect(await walkFiles(dir, 5)).toEqual({ paths: expect.any(Array), truncated: false });
  });
});

describe('обход: отмена и бюджет времени (раунд fix-7.1b, п.1)', () => {
  /** 40 каталогов по 2 файла и файл в корне. */
  async function tree(): Promise<void> {
    await writeFile(path.join(dir, 'top.txt'), 'needle\n');
    for (let i = 0; i < 40; i++) {
      await mkdir(path.join(dir, `d${i}`));
      await writeFile(path.join(dir, `d${i}`, 'a.txt'), 'needle\n');
      await writeFile(path.join(dir, `d${i}`, 'b.txt'), 'needle\n');
    }
  }

  it('отмена посреди обхода: найденное к этому моменту и truncated', async () => {
    await tree();
    const controller = new AbortController();
    let dirs = 0;
    // Часы спрашиваются на каждом каталоге: третий каталог отменяет обход.
    const now = (): number => {
      dirs += 1;
      if (dirs === 3) controller.abort();
      return 0;
    };
    const result = await walkFiles(dir, 50_000, { signal: controller.signal, budgetMs: 10_000, now });
    expect(result.truncated).toBe(true);
    expect(result.paths).toContain('top.txt');
    expect(result.paths.length).toBeLessThan(81);
  });

  it('бюджет времени: обход останавливается с truncated', async () => {
    await tree();
    let clock = 0;
    const result = await walkFiles(dir, 50_000, { budgetMs: 5, now: () => clock++ });
    expect(result.truncated).toBe(true);
    expect(result.paths).toContain('top.txt');
    expect(result.paths.length).toBeLessThan(81);
  });

  it('без отмены и бюджета — всё дерево, truncated false', async () => {
    await tree();
    const result = await walkFiles(dir, 50_000);
    expect(result).toEqual({ paths: expect.any(Array), truncated: false });
    expect(result.paths).toHaveLength(81);
  });

  it('grep без git: бюджет обхода исчерпан — найденное в корне и truncated', async () => {
    await tree();
    const result = await api(dir, createGitRunner(process.env), { walkBudgetMs: 0 }).grep(ROOT, Q('needle'), 's');
    expect(result.truncated).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(['top.txt']);
  });

  it('lsFiles без git: частичный список по бюджету не кэшируется', async () => {
    await tree();
    // Тот же объект настроек: бюджет читается на каждом вызове.
    const options = { git: createGitRunner(process.env), roots: { rootPath: () => dir }, spawnWorker, walkBudgetMs: 0, isTreeWatched: () => true };
    const a = createGitApi(options);
    expect(await a.lsFiles(ROOT)).toEqual(['top.txt']);
    options.walkBudgetMs = 10_000;
    expect(await a.lsFiles(ROOT)).toHaveLength(81);
  });
});

describe('кэш lsFiles (тест 14)', () => {
  it('корень без слежения не кэшируется; под слежением — до invalidate', async () => {
    await writeFile(path.join(dir, 'a.txt'), '');
    let watched = false;
    const a = api(dir, createGitRunner(process.env), { isTreeWatched: () => watched });
    expect(await a.lsFiles(ROOT)).toEqual(['a.txt']);
    await writeFile(path.join(dir, 'b.txt'), '');
    expect((await a.lsFiles(ROOT)).sort()).toEqual(['a.txt', 'b.txt']);
    watched = true;
    expect((await a.lsFiles(ROOT)).sort()).toEqual(['a.txt', 'b.txt']);
    await writeFile(path.join(dir, 'c.txt'), '');
    expect((await a.lsFiles(ROOT)).sort()).toEqual(['a.txt', 'b.txt']);
    a.invalidate(rootKey(ROOT));
    expect((await a.lsFiles(ROOT)).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });
});

describe('длинная строка попадания (раунд fix-7.1b, п.2)', () => {
  const half = 'x'.repeat(2_500_000);
  const body = `head\n${half}NEEDLE${half}\ntail\n`;

  for (const kind of ['git', 'не git'] as const) {
    it(`${kind}: строка 5 МБ → text ≤ 1000, ranges на совпадении`, async () => {
      if (kind === 'git') await initRepo(dir);
      await writeFile(path.join(dir, 'min.js'), body);
      const result = await api(dir).grep(ROOT, Q('NEEDLE'), 's');
      const hit = result.files[0]?.hits[0];
      expect(hit?.line).toBe(2);
      expect(hit?.text.length).toBeLessThanOrEqual(1000);
      const [start, end] = hit?.ranges[0] ?? [0, 0];
      expect(hit?.text.slice(start, end)).toBe('NEEDLE');
    });
  }

  it('runGrepWorker ranges: отменён до подсветки — неподсвеченные тоже окном', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGrepWorker(
      { kind: 'ranges', query: Q('NEEDLE'), files: [{ path: 'min.js', hits: [{ line: 2, text: `${half}NEEDLE${half}`, ranges: [] }] }] },
      { signal: controller.signal, timeoutMs: 10_000, spawn: spawnWorker },
    );
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.hits[0]?.text.length).toBeLessThanOrEqual(1000);
  });
});

describe('неверная регулярка (раунд fix-7.1b, п.3)', () => {
  for (const kind of ['git', 'не git'] as const) {
    it(`${kind}: неверная для RegExp → bad_request до запуска git и воркера`, async () => {
      if (kind === 'git') await initRepo(dir);
      await writeFile(path.join(dir, 'a.txt'), 'a(b\n');
      const runner = createGitRunner(process.env);
      const a = api(dir, runner);
      const spy = vi.spyOn(runner, 'run');
      let spawned = 0;
      const counted = api(dir, runner, {
        spawnWorker: () => {
          spawned += 1;
          return spawnWorker();
        },
      });
      expect(await codeOf(counted.grep(ROOT, Q('a(', { regex: true }), 's'))).toBe('bad_request');
      expect(spy.mock.calls.filter(([args]) => args.includes('grep'))).toHaveLength(0);
      expect(spawned).toBe(0);
      // Без режима регулярки тот же текст — просто текст.
      expect((await a.grep(ROOT, Q('a('), 's')).files.map((f) => f.path)).toEqual(['a.txt']);
    });
  }

  it('git: верная для RegExp, но не для ERE — прочий код git → failed', async () => {
    await initRepo(dir);
    await writeFile(path.join(dir, 'a.txt'), 'x\n');
    expect(await codeOf(api(dir).grep(ROOT, Q('(?:x)', { regex: true }), 's'))).toBe('failed');
  });
});

describe('lsFiles: ссылки в .git и .harnas (раунд fix-7.1b, п.6)', () => {
  async function links(): Promise<void> {
    await mkdir(path.join(dir, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(dir, '.harnas', 'works', 'w', 'map.json'), '{}');
    await writeFile(path.join(dir, 'real.txt'), 'x');
    await symlink('real.txt', path.join(dir, 'in-link.txt'));
    await symlink('.harnas/works/w/map.json', path.join(dir, 'link.json'));
    await symlink('.harnas', path.join(dir, 'harnas-dir'));
  }

  it('git: отслеживаемая и новая ссылка в .harnas/.git не отдаются; обычная ссылка — да', async () => {
    await initRepo(dir);
    await links();
    commitAll(dir);
    await symlink('.git/config', path.join(dir, 'git-config'));
    await symlink('.harnas/works/w/map.json', path.join(dir, 'fresh-link.json'));
    expect((await api(dir).lsFiles(ROOT)).sort()).toEqual(['in-link.txt', 'real.txt']);
  });

  it('не git: то же обходом', async () => {
    await links();
    await mkdir(path.join(dir, '.git'));
    await writeFile(path.join(dir, '.git', 'config'), '');
    await symlink('.git/config', path.join(dir, 'git-config'));
    const enoent: GitRunner = {
      run: async () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      },
    };
    expect((await api(dir, enoent).lsFiles(ROOT)).sort()).toEqual(['in-link.txt', 'real.txt']);
  });
});
