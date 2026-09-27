import { lstat, lutimes, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDrops, dropsDir, saveImage } from './drops.js';

let base: string;
let dir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hh-drops-'));
  dir = path.join(base, 'drops');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const NOW = new Date(2026, 8, 27, 14, 5, 9);

/** Случайные числа по очереди: имя файла тогда предсказуемо. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('dropsDir', () => {
  it('~/.harnas/desktop/drops от дома', () => {
    expect(dropsDir('/h')).toBe(path.join('/h', 'desktop', 'drops'));
  });
});

describe('saveImage (тест 1)', () => {
  it('PNG записан с правами 0600 и именем YYYYMMDD-HHMMSS-<4 hex>.png', async () => {
    const saved = await saveImage({ png: PNG, dir, now: NOW, random: sequence(0.5) });
    expect(saved).toBe(path.join(dir, '20260927-140509-8000.png'));
    if (saved === null) throw new Error('файл не сохранён');
    expect(await readFile(saved)).toEqual(PNG);
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
  });

  it('png: null → null и ни одного файла', async () => {
    expect(await saveImage({ png: null, dir, now: NOW })).toBeNull();
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('пустая картинка → null', async () => {
    expect(await saveImage({ png: Buffer.alloc(0), dir, now: NOW })).toBeNull();
  });

  it('имя занято симлинком на файл вне drops/ → другое имя, цель ссылки не тронута', async () => {
    await mkdir(dir, { recursive: true });
    const outside = path.join(base, 'outside.txt');
    await writeFile(outside, 'чужое');
    await symlink(outside, path.join(dir, '20260927-140509-0000.png'));
    await writeFile(path.join(dir, '20260927-140509-0001.png'), 'занято');

    const saved = await saveImage({ png: PNG, dir, now: NOW, random: sequence(0, 1 / 0x10000, 2 / 0x10000) });

    expect(saved).toBe(path.join(dir, '20260927-140509-0002.png'));
    expect(await readFile(outside, 'utf8')).toBe('чужое');
    expect(await readFile(path.join(dir, '20260927-140509-0001.png'), 'utf8')).toBe('занято');
    expect((await lstat(path.join(dir, '20260927-140509-0000.png'))).isSymbolicLink()).toBe(true);
  });
});

describe('cleanupDrops (тест 2)', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('старый файл и старая ссылка удалены, свежий файл и каталог на месте, цель ссылки цела', async () => {
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - WEEK - 60_000);
    const oldFile = path.join(dir, 'old.png');
    const freshFile = path.join(dir, 'fresh.png');
    const oldLink = path.join(dir, 'link.png');
    const oldDir = path.join(dir, 'sub');
    const target = path.join(base, 'target.txt');
    await writeFile(oldFile, 'x');
    await writeFile(freshFile, 'y');
    await writeFile(target, 'цель');
    await symlink(target, oldLink);
    await mkdir(oldDir);
    await utimes(oldFile, old, old);
    await utimes(oldDir, old, old);
    await lutimes(oldLink, old, old);
    // Цель ссылки старая: ссылку судим по её lstat, а не по цели.
    await utimes(target, old, old);

    expect(await cleanupDrops(dir, WEEK, now)).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['fresh.png', 'sub']);
    expect(await readFile(target, 'utf8')).toBe('цель');
  });

  it('свежая ссылка на старую цель остаётся', async () => {
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - WEEK - 60_000);
    const target = path.join(base, 'target.txt');
    await writeFile(target, 'цель');
    await utimes(target, old, old);
    await symlink(target, path.join(dir, 'link.png'));
    expect(await cleanupDrops(dir, WEEK, now)).toBe(0);
    expect(await readdir(dir)).toEqual(['link.png']);
  });

  it('каталога нет → 0', async () => {
    expect(await cleanupDrops(path.join(base, 'missing'), WEEK)).toBe(0);
  });
});
