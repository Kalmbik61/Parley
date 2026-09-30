import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureShellEnv } from './shell-env.js';

/**
 * Маркеры вокруг вывода `env -0`. Тесты берут их из самой команды, которую окно отдаёт оболочке,
 * а не дублируют литералы: сломается команда — сломается и разбор, и тест это увидит.
 */
const ENV_MARKERS = /'(__[A-Z_]+_BEGIN__)';\s*\S*env -0;\s*printf '%s' '(__[A-Z_]+_END__)'/;

function markersOf(script: string): { begin: string; end: string } {
  const found = ENV_MARKERS.exec(script);
  if (found?.[1] === undefined || found[2] === undefined) {
    throw new Error(`в команде для оболочки нет маркеров вокруг env -0: ${script}`);
  }
  return { begin: found[1], end: found[2] };
}

/** Вывод `env -0`: записи `ИМЯ=значение`, каждая кончается NUL. */
function envDump(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}=${value}\0`)
    .join('');
}

/**
 * Что оболочка напечатала бы на `script`: шум rc до, окружение в маркерах, шум выхода после. Шум
 * нарочно похож на записи окружения (`ИМЯ=значение`, NUL): разбирать его как переменные нельзя.
 */
function shellSays(script: string, vars: Readonly<Record<string, string>>, noise = true): string {
  const { begin, end } = markersOf(script);
  const body = `${begin}${envDump(vars)}${end}`;
  return noise
    ? `rc noise\nexport PATH=/decoy/from/rc\nDECOY_BEFORE=1\0\n${body}\nlogout noise\nDECOY_AFTER=1\0\n`
    : body;
}

/** Каталоги, которые «существуют» в подставной файловой системе. */
const dirsExisting =
  (...dirs: string[]) =>
  (dir: string): Promise<boolean> =>
    Promise.resolve(dirs.includes(dir));

/** Урезанное окружение, какое launchd отдаёт приложению из Finder. */
const FINDER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', FOO: 'bar' };

describe('captureShellEnv: подставной run', () => {
  it('окружение оболочки доходит целиком: переменные из rc, значение с переводом строки и «=» внутри', async () => {
    const shellEnv = {
      PATH: '/opt/a/bin:/home/u/.nvm/bin:/usr/bin',
      HOME: '/home/u',
      SHELL: '/bin/zsh',
      HTTPS_PROXY: 'http://proxy.local:3128',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      ANTHROPIC_MODEL: 'opus',
      PARLEY_HOME: '/home/u/.parley-work',
      MULTILINE: 'первая строка\nвторая строка=с равно\n',
      KEY_VALUE: 'a=b=c',
      LEADING_EQ: '=значение',
      EMPTY: '',
    };

    const result = await captureShellEnv({
      env: FINDER_ENV,
      run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', shellEnv)),
    });

    expect(result.fromShell).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.env).toEqual(shellEnv);
  });

  it('шум rc до и после маркеров в окружение не попадает — даже вида ИМЯ=значение', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      run: (_shell, args) =>
        Promise.resolve(shellSays(args[1] ?? '', { PATH: '/opt/a/bin:/home/u/.nvm/bin', ONE: '1' })),
    });

    expect(result.fromShell).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.env).toEqual({ PATH: '/opt/a/bin:/home/u/.nvm/bin', ONE: '1' });
  });

  it('результат — окружение оболочки, а не сумма с окружением окна: значения оболочки главнее, снятое rc не воскресает', async () => {
    // Как до куска 11b: оболочка наследует окружение окна, всё, что она отдала, и есть окружение
    // хоста. FOO снят rc-файлом (его нет в ответе) — назад из окружения окна не возвращается.
    const result = await captureShellEnv({
      env: { ...FINDER_ENV, FROM_LAUNCHD: 'stale' },
      run: (_shell, args) =>
        Promise.resolve(shellSays(args[1] ?? '', { PATH: '/z/bin', FROM_LAUNCHD: 'fresh' })),
    });

    expect(result.env).toEqual({ PATH: '/z/bin', FROM_LAUNCHD: 'fresh' });
  });

  it('записи без «=» и без имени не переменные: пропускаются, остальные разобраны', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      run: (_shell, args) => {
        const { begin, end } = markersOf(args[1] ?? '');
        return Promise.resolve(`${begin}мусор без равно\0=без имени\0PATH=/x/bin\0ONE=1\0${end}`);
      },
    });

    expect(result.fromShell).toBe(true);
    expect(result.env).toEqual({ PATH: '/x/bin', ONE: '1' });
  });

  it('оболочку зовут один раз как «$SHELL -ilc <команда>» с env -0 между маркерами и таймаутом', async () => {
    const calls: { shell: string; args: string[]; timeoutMs: number }[] = [];

    await captureShellEnv({
      env: { PATH: '/usr/bin', SHELL: '/bin/bash' },
      timeoutMs: 1234,
      run: (shell, args, timeoutMs) => {
        calls.push({ shell, args, timeoutMs });
        return Promise.resolve(shellSays(args[1] ?? '', { PATH: '/z/bin' }));
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
        return Promise.resolve(shellSays(args[1] ?? '', { PATH: '/z/bin' }));
      },
    });

    expect(asked).toBe('/bin/zsh');
  });
});

describe('captureShellEnv: оболочка не помогла', () => {
  it('таймаут: окружение окна, в PATH — существующие ~/.local/bin, /opt/homebrew/bin и /usr/local/bin', async () => {
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

  it('пустой ответ: оболочка ничего не напечатала — запасной путь', async () => {
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

  it('маркеры есть, а между ними пусто (env -0 не сработал) — тоже запасной путь', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', {})),
    });

    expect(result.fromShell).toBe(false);
    expect(result.env).toEqual(FINDER_ENV);
  });

  it('в окружении оболочки нет PATH или он пуст — это не то окружение: запасной путь, а не хост без PATH', async () => {
    for (const vars of [{ FOO: 'from-shell' }, { PATH: '', FOO: 'from-shell' }]) {
      const result = await captureShellEnv({
        env: FINDER_ENV,
        home: '/home/u',
        isDir: dirsExisting(),
        run: (_shell, args) => Promise.resolve(shellSays(args[1] ?? '', vars)),
      });

      expect(result.fromShell).toBe(false);
      expect(result.warning).toMatch(/PATH/);
      expect(result.env).toEqual(FINDER_ENV);
    }
  });

  it('маркеров нет (rc упал, остался один шум): запасной путь и предупреждение', async () => {
    const result = await captureShellEnv({
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting(),
      run: () => Promise.resolve('zsh: command not found: nvm\nPATH=/decoy\0DECOY=1\0'),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/markers/);
    expect(result.env).toEqual(FINDER_ENV);
  });

  it('оболочка не запустилась (run бросает): запасной путь, текст ошибки — в предупреждении', async () => {
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

/** `PARLEY_LOGIN_SHELL=skip` (E2E): `index.ts` передаёт `skip: switches.loginShell`. */
describe('captureShellEnv: skip (PARLEY_LOGIN_SHELL=skip)', () => {
  it('оболочку не зовёт: окружение окна как есть, копией, без запасных каталогов и без предупреждения', async () => {
    let called = false;

    const result = await captureShellEnv({
      skip: true,
      env: FINDER_ENV,
      home: '/home/u',
      isDir: dirsExisting('/home/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'),
      run: () => {
        called = true;
        return Promise.resolve('');
      },
    });

    expect(called).toBe(false);
    expect(result).toEqual({ env: FINDER_ENV, fromShell: false, warning: null });
    expect(result.env).not.toBe(FINDER_ENV);
  });

  it('без skip оболочку зовут', async () => {
    let called = false;

    await captureShellEnv({
      skip: false,
      env: FINDER_ENV,
      run: () => {
        called = true;
        return Promise.resolve('');
      },
    });

    expect(called).toBe(true);
  });
});

/**
 * Настоящий `runShell` — но не оболочка человека: заглушка-скрипт лежит во временном каталоге,
 * читает свои аргументы как `$SHELL -ilc <команда>`, печатает шум rc, экспортирует переменные «как
 * rc-файл», исполняет команду под `sh` и печатает шум выхода. Так проверены и сама команда
 * (кавычки, маркеры, `env -0`), и порядок аргументов, и сбор stdout, и убийство по таймауту — без
 * rc-файлов и без запуска чего-либо, что есть только у человека.
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

  it('переменные rc доходят все — со значением с переводом строки и «=», шум вокруг маркеров отброшен', async () => {
    const shell = await stubShell(
      [
        'echo "rc noise"',
        'echo "PATH=/decoy/from/rc"',
        '[ "$1" = "-ilc" ] || { echo "неверные аргументы: $*"; exit 3; }',
        'PATH="/stub/nvm/bin:/stub/local/bin:/usr/bin"; export PATH',
        'HTTPS_PROXY=http://proxy.local:3128; export HTTPS_PROXY',
        'CLAUDE_CONFIG_DIR=/stub/claude-work; export CLAUDE_CONFIG_DIR',
        'PARLEY_HOME=/stub/parley-work; export PARLEY_HOME',
        `MULTILINE='первая строка
