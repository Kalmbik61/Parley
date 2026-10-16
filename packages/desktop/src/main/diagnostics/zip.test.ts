import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeZip } from './zip.js';

const hasUnzip = existsSync('/usr/bin/unzip');

/** Запускает `unzip` с большим буфером вывода: файл на 3 МиБ целиком идёт в stdout. */
function unzip(args: string[]) {
  return spawnSync('unzip', args, { maxBuffer: 32 * 1024 * 1024 });
}

describe('writeZip', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'zip-writer-'));
    target = path.join(dir, 'out.zip');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasUnzip)('архив из строки, Buffer и файла 3 МиБ проходит unzip -t, данные совпадают', async () => {
    const big = randomBytes(3 * 1024 * 1024);
    const bigFile = path.join(dir, 'big.bin');
    await writeFile(bigFile, big);
    const binary = Buffer.from([0, 1, 2, 253, 254, 255]);

    const result = await writeZip(target, [
      { name: 'README.txt', source: 'Parley diagnostics\n' },
      { name: 'raw.bin', source: binary },
      { name: 'logs/big.bin', source: { file: bigFile } },
    ]);

    expect(result.skipped).toEqual([]);
    const test = unzip(['-t', target]);
    expect(test.stdout.toString()).toContain('No errors detected');
    expect(test.status).toBe(0);
    expect(Buffer.compare(unzip(['-p', target, 'logs/big.bin']).stdout, big)).toBe(0);
    expect(Buffer.compare(unzip(['-p', target, 'raw.bin']).stdout, binary)).toBe(0);
    // Временный файл после rename не остаётся.
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it.skipIf(!hasUnzip)('unzip -p возвращает исходный текст README.txt, в том числе не-ASCII', async () => {
    const text = 'Parley diagnostics\nПроекты: ~/work\n';
    await writeZip(target, [{ name: 'README.txt', source: text }]);

    expect(unzip(['-p', target, 'README.txt']).stdout.toString('utf8')).toBe(text);
  });

  it.skipIf(!hasUnzip)('отсутствующий файл попадает в skipped, остальное пишется, архив цел', async () => {
    const present = path.join(dir, 'host.log');
    await writeFile(present, 'line 1\nline 2\n');

    const result = await writeZip(target, [
      { name: 'README.txt', source: 'hello' },
      { name: 'host.log.1', source: { file: path.join(dir, 'нет-такого-файла.log') } },
      { name: 'host.log', source: { file: present } },
    ]);

    expect(result.skipped).toEqual(['host.log.1']);
    expect(unzip(['-t', target]).stdout.toString()).toContain('No errors detected');
    expect(unzip(['-Z1', target]).stdout.toString().trim().split('\n')).toEqual(['README.txt', 'host.log']);
    expect(unzip(['-p', target, 'host.log']).stdout.toString()).toBe('line 1\nline 2\n');
  });

  it('пустой список даёт корректный пустой архив: только EOCD на 22 байта', async () => {
    const result = await writeZip(target, []);

    expect(result.skipped).toEqual([]);
    expect((await stat(target)).size).toBe(22);
    const bytes = await readFile(target);
    // Сигнатура EOCD 0x06054b50 в little-endian.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('пустой файл и пустая строка не ломают архив: сигнатуры и размеры на месте', async () => {
    const empty = path.join(dir, 'empty.log');
    await writeFile(empty, '');

    await writeZip(target, [
      { name: 'empty-string.txt', source: '' },
      { name: 'empty-file.log', source: { file: empty } },
    ]);

    const bytes = await readFile(target);
    // Локальный заголовок первой записи и EOCD с двумя записями.
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = bytes.subarray(bytes.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(10)).toBe(2);
    if (hasUnzip) expect(unzip(['-t', target]).stdout.toString()).toContain('No errors detected');
  });

  it.skipIf(!hasUnzip)('DOS-дата и время берутся из переданного now (локальные, шаг 2 с)', async () => {
    await writeZip(target, [{ name: 'a.txt', source: 'a' }], new Date(2026, 9, 16, 10, 30, 5));

    // `unzip -Z -T` печатает метку времени записи как ГГГГММДД.ЧЧММСС.
    const listing = unzip(['-Z', '-T', target]).stdout.toString();
    expect(listing).toMatch(/20261016\.103004 a\.txt/);
  });

  it('сбой записи: несуществующий каталог target — writeZip отклоняется, .tmp не остаётся, процесс не падает', async () => {
    const missing = path.join(dir, 'нет-каталога', 'out.zip');
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);
    try {
      await expect(writeZip(missing, [{ name: 'a.txt', source: 'a' }])).rejects.toThrow();
      // Даём событию 'error' потока записи дойти до обработчиков: без слушателя оно стало бы uncaughtException.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', uncaught);
    }

    expect(uncaught).not.toHaveBeenCalled();
    expect(existsSync(`${missing}.tmp`)).toBe(false);
  });

  it('нечитаемый файл-источник (каталог вместо файла, EISDIR) отклоняет writeZip, а не попадает в skipped', async () => {
    const asDirectory = path.join(dir, 'host.log');
    await mkdir(asDirectory);

    await expect(writeZip(target, [{ name: 'host.log', source: { file: asDirectory } }])).rejects.toThrow(/EISDIR/);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});
