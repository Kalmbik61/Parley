/**
 * Скрипт `scripts/prune-escaping-symlinks.mjs`: после `pnpm deploy` в `out/host` лежит ссылка на сам пакет
 * хоста, которая в собранном `.app` указывает в пустоту, а подпись ad-hoc на такой ссылке падает с ENOENT.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneEscapingSymlinks } from '../scripts/prune-escaping-symlinks.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pruneEscapingSymlinks', () => {
  let work: string;
  let host: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'ps-'));
    host = path.join(work, 'out', 'host');
    await mkdir(path.join(host, 'node_modules', '.pnpm', 'core@1', 'node_modules', 'core'), { recursive: true });
    await writeFile(path.join(host, 'node_modules', '.pnpm', 'core@1', 'node_modules', 'core', 'index.js'), '');
    await mkdir(path.join(work, 'packages', 'host'), { recursive: true });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('убирает ссылку, ведущую из каталога наверх (как @parley/host после pnpm deploy), и оборванную', async () => {
    const hoisted = path.join(host, 'node_modules', '.pnpm', 'node_modules', '@parley');
    await mkdir(hoisted, { recursive: true });
    // Относительная ссылка на `packages/host` рядом с `out/`: из `out/host` она есть, из `.app` — нет.
    await symlink('../../../../../../packages/host', path.join(hoisted, 'host'));
    await symlink('нет-такого-файла', path.join(host, 'dangling'));

    const removed = await pruneEscapingSymlinks(host);

    expect(removed.map((item) => item.link).sort()).toEqual(
      ['dangling', path.join('node_modules', '.pnpm', 'node_modules', '@parley', 'host')].sort(),
    );
    expect(existsSync(path.join(hoisted, 'host'))).toBe(false);
    expect(existsSync(path.join(host, 'dangling'))).toBe(false);
    // Каталог, куда она вела, не тронут: удаляется только сама ссылка.
    expect(existsSync(path.join(work, 'packages', 'host'))).toBe(true);
  });

  it('ссылки внутри каталога остаются — на них держится node_modules pnpm', async () => {
    const inner = path.join(host, 'node_modules', 'core');
    await symlink('.pnpm/core@1/node_modules/core', inner);
    const absolute = path.join(host, 'node_modules', 'core-abs');
    await symlink(path.join(host, 'node_modules', '.pnpm', 'core@1', 'node_modules', 'core'), absolute);

    expect(await pruneEscapingSymlinks(host)).toEqual([]);
    expect(await readlink(inner)).toBe('.pnpm/core@1/node_modules/core');
    expect(existsSync(path.join(inner, 'index.js'))).toBe(true);
    expect(existsSync(path.join(absolute, 'index.js'))).toBe(true);
  });

  it('каталог, на который показывает корневой симлинк, обходится как есть (корень — настоящий путь)', async () => {
    const alias = path.join(work, 'alias');
    await symlink(host, alias);
    await symlink('../../packages/host', path.join(host, 'up'));

    const removed = await pruneEscapingSymlinks(alias);

    expect(removed.map((item) => item.link)).toEqual(['up']);
  });
});

describe('dist: порядок шагов', () => {
  it('ссылки за пределами out/host убираются после pnpm deploy и до electron-builder', () => {
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      scripts: { dist: string };
    };
    const steps = pkg.scripts.dist.split('&&').map((step) => step.trim());

    const deploy = steps.findIndex((step) => step.includes('@parley/host deploy') && step.includes('out/host'));
    const prune = steps.findIndex(
      (step) => step.includes('scripts/prune-escaping-symlinks.mjs') && step.includes('out/host'),
    );
    const pack = steps.findIndex((step) => step.startsWith('electron-builder'));

    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(deploy);
    expect(pack).toBeGreaterThan(prune);
  });
});