вторая строка=с равно'; export MULTILINE`,
        'KEY_VALUE="a=b=c"; export KEY_VALUE',
        'NOT_EXPORTED=1',
        'eval "$2"',
        'echo "logout noise"',
        'echo "DECOY_AFTER=1"',
      ].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/nvm/bin:/stub/local/bin:/usr/bin');
    expect(result.env.HTTPS_PROXY).toBe('http://proxy.local:3128');
    expect(result.env.CLAUDE_CONFIG_DIR).toBe('/stub/claude-work');
    expect(result.env.PARLEY_HOME).toBe('/stub/parley-work');
    expect(result.env.MULTILINE).toBe('первая строка\nвторая строка=с равно');
    expect(result.env.KEY_VALUE).toBe('a=b=c');
    expect(result.env.NOT_EXPORTED).toBeUndefined();
    expect(result.env.DECOY_AFTER).toBeUndefined();
  });

  it('большое окружение приходит в несколько чанков и разбирается целиком', async () => {
    const shell = await stubShell(
      [
        'PATH="/stub/bin:/usr/bin"; export PATH',
        // 200 переменных по тысяче символов — около 200 КБ: больше буфера трубы, ответ собирается
        // из многих чанков, а маркер конца приходит в последнем.
        `V=$(printf '%01000d' 0)`,
        'i=0',
        'while [ "$i" -lt 200 ]; do export "BIGVAR_$i=$V"; i=$((i + 1)); done',
        'AFTER_BIG=да; export AFTER_BIG',
        'eval "$2"',
      ].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    const big = Object.entries(result.env).filter(([name]) => name.startsWith('BIGVAR_'));
    expect(big).toHaveLength(200);
    expect(big.every(([, value]) => value === '0'.repeat(1000))).toBe(true);
    expect(result.env.AFTER_BIG).toBe('да');
    expect(result.env.PATH).toBe('/stub/bin:/usr/bin');
  });

  it('оболочка, вышедшая с ненулевым кодом уже после маркеров, окружение не отменяет', async () => {
    const shell = await stubShell(
      ['PATH="/stub/bin"; export PATH', 'ONLY_IN_RC=1; export ONLY_IN_RC', 'eval "$2"', 'exit 1'].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/bin');
    expect(result.env.ONLY_IN_RC).toBe('1');
  });

  it('функция env и PATH без /usr/bin в rc окружению не мешают: env зовётся по абсолютному пути', async () => {
    const shell = await stubShell(
      [
        'env() { echo "подменённый env"; }',
        'PATH="/stub/bin"; export PATH',
        'ONLY_IN_RC=1; export ONLY_IN_RC',
        'eval "$2"',
      ].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/bin');
    expect(result.env.ONLY_IN_RC).toBe('1');
  });

  it('оболочка молчит и выходит: запасной путь', async () => {
    const shell = await stubShell('exit 0');

    const result = await captureShellEnv({
      shell,
      env: FINDER_ENV,
      home: dir,
      isDir: dirsExisting(),
    });

    expect(result.fromShell).toBe(false);
    expect(result.env).toEqual(FINDER_ENV);
  });

  it('оболочка зависла: процесс убит по таймауту, запасной путь', async () => {
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
    expect(result.env).toEqual(FINDER_ENV);
  });

  it('оболочки по этому пути нет: запасной путь, а не падение окна', async () => {
    const result = await captureShellEnv({
      shell: path.join(dir, 'no-such-shell'),
      env: FINDER_ENV,
      home: dir,
      isDir: dirsExisting(),
    });

    expect(result.fromShell).toBe(false);
    expect(result.warning).toMatch(/ENOENT/);
    expect(result.env).toEqual(FINDER_ENV);
  });

  it('фоновый процесс rc держит stdout: окружение берётся, не дожидаясь закрытия трубы', async () => {
    // Как rc, оставивший процесс с унаследованным stdout: труба открыта, пока тот жив, и `close` не
    // приходит. Раньше окно ждало таймаута и выбрасывало уже напечатанное между маркерами.
    const shell = await stubShell(
      [
        '( sleep 3 & )',
        'PATH="/stub/bin"; export PATH',
        'ONLY_IN_RC=1; export ONLY_IN_RC',
        'eval "$2"',
        'exit 0',
      ].join('\n'),
    );
    const started = Date.now();

    const result = await captureShellEnv({ shell, env: FINDER_ENV, timeoutMs: 2000 });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/stub/bin');
    expect(result.env.ONLY_IN_RC).toBe('1');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('символ не из ASCII, разорванный границей чанков, окружение не портит', async () => {
    // Значение приходит двумя записями с паузой, граница — посреди двухбайтного «п» (D0 BF): декодер
    // без состояния сделал бы из каждой половины U+FFFD. Маркеры заглушка берёт из присланной команды.
    const shell = await stubShell(
      [
        `begin=$(printf '%s' "$2" | sed -n "s/.*'\\(__[A-Z_]*_BEGIN__\\)'.*/\\1/p")`,
        `end=$(printf '%s' "$2" | sed -n "s/.*'\\(__[A-Z_]*_END__\\)'.*/\\1/p")`,
        `printf '%sPATH=/\\320' "$begin"`,
        'sleep 0.3',
        `printf '\\277/bin\\000%s' "$end"`,
      ].join('\n'),
    );

    const result = await captureShellEnv({ shell, env: FINDER_ENV });

    expect(result.warning).toBeNull();
    expect(result.fromShell).toBe(true);
    expect(result.env.PATH).toBe('/п/bin');
  });
});
