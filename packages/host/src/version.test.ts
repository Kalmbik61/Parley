import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHostVersion } from './version.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hv-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readHostVersion', () => {
  it('по умолчанию — version из package.json самого хоста', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    expect(readHostVersion()).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('читает version из заданного package.json', async () => {
    const file = path.join(dir, 'package.json');
    await writeFile(file, JSON.stringify({ name: 'x', version: '3.4.5' }));

    expect(readHostVersion(pathToFileURL(file))).toBe('3.4.5');
  });

  it('нет файла, битый JSON, нет поля или поле не строка — unknown, без исключения', async () => {
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{нет');
    const noVersion = path.join(dir, 'no-version.json');
    await writeFile(noVersion, JSON.stringify({ name: 'x' }));
    const notString = path.join(dir, 'not-string.json');
    await writeFile(notString, JSON.stringify({ version: 1 }));
    const empty = path.join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({ version: '' }));

    expect(readHostVersion(pathToFileURL(path.join(dir, 'нет-такого.json')))).toBe('unknown');
    expect(readHostVersion(pathToFileURL(broken))).toBe('unknown');
    expect(readHostVersion(pathToFileURL(noVersion))).toBe('unknown');
    expect(readHostVersion(pathToFileURL(notString))).toBe('unknown');
    expect(readHostVersion(pathToFileURL(empty))).toBe('unknown');
  });
});
