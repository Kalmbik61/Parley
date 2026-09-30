import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureShellEnv } from './shell-env.js';

/**
 * Маркеры вокруг PATH из вывода оболочки. Тесты берут их из самой команды, которую окно отдаёт
 * оболочке, а не дублируют литералы: сломается команда — сломается и разбор, и тест это увидит.
 */
const PATH_MARKERS = /'(__[A-Z_]+_BEGIN__)' "\$PATH" '(__[A-Z_]+_END__)'/;

function markersOf(script: string): { begin: string; end: string } {
  const found = PATH_MARKERS.exec(script);
  if (found?.[1] === undefined || found[2] === undefined) {
    throw new Error(`в команде для оболочки нет маркеров вокруг $PATH: ${script}`);
  }
  return { begin: found[1], end: found[2] };
}

/** Что оболочка напечатала бы на `script`: шум rc до, значение в маркерах, шум выхода после. */
function shellSays(script: string, value: string, noise = true): string {
  const { begin, end } = markersOf(script);
  return noise
    ? `rc noise\nexport PATH=/decoy/from/rc\n${begin}${value}${end}\nlogout noise\n`
    : `${begin}${value}${end}`;
}

/** Каталоги, которые «существуют» в подставной файловой системе. */
const dirsExisting =
  (...dirs: string[]) =>
  (dir: string): Promise<boolean> =>
    Promise.resolve(dirs.includes(dir));

/** Урезанный PATH, какой launchd отдаёт приложению из Finder. */
const FINDER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', FOO: 'bar' };

describe('captureShellEnv: подставной run', () => {
  it('берёт PATH только из маркеров: шум rc до и после них в PATH не попадает', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', '/opt/a/bin:/home/u/.nvm/bin')),
    });

    expect(result.fromShell).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.env.PATH).toBe('/opt/a/bin:/home/u/.nvm/bin');
  });

  it('остальное окружение остаётся как есть: ни один другой ключ не меняется и не добавляется', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      // Оболочка «экспортировала» бы и другие переменные; окно их не читает — только PATH.
      run: (_shell, args) =>
        Promise.resolve(`export FOO=changed\nNEW=1\n${shellSays(args[1] ?? '', '/x/bin:/y/bin')}`),
    });

    expect(result.env).toEqual({ PATH: '/x/bin:/y/bin', SHELL: '/bin/zsh', FOO: 'bar' });
  });

  it('оболочку зовут один раз как «$SHELL -ilc <команда>» с маркерами вокруг $PATH и таймаутом', async () => {
    const calls: { shell: string; args: string[]; timeoutMs: number }[] = [];

    await captureShellEnv({
      env: { PATH: '/usr/bin', SHELL: '/bin/bash' },
      timeoutMs: 1234,
      run: (shell, args, timeoutMs) => {
        calls.push({ shell, args, timeoutMs });
        return Promise.resolve(shellSays(args[1] ?? '', '/z/bin'));
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.shell).toBe('/bin/bash');
    expect(calls[0]?.args[0]).toBe('-ilc');
    expect(calls[0]?.args).toHaveLength(2);
    expect(markersOf(calls[0]?.args[1] ?? '').begin).not.toBe(markersOf(calls[0]?.args[1] ?? '').end);
    expect(calls[0]?.timeoutMs).toBe(1234);
  });

  it('без $SHELL берёт /bin/zsh', async () => {
    let asked = '';

    await captureShellEnv({
      env: { PATH: '/usr/bin' },
      run: (shell, args) => {
        asked = shell;
        return Promise.resolve(shellSays(args[1] ?? '', '/z/bin'));
      },
    });

    expect(asked).toBe('/bin/zsh');
  });

  it('значение с переводом строки — не PATH: запасной путь, а не мусор в окружении', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', '/a/bin\nоборванный вывод')),
    });

    expect(result.fromShell).toBe(false);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });
});

