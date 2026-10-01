import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledNodeBin,
  hostPaths,
  resolveHostEntry,
  resolveNodeBin,
  spawnHost,
} from './host-launcher.js';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

/**
 * `resolveNodeBin` ищет `node` в PATH логин-шелла — не в `process.execPath`
 * (см. правку куска 1.9): под Node самого Electron `node-pty` хоста не
 * загрузится (спека 3.2). Тут PATH подставной, реального Electron нет.
 */
describe('resolveNodeBin', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hl-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('находит исполняемый node в одном из каталогов PATH', async () => {
    const emptyDir = path.join(home, 'empty');
    const binDir = path.join(home, 'bin');
    await mkdir(emptyDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    const nodePath = path.join(binDir, 'node');
    await writeFile(nodePath, '#!/bin/sh\n', 'utf8');
    await chmod(nodePath, 0o755);

    const found = await resolveNodeBin({ PATH: [emptyDir, binDir].join(path.delimiter) });

    expect(found).toBe(nodePath);
  });

  it('пропускает неисполняемый файл node и идёт дальше по PATH', async () => {
    const notExecutableDir = path.join(home, 'not-exec');
    const binDir = path.join(home, 'bin');
    await mkdir(notExecutableDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(notExecutableDir, 'node'), '#!/bin/sh\n', 'utf8');
    await chmod(path.join(notExecutableDir, 'node'), 0o644);
    const nodePath = path.join(binDir, 'node');
    await writeFile(nodePath, '#!/bin/sh\n', 'utf8');
    await chmod(nodePath, 0o755);

    const found = await resolveNodeBin({ PATH: [notExecutableDir, binDir].join(path.delimiter) });

    expect(found).toBe(nodePath);
  });

  it('возвращает null, когда node нигде в PATH нет', async () => {
    const emptyDir = path.join(home, 'empty');
    await mkdir(emptyDir, { recursive: true });

    const found = await resolveNodeBin({ PATH: emptyDir });

    expect(found).toBeNull();
  });

  it('возвращает null для пустого PATH', async () => {
    const found = await resolveNodeBin({});

    expect(found).toBeNull();
  });
});

/**
 * Собранное окно идёт со своим Node 22 в `Contents/Resources/node/bin/node` (`scripts/fetch-node.mjs` и
 * `extraResources`): его берёт хост, а за ним — сервер MCP, строка статуса и `notify` Codex (все берут
 * `process.execPath` хоста). Каталог приложения человек выбирает сам, поэтому в пути бывают пробелы.
 */
describe('resolveNodeBin: встроенный node собранного приложения', () => {
  let home: string;
  let resources: string;
  let bundled: string;
  let systemNode: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hl-'));
    resources = path.join(home, 'My Apps', 'Parley.app', 'Contents', 'Resources');
    bundled = bundledNodeBin(resources);
    const systemBin = path.join(home, 'bin');
    await mkdir(systemBin, { recursive: true });
    systemNode = path.join(systemBin, 'node');
    await writeFile(systemNode, '#!/bin/sh\n', 'utf8');
    await chmod(systemNode, 0o755);
    env = { PATH: systemBin };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const installBundled = async (mode: number): Promise<void> => {
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, '#!/bin/sh\n', 'utf8');
    await chmod(bundled, mode);
  };

  it('лежит в Resources/node/bin/node', () => {
    expect(bundled).toBe(path.join(resources, 'node', 'bin', 'node'));
  });

  it('собранное окно с файлом на месте — встроенный node, а не системный из PATH', async () => {
    await installBundled(0o755);

    expect(await resolveNodeBin(env, { packaged: true, resourcesPath: resources })).toBe(bundled);
  });

  it('встроенного нет (сборка без fetch-node) — как раньше, node из PATH', async () => {
    expect(await resolveNodeBin(env, { packaged: true, resourcesPath: resources })).toBe(systemNode);
  });

  it('встроенный не исполняемый — node из PATH, а не файл, который не запустится', async () => {
    await installBundled(0o644);

    expect(await resolveNodeBin(env, { packaged: true, resourcesPath: resources })).toBe(systemNode);
  });

  it('разработка (не собрано) — Resources не смотрим вовсе, только PATH', async () => {
    await installBundled(0o755);

    expect(await resolveNodeBin(env, { packaged: false, resourcesPath: resources })).toBe(systemNode);
    expect(await resolveNodeBin(env)).toBe(systemNode);
  });

  it('собрано, встроенного нет и PATH пуст — null: окно скажет, что node не найден', async () => {
    expect(await resolveNodeBin({ PATH: '' }, { packaged: true, resourcesPath: resources })).toBeNull();
  });
});

