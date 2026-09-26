import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';

const require = createRequire(import.meta.url);

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
});
