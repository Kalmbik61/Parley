import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userDataDir } from './user-data.js';

let appData = '';

beforeEach(async () => {
  appData = await mkdtemp(path.join(tmpdir(), 'parley-appdata-'));
});

afterEach(async () => {
  await rm(appData, { recursive: true, force: true });
});

const legacy = (): string => path.join(appData, '@harnas', 'desktop');
const current = (): string => path.join(appData, '@parley', 'desktop');

describe('userDataDir — закрепление userData окна (R7)', () => {
  it('прежний <appData>/@harnas/desktop есть — окно живёт в нём', async () => {
    await mkdir(legacy(), { recursive: true });

    expect(userDataDir(appData)).toBe(legacy());
  });

  it('его нет (новая установка) — <appData>/@parley/desktop; ничего не создаётся', async () => {
    expect(userDataDir(appData)).toBe(current());
    expect(await readdir(appData)).toEqual([]);
  });

  it('есть оба (после сборки без закрепления) — прежний: в нём данные человека', async () => {
    await mkdir(legacy(), { recursive: true });
    await mkdir(current(), { recursive: true });

    expect(userDataDir(appData)).toBe(legacy());
  });

  it('@harnas без desktop внутри или файл вместо каталога — не прежний userData', async () => {
    await mkdir(path.join(appData, '@harnas'));
    expect(userDataDir(appData)).toBe(current());

    await writeFile(path.join(appData, '@harnas', 'desktop'), 'файл\n');
    expect(userDataDir(appData)).toBe(current());
  });

  it('ссылка на каталог считается каталогом', async () => {
    const target = path.join(appData, 'elsewhere');
    await mkdir(target);
    await mkdir(path.join(appData, '@harnas'));
    await symlink(target, legacy());

    expect(userDataDir(appData)).toBe(legacy());
  });

  it('проверка подменяется: isDir получает путь прежнего каталога', () => {
    const asked: string[] = [];
    expect(userDataDir('/данные', (dir) => (asked.push(dir), false))).toBe(path.join('/данные', '@parley', 'desktop'));
    expect(asked).toEqual([path.join('/данные', '@harnas', 'desktop')]);
  });
});