describe('хост собранного приложения в каталоге с пробелом', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hl-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Строка для оболочки: заглушка node — `sh`-скрипт, а пути в тесте с пробелами. */
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

  it('встроенный node и точка входа с пробелами запускаются без оболочки, аргументом идёт ровно entry', async () => {
    const resources = path.join(home, 'My Apps', 'Parley.app', 'Contents', 'Resources');
    const nodeBin = bundledNodeBin(resources);
    const entry = resolveHostEntry({ packaged: true, resourcesPath: resources });
    const started = path.join(home, 'started.txt');
    const argvDump = path.join(home, 'argv.json');
    // Встроенный node подменён скриптом: он помечает запуск и отдаёт управление настоящему node.
    await mkdir(path.dirname(nodeBin), { recursive: true });
    await writeFile(
      nodeBin,
      `#!/bin/sh\nprintf '%s' "$0" > ${quoted(started)}\nexec ${quoted(process.execPath)} "$@"\n`,
      'utf8',
    );
    await chmod(nodeBin, 0o755);
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(
      entry,
      `require('node:fs').writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(1)));\n`,
      'utf8',
    );

    const found = await resolveNodeBin({ PATH: '' }, { packaged: true, resourcesPath: resources });
    expect(found).toBe(nodeBin);
    spawnHost({
      env: process.env,
      entry,
      nodeBin: found ?? '',
      stderrFile: path.join(home, 'host', 'host.err'),
    });

    await expect
      .poll(async () => readFile(argvDump, 'utf8').catch(() => ''), { timeout: 4000 })
      .not.toBe('');
    expect(JSON.parse(await readFile(argvDump, 'utf8'))).toEqual([entry]);
    expect(await readFile(started, 'utf8')).toBe(nodeBin);
  });
});

describe('hostPaths', () => {
  it('кладёт файлы хоста в <home>/host', () => {
    const paths = hostPaths('/tmp/fake-home');

    expect(paths).toEqual({
      dir: path.join('/tmp/fake-home', 'host'),
      socket: path.join('/tmp/fake-home', 'host', 'host.sock'),
      token: path.join('/tmp/fake-home', 'host', 'host.token'),
      pid: path.join('/tmp/fake-home', 'host', 'host.pid'),
      log: path.join('/tmp/fake-home', 'host', 'host.log'),
    });
  });
});

/**
 * Кусок 1.13: в собранном `.app` пакета `@parley/host` нет вовсе (его тянет
 * `extraResources` в `Resources/host`, минуя node_modules приложения — иначе
 * пришлось бы тащить и node-pty, спека 3.2), поэтому `resolveHostEntry`
 * ветвится на `packaged`, а не всегда резолвит workspace-пакет.
 */
describe('resolveHostEntry', () => {
  it('в dev-режиме резолвит workspace-пакет @parley/host', () => {
    const entry = resolveHostEntry({ packaged: false, resourcesPath: '/unused' });

    expect(entry).toBe(require.resolve('@parley/host/main'));
  });

  it('в собранном приложении читает Resources/host/dist/main.js', () => {
    const entry = resolveHostEntry({ packaged: true, resourcesPath: '/Applications/Parley.app/Contents/Resources' });

    expect(entry).toBe(
      path.join('/Applications/Parley.app/Contents/Resources', 'host', 'dist', 'main.js'),
    );
  });
});

/**
 * `Resources/host` раскладывает `dist` через `pnpm deploy`: node-pty там — свежая копия из стора
 * pnpm, где у `prebuilds/<платформа>/spawn-helper` нет бита исполнения (так он лежит в тарболе
 * node-pty 1.1.0). Корневой postinstall чинил только копии дерева установки — и в собранном `.app`
 * любой `sessions.create` падал: posix_spawn хелпера → EACCES, node-pty → «posix_spawnp failed.».
 */
