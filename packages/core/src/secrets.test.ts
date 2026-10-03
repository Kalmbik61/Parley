/** Только вымышленные ключи и временный дом Parley. */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SecretFormatError,
  clearSecret,
  normalizeSecret,
  readSecret,
  secretHint,
  writeSecret,
} from './index.js';

let root = '';
let home = '';
const file = (): string => path.join(home, 'secrets.json');

const write = async (value: unknown): Promise<void> => {
  await mkdir(home, { recursive: true });
  await writeFile(file(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-secrets-'));
  home = path.join(root, 'home');
  vi.stubEnv('PARLEY_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('normalizeSecret', () => {
  it('обрезает пробелы по краям ключа', () => {
    expect(normalizeSecret(' \tвыдуманный-key\n ')).toBe('выдуманный-key');
  });

  it('принимает ключ на границе длины', () => {
    expect(normalizeSecret('a'.repeat(512))).toBe('a'.repeat(512));
  });

  it.each([
    '',
    ' \t\n ',
    'a'.repeat(513),
    'fake key',
    'fake\tkey',
    'fake\nkey',
    'fake\0key',
    'fake\u007fkey',
    'fake\u0085key',
    'fake\u00a0key',
  ])('отклоняет неверный формат, вариант %#, не раскрывая ключ', (key) => {
    let error: unknown;
    try {
      normalizeSecret(key);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretFormatError);
    expect((error as Error).name).toBe('SecretFormatError');
    if (key.trim()) expect((error as Error).message).not.toContain(key);
  });
});

describe('secretHint', () => {
  it('показывает только маску и четыре последних знака', () => {
    expect(secretHint('fictional-secret-a1b2')).toBe('••••a1b2');
    expect(secretHint('abcde')).toBe('••••bcde');
  });

  it.each(['a', 'ab', 'abc', 'abcd'])('не раскрывает короткий ключ длины 1–4, вариант %#', (key) => {
    expect(normalizeSecret(key)).toBe(key);
    expect(secretHint(key)).toBe('••••');
  });
});

describe('readSecret', () => {
  it('отсутствующий файл не даёт ключа и не создаёт дом', async () => {
    expect(await readSecret('zai')).toBeNull();
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('читает нормализованный ключ', async () => {
    await write({ zai: { key: ' \tfake-key\n' } });
    expect(await readSecret('zai')).toBe('fake-key');
  });

  it.each([
    '{ не json',
    null,
    [],
    { zai: 'fake' },
    { zai: { key: 42 } },
    { zai: { key: 'fake key' } },
  ])('повреждённый файл не даёт пригодного ключа, вариант %#', async (data) => {
    await write(data);
    expect(await readSecret('zai')).toBeNull();
  });
});

describe('writeSecret', () => {
  it('создаёт файл в PARLEY_HOME с правами 0600 и возвращает подсказку', async () => {
    expect(await writeSecret('zai', ' \tfake-secret-a1b2\n')).toBe('••••a1b2');
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      zai: { key: 'fake-secret-a1b2' },
    });
    expect(await readSecret('zai')).toBe('fake-secret-a1b2');
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['secrets.json']);
  });

  it('заменяет старый файл с 0644 на 0600, не меняя права каталога', async () => {
    await write({ zai: { key: 'fake-old-key' } });
    await chmod(file(), 0o644);
    await chmod(home, 0o755);
    const oldInode = (await stat(file())).ino;
    expect(await writeSecret('zai', 'fake-new-key')).toBe('••••-key');
    expect((await stat(file())).ino).not.toBe(oldInode);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o755);
    expect(await readSecret('zai')).toBe('fake-new-key');
    expect(await readdir(home)).toEqual(['secrets.json']);
  });

  it('сохраняет посторонние поля при замене ключа', async () => {
    await write({ zai: { key: 'fake-old', note: 'моё' }, other: { value: 42 } });
    expect(await writeSecret('zai', 'fake-new')).toBe('••••-new');
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      zai: { key: 'fake-new', note: 'моё' },
      other: { value: 42 },
    });
  });

  it('восстанавливает повреждённый JSON', async () => {
    await write('{ не json');
    expect(await writeSecret('zai', 'fake-key')).toBe('••••-key');
    expect(await readSecret('zai')).toBe('fake-key');
  });

  it('не меняет файл при ошибке формата', async () => {
    await write({ zai: { key: 'fake-old' }, other: true });
    const before = await readFile(file(), 'utf8');
    await expect(writeSecret('zai', 'fake invalid')).rejects.toMatchObject({
      name: 'SecretFormatError',
    });
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(await readdir(home)).toEqual(['secrets.json']);
  });
});

describe('clearSecret', () => {
  it('убирает только Z.ai и сохраняет чужие поля в файле с 0600', async () => {
    await write({ zai: { key: 'fake-key' }, other: { value: 42 } });
    await clearSecret('zai');
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ other: { value: 42 } });
    expect(await readSecret('zai')).toBeNull();
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['secrets.json']);
  });

  it.each([{ zai: { key: 'fake-key' } }, {}, '{ не json'])(
    'удаляет файл, когда после очистки нет полей, вариант %#',
    async (data) => {
      await write(data);
      await clearSecret('zai');
      await expect(stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(home)).toEqual([]);
    },
  );

  it('не переписывает файл без Z.ai, если там есть чужие поля', async () => {
    await write({ other: true });
    const before = await readFile(file(), 'utf8');
    const oldInode = (await stat(file())).ino;
    await clearSecret('zai');
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect((await stat(file())).ino).toBe(oldInode);
  });

  it('отсутствующий файл не создаёт дом и повторное удаление безопасно', async () => {
    await clearSecret('zai');
    await clearSecret('zai');
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
