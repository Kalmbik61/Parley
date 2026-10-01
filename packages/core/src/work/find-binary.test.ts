import { describe, expect, it } from 'vitest';
import { BinaryNotFoundError, findBinary } from './find-binary.js';

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