describe('dist: spawn-helper node-pty у хоста .app исполняемый', () => {
  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fixScript = path.resolve(desktopDir, '../../scripts/fix-node-pty-perms.mjs');
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hl-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('dist чинит права копии хоста — после pnpm deploy и до electron-builder', async () => {
    const pkg = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8')) as {
      scripts: { dist: string };
    };
    const steps = pkg.scripts.dist.split('&&').map((step) => step.trim());

    const deploy = steps.findIndex(
      (step) => step.includes('@parley/host deploy') && step.includes('out/host'),
    );
    const fix = steps.findIndex(
      (step) => step.includes('scripts/fix-node-pty-perms.mjs') && step.includes('out/host'),
    );
    const pack = steps.findIndex((step) => step.startsWith('electron-builder'));

    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(fix).toBeGreaterThan(deploy);
    expect(pack).toBeGreaterThan(fix);
  });

  it('скрипт с каталогом ставит +x spawn-helper у node-pty этого каталога (раскладка pnpm deploy)', async () => {
    const root = path.join(home, 'host');
    const store = path.join('.pnpm', 'node-pty@1.1.0', 'node_modules', 'node-pty');
    const nodePty = path.join(root, 'node_modules', store);
    const helpers = ['darwin-arm64', 'darwin-x64'].map((platform) =>
      path.join(nodePty, 'prebuilds', platform, 'spawn-helper'),
    );
    for (const helper of helpers) {
      await mkdir(path.dirname(helper), { recursive: true });
      await writeFile(helper, '');
      await chmod(helper, 0o644);
    }
    await symlink(store, path.join(root, 'node_modules', 'node-pty'));

    await run(process.execPath, [fixScript, root]);

    for (const helper of helpers) {
      expect((await stat(helper)).mode & 0o111).toBe(0o111);
    }
  });

  it('каталог без node-pty — скрипт падает, а не пропускает молча', async () => {
    await expect(run(process.execPath, [fixScript, home])).rejects.toMatchObject({ code: 1 });
  });
});

/**
 * Хост отсоединён от окна, и раньше его stderr уходил в никуда: упавший хост
 * не оставлял ни строчки — ни в `host.log` (падение мимо логгера), ни где-то
 * ещё. Теперь трассировка падения дописывается в файл рядом с логом.
 */
describe('spawnHost', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hl-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('дописывает stderr упавшего хоста в файл, создавая каталог хоста', async () => {
    const entry = path.join(home, 'crash.mjs');
    await writeFile(entry, "throw new Error('хост упал');\n");
    const stderrFile = path.join(home, 'host', 'host.err');

    spawnHost({ env: process.env, entry, nodeBin: process.execPath, stderrFile });

    await expect
      .poll(async () => readFile(stderrFile, 'utf8').catch(() => ''), { timeout: 4000 })
      .toContain('хост упал');
  });

  // Хост и агенты получают окружение login-оболочки (`captureShellEnv`) только так: окружением
  // запуска хоста. Хост берёт его же для поиска `claude`/`codex` и для окружения агентов, своих
  // правок у него нет — тест держит первое звено цепочки: до процесса доезжает всё окружение,
  // а не один PATH, в том числе значение с переводом строки и «=» внутри.
  it('хост получает окружение запуска как есть: PATH и прочие переменные оболочки доезжают до процесса', async () => {
    const dump = path.join(home, 'env.json');
    const entry = path.join(home, 'env.mjs');
    await writeFile(
      entry,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n`,
    );
    const stderrFile = path.join(home, 'host', 'host.err');
    const env = {
      PATH: '/opt/nvm/bin:/home/u/.local/bin:/usr/bin',
      MARK: 'да',
      HTTPS_PROXY: 'http://proxy.local:3128',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      MULTILINE: 'первая строка\nвторая=строка',
    };

    spawnHost({ env, entry, nodeBin: process.execPath, stderrFile });

    await expect
      .poll(async () => readFile(dump, 'utf8').catch(() => ''), { timeout: 4000 })
      .not.toBe('');
    // Не `toEqual`: система вправе добавить процессу свои переменные; важно, что все наши дошли.
    expect(JSON.parse(await readFile(dump, 'utf8'))).toMatchObject(env);
  });

  it('возвращает признак жизни процесса: жив до выхода, после выхода — нет (lane-r4, п. 2)', async () => {
    const entry = path.join(home, 'short.mjs');
    await writeFile(entry, 'setTimeout(() => {}, 300);\n');
    const stderrFile = path.join(home, 'host', 'host.err');

    const spawned = spawnHost({ env: process.env, entry, nodeBin: process.execPath, stderrFile });

    expect(spawned.isRunning()).toBe(true);
    await expect.poll(() => spawned.isRunning(), { timeout: 4000 }).toBe(false);
  });
});
