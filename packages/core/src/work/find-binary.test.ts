import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinaryNotFoundError, expectedRunnerBinary, findBinary, findRunnerBinary, resolveRunnerBinary } from './find-binary.js';

describe('findBinary: бинаря нет', () => {
  const text = (binary: string): string =>
    `Binary "${binary}" was not found in PATH.\n` +
    `Parley runs only the official, unmodified ${binary} — ` +
    'install it and make sure it is available in PATH.';

  it('имени нет в PATH — BinaryNotFoundError, текст по-английски', async () => {
    const failure = await findBinary('parley-no-such-binary', { PATH: '' }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BinaryNotFoundError);
    expect((failure as BinaryNotFoundError).binary).toBe('parley-no-such-binary');
    expect((failure as BinaryNotFoundError).message).toBe(text('parley-no-such-binary'));
  });

  it('явного пути нет на диске — тот же отказ', async () => {
    const missing = '/parley-no-such-dir/claude';
    const failure = await findBinary(missing).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BinaryNotFoundError);
    expect((failure as BinaryNotFoundError).message).toBe(text(missing));
  });
});

describe('resolveRunnerBinary: точный ожидаемый бинарь (спека 2026-11-11, §4.2 п. 6)', () => {
  const make = async (): Promise<{ home: string; bin: string; cleanup: () => Promise<void> }> => {
    const home = await mkdtemp(path.join(tmpdir(), 'parley-expected-'));
    const bin = path.join(home, '.local/bin');
    await mkdir(bin, { recursive: true });
    return { home, bin, cleanup: () => rm(home, { recursive: true, force: true }) };
  };
  const exe = (file: string): Promise<void> => writeFile(file, '#!/bin/sh\n', { mode: 0o755 });

  it('нет в PATH, есть ~/.local/bin/qwen — найден с источником expected; PATH не меняется', async () => {
    const { home, bin, cleanup } = await make();
    try {
      await exe(path.join(bin, 'qwen'));
      const env = { HOME: home, PATH: '/usr/bin:/bin' };
      expect(await resolveRunnerBinary('qwen', env)).toEqual({ path: path.join(bin, 'qwen'), source: 'expected' });
      expect(await findRunnerBinary('qwen', env)).toBe(path.join(bin, 'qwen'));
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(expectedRunnerBinary('qwen', env)).toBe(path.join(bin, 'qwen'));
    } finally {
      await cleanup();
    }
  });

  it('чужие исполняемые файлы в той же папке на поиск не влияют; команда не из таблицы туда не смотрит', async () => {
    const { home, bin, cleanup } = await make();
    try {
      await exe(path.join(bin, 'git'));
      await exe(path.join(bin, 'node'));
      const env = { HOME: home, PATH: '' };
      await expect(findRunnerBinary('git', env)).rejects.toBeInstanceOf(BinaryNotFoundError);
      await expect(findRunnerBinary('node', env)).rejects.toBeInstanceOf(BinaryNotFoundError);
      await expect(findRunnerBinary('qwen', env)).rejects.toBeInstanceOf(BinaryNotFoundError);
      expect(expectedRunnerBinary('git', env)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('PATH важнее ожидаемого пути, подмена PARLEY_<CMD>_BIN важнее обоих и без запасного пути', async () => {
    const { home, bin, cleanup } = await make();
    try {
      await exe(path.join(bin, 'qwen'));
      const other = path.join(home, 'other');
      await mkdir(other);
      await exe(path.join(other, 'qwen'));
      expect(await resolveRunnerBinary('qwen', { HOME: home, PATH: other })).toEqual({ path: path.join(other, 'qwen'), source: 'path' });
      expect(await resolveRunnerBinary('qwen', { HOME: home, PATH: '', PARLEY_QWEN_BIN: path.join(other, 'qwen') })).toEqual({
        path: path.join(other, 'qwen'),
        source: 'override',
      });
      await expect(resolveRunnerBinary('qwen', { HOME: home, PATH: '', PARLEY_QWEN_BIN: path.join(home, 'missing') })).rejects.toBeInstanceOf(BinaryNotFoundError);
    } finally {
      await cleanup();
    }
  });

  it('без HOME запасного пути нет', async () => {
    expect(expectedRunnerBinary('claude', { PATH: '' })).toBeNull();
    await expect(findRunnerBinary('qwen', { PATH: '' })).rejects.toBeInstanceOf(BinaryNotFoundError);
  });
});


describe('Kimi standalone discovery', () => {
  it('uses the official binary under a desktop PATH, with PATH and explicit overrides taking precedence', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-discovery-'));
    try {
      const bin = path.join(home, '.kimi-code/bin');
      const other = path.join(home, 'other');
      await mkdir(bin, { recursive: true });
      await mkdir(other);
      const expected = path.join(bin, 'kimi');
      const alternative = path.join(other, 'kimi');
      await writeFile(expected, '#!/bin/sh\n', { mode: 0o755 });
      await writeFile(alternative, '#!/bin/sh\n', { mode: 0o755 });
      const env = { HOME: home, PATH: '/usr/bin:/bin' };
      expect(expectedRunnerBinary('kimi', env)).toBe(expected);
      expect(await resolveRunnerBinary('kimi', env)).toEqual({ path: expected, source: 'expected' });
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(await resolveRunnerBinary('kimi', { ...env, PATH: other })).toEqual({ path: alternative, source: 'path' });
      expect(await resolveRunnerBinary('kimi', { ...env, PATH: other, PARLEY_KIMI_BIN: expected })).toEqual({ path: expected, source: 'override' });
      expect(await resolveRunnerBinary('kimi', { ...env, HARNAS_KIMI_BIN: alternative })).toEqual({ path: alternative, source: 'override' });
      for (const override of ['', path.join(home, 'missing')]) {
        await expect(resolveRunnerBinary('kimi', { ...env, PARLEY_KIMI_BIN: override })).rejects.toBeInstanceOf(BinaryNotFoundError);
      }
      await chmod(expected, 0o644);
      await expect(resolveRunnerBinary('kimi', env)).rejects.toBeInstanceOf(BinaryNotFoundError);
      for (const invalidHome of ['', 'relative']) expect(expectedRunnerBinary('kimi', { HOME: invalidHome })).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
