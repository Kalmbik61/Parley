import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNodeBin } from './host-launcher.js';

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