describe('captureShellEnv: оболочка не помогла', () => {
  it('таймаут: прежний PATH плюс существующие ~/.local/bin, /opt/homebrew/bin и /usr/local/bin', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      timeoutMs: 20,
      isDir: dirsExisting('/home/u/.local/bin', '/usr/local/bin'),
      run: () => new Promise<string>(() => {}),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/did not respond/);
    expect(result.env).toEqual({
      ...FINDER_ENV,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/home/u/.local/bin:/usr/local/bin',
    });
  });

  it('пустой ответ: оболочка ничего не напечатала — запасной PATH', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting('/opt/homebrew/bin'),
      run: () => Promise.resolve(''),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).not.toBeNull();
    expect(result.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  });

  it('маркеры есть, а PATH между ними пуст — тоже запасной PATH', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', '')),
    });

    expect(result.fromShell).toBe(false);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });

  it('маркеров нет (rc упал, остался один шум): запасной PATH и предупреждение', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: () => Promise.resolve('zsh: command not found: nvm\nPATH=/decoy\n'),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/markers/);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });

  it('оболочка не запустилась (run бросает): запасной PATH, текст ошибки — в предупреждении', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting('/usr/local/bin'),
      run: () => Promise.reject(new Error('spawn /bin/zsh ENOENT')),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toBe('spawn /bin/zsh ENOENT');
    expect(result.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin');
  });

  it('каталог, уже стоящий в PATH, второй раз не дописывается; несуществующие пропускаются', async () => {
    const result = await captureShellEnv({
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      home: '/home/u',
      isDir: dirsExisting('/opt/homebrew/bin', '/home/u/.local/bin'),
      run: () => Promise.resolve(''),
    });

    expect(result.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/home/u/.local/bin');
  });

  it('прежнего PATH нет вовсе: остаются одни существующие запасные каталоги', async () => {
    const result = await captureShellEnv({
      env: {},
      home: '/home/u',
      isDir: dirsExisting('/home/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'),
      run: () => Promise.resolve(''),
    });

    expect(result.env.PATH).toBe('/home/u/.local/bin:/opt/homebrew/bin:/usr/local/bin');
  });

  it('прочее окружение при неудаче тоже не трогается', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: () => Promise.resolve(''),
    });

    expect(result.env).toEqual(FINDER_ENV);
  });
});

/**
 * Настоящий `runShell` — но не оболочка человека: заглушка-скрипт лежит во временном каталоге,
 * читает свои аргументы как `$SHELL -ilc <команда>`, печатает шум rc, исполняет команду под
 * `sh` с известным PATH и печатает шум выхода. Так проверены и сама команда (кавычки, маркеры),
 * и порядок аргументов, и сбор stdout, и убийство по таймауту — без rc-файлов и без запуска
 * чего-либо, что есть только у человека.
 */
describe('captureShellEnv: заглушка оболочки в файле', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'shell-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function stubShell(body: string): Promise<string> {
    const file = path.join(dir, 'stub-shell');
    await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(file, 0o755);
    return file;
  }

  it('шум rc и выхода вокруг маркеров отброшен, PATH — ровно тот, что оболочка напечатала', async () => {
    const shell = await stubShell(
      [
        'echo "rc noise"',
        'echo "PATH=/decoy/from/rc"',
        '[ "$1" = "-ilc" ] || { echo "неверные аргументы: $*"; exit 3; }',
        'PATH="/stub/nvm/bin:/stub/local/bin:/usr/bin"; export PATH',
        'eval "$2"',
        'echo "logout noise"',
      ].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/nvm/bin:/stub/local/bin:/usr/bin');
    expect(result.env.FOO).toBe('bar');
  });

  it('оболочка, вышедшая с ненулевым кодом уже после маркеров, PATH не отменяет', async () => {
    const shell = await stubShell(
      ['PATH="/stub/bin"; export PATH', 'eval "$2"', 'exit 1'].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/bin');
  });

  it('оболочка молчит и выходит: запасной PATH', async () => {
    const shell = await stubShell('exit 0');

    const result = await captureShellEnv({
      shell,
      env: FINDER_ENV,
      home: dir,
      isDir: dirsExisting(),
    });

    expect(result.fromShell).toBe(false);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });

  it('оболочка зависла: процесс убит по таймауту, запасной PATH', async () => {
    // exec: у заглушки нет дочерних процессов, SIGKILL достаётся самому sleep.
    const shell = await stubShell('exec sleep 30');
    const started = Date.now();

    const result = await captureShellEnv({
      shell,
      env: FINDER_ENV,
      home: dir,
      timeoutMs: 300,
      isDir: dirsExisting(),
    });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/did not respond/);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });

  it('оболочки по этому пути нет: запасной PATH, а не падение окна', async () => {
    const result = await captureShellEnv({
      shell: path.join(dir, 'no-such-shell'),
      env: FINDER_ENV,
      home: dir,
      isDir: dirsExisting(),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/ENOENT/);
    expect(result.env.PATH).toBe(FINDER_ENV.PATH);
  });
});
