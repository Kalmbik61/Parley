import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeHome, tempHome } from '../test/helpers.js';
import { HostAlreadyRunning, startHost } from './host.js';
import { hostPaths } from './paths.js';

// Гонку трёх претендентов на один осколок (раунд fix-lane-post, п. 1) без подмены fs не поймать:
// окна между `await` внутри захвата замка — микросекунды. Отдельный файл — чтобы подмена
// `node:fs/promises` не касалась остальных тестов хоста; по умолчанию вызовы идут в настоящий fs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let homes: string[] = [];

afterEach(async () => {
  vi.mocked(fsp.link).mockImplementation(actualFs.link);
  vi.mocked(fsp.rename).mockImplementation(actualFs.rename);
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
});

describe('startHost: возврат унесённого замка соседа не удался', () => {
  it('старт отказывает HostAlreadyRunning, причина — в журнале хоста, замок соседа не стёрт (fix-lane-post, п. 1)', async () => {
    const home = await tempHome();
    homes.push(home);
    const paths = hostPaths(home);
    await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    // Осколок мёртвого хоста — его и собирается снять этот старт.
    await fsp.writeFile(paths.pid, '999999\n');

    const neighbourLock = `${process.ppid}\nB\n`;
    const thirdLock = `${process.ppid}\nC\n`;
    // Сосед B успел снять осколок и взять замок до нашего rename — уносим уже его живой замок.
    vi.mocked(fsp.rename).mockImplementationOnce(async (from, to) => {
      await actualFs.writeFile(from, neighbourLock);
      return actualFs.rename(from, to);
    });
    // Третий претендент C занял опустевший замок раньше, чем мы вернули замок B.
    vi.mocked(fsp.link).mockImplementation(async (from, to) => {
      if (String(from).includes('.stale.')) {
        await actualFs.writeFile(to, thirdLock);
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      return actualFs.link(from, to);
    });

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);

    expect(await fsp.readFile(paths.pid, 'utf8')).toBe(thirdLock);
    // Единственная копия замка B не удалена — по ней видно, чей замок потерян.
    const stale = `${paths.pid}.stale.${process.pid}`;
    expect(await fsp.readFile(stale, 'utf8')).toBe(neighbourLock);
    const log = await fsp.readFile(paths.log, 'utf8');
    expect(log).toContain('замок соседа не возвращён');
    expect(log).toContain('EEXIST');
    expect(log).toContain(stale);
    // Ничего своего старт не завёл.
    expect(existsSync(paths.token)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  });
});
