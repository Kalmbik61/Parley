import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';

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
 * Кусок 1.13: в собранном `.app` пакета `@harnas/host` нет вовсе (его тянет
 * `extraResources` в `Resources/host`, минуя node_modules приложения — иначе
 * пришлось бы тащить и node-pty, спека 3.2), поэтому `resolveHostEntry`
 * ветвится на `packaged`, а не всегда резолвит workspace-пакет.
 */
describe('resolveHostEntry', () => {
  it('в dev-режиме резолвит workspace-пакет @harnas/host', () => {
    const entry = resolveHostEntry({ packaged: false, resourcesPath: '/unused' });

    expect(entry).toBe(require.resolve('@harnas/host/main'));
  });

  it('в собранном приложении читает Resources/host/dist/main.js', () => {
    const entry = resolveHostEntry({ packaged: true, resourcesPath: '/Applications/harnas.app/Contents/Resources' });

    expect(entry).toBe(
      path.join('/Applications/harnas.app/Contents/Resources', 'host', 'dist', 'main.js'),
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
      (step) => step.includes('@harnas/host deploy') && step.includes('out/host'),
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

  // Хост и агенты получают PATH login-оболочки (`captureShellEnv`) только так: окружением запуска
  // хоста. Хост берёт его же для поиска `claude`/`codex` и для окружения агентов, своих правок PATH
  // у него нет — тест держит первое звено цепочки.
  it('хост получает окружение запуска как есть: PATH и прочие переменные доезжают до процесса', async () => {
    const dump = path.join(home, 'env.json');
    const entry = path.join(home, 'env.mjs');
    await writeFile(
      entry,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ PATH: process.env.PATH, MARK: process.env.MARK }));\n`,
    );
    const stderrFile = path.join(home, 'host', 'host.err');

    spawnHost({
      env: { PATH: '/opt/nvm/bin:/home/u/.local/bin:/usr/bin', MARK: 'да' },
      entry,
      nodeBin: process.execPath,
      stderrFile,
    });

    await expect
      .poll(async () => readFile(dump, 'utf8').catch(() => ''), { timeout: 4000 })
      .not.toBe('');
    expect(JSON.parse(await readFile(dump, 'utf8'))).toEqual({
      PATH: '/opt/nvm/bin:/home/u/.local/bin:/usr/bin',
      MARK: 'да',
    });
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
