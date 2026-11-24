import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Сквозные обёртки со счётчиком: сколько раз журнал хоста спрашивал у диска размер и ротировал. */
const calls = vi.hoisted(() => ({ statSync: 0, existsSync: 0, renameSync: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      calls.statSync += 1;
      return actual.statSync(...args);
    }) as typeof actual.statSync,
    existsSync: ((...args: Parameters<typeof actual.existsSync>) => {
      calls.existsSync += 1;
      return actual.existsSync(...args);
    }) as typeof actual.existsSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      calls.renameSync += 1;
      return actual.renameSync(...args);
    }) as typeof actual.renameSync,
  };
  return { ...wrapped, default: wrapped };
});

const { createLog } = await import('./log.js');

let dir = '';
let file = '';

beforeEach(async () => {
  calls.statSync = 0;
  calls.existsSync = 0;
  calls.renameSync = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'parley-log-rotation-'));
  file = path.join(dir, 'host.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createLog — размер файла в памяти', () => {
  it('500 строк ниже порога: statSync не больше одного, existsSync ни разу', () => {
    const log = createLog(file);
    for (let i = 0; i < 500; i += 1) log.info('строка', { i });

    expect(calls.statSync).toBeLessThanOrEqual(1);
    expect(calls.existsSync).toBe(0);
    expect(calls.renameSync).toBe(0);
  });

  it('ротация на пороге: .1 есть, основной файл меньше порога плюс строка, stat не чаще одного на ротацию и первого', async () => {
    const maxBytes = 2000;
    const log = createLog(file, { maxBytes });
    for (let i = 0; i < 100; i += 1) log.info('строка-заполнитель', { i, filler: 'x'.repeat(20) });

    await expect(stat(`${file}.1`)).resolves.toBeDefined();
    const lastLine = (await readFile(file, 'utf8')).trim().split('\n').pop() ?? '';
    expect((await stat(file)).size).toBeLessThan(maxBytes + Buffer.byteLength(lastLine) + 1);
    expect(calls.renameSync).toBeGreaterThan(0);
    expect(calls.statSync).toBeLessThanOrEqual(2 * calls.renameSync + 1);
  });

  it('существующий файл учитывается с первой записи: порог считается от его размера', async () => {
    await writeFile(file, 'x'.repeat(1990));
    const log = createLog(file, { maxBytes: 2000 });
    log.info('строка');
    log.info('строка');

    expect(calls.renameSync).toBe(1);
    expect((await readFile(`${file}.1`, 'utf8')).startsWith('xxxx')).toBe(true);
  });

  it('файл повернул другой процесс: лишней ротации нет, чужой .1 цел', async () => {
    const log = createLog(file);
    log.info('строка', { n: 1 });
    const lineBytes = (await stat(file)).size;

    const small = createLog(file, { maxBytes: 20 * lineBytes });
    // Свой счёт доходит до порога, а на диске после чужой ротации файл мал.
    for (let i = 0; i < 14; i += 1) small.info('строка', { n: 1 });
    await rename(file, `${file}.1`);
    await writeFile(`${file}.1`, 'чужое содержимое');
    for (let i = 0; i < 10; i += 1) small.info('строка', { n: 1 });

    expect(calls.renameSync).toBe(0);
    expect(await readFile(`${file}.1`, 'utf8')).toBe('чужое содержимое');
    expect((await stat(file)).size).toBe(10 * lineBytes);
  });
});
