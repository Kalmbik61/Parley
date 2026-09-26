import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileQueue, writeAtomic } from './atomic-file.js';

describe('writeAtomic', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'atomic-file-'));
    file = path.join(dir, 'x.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('пишет файл, который читается как заданный текст', async () => {
    await writeAtomic(file, 'hello');
    await expect(readFile(file, 'utf8')).resolves.toBe('hello');
  });

  it('два параллельных writeAtomic в один файл не падают ENOENT (тест 9)', async () => {
    // Раньше `writeAtomic` писал во всегда один и тот же `${file}.tmp`: первый
    // `rename` уводил `.tmp` на место `file`, и второй `rename` над уже не
    // существующим `.tmp` падал ENOENT (раунд исправлений 1, находка C3).
    const results = await Promise.allSettled([writeAtomic(file, 'A'), writeAtomic(file, 'B')]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('fulfilled');

    const finalText = await readFile(file, 'utf8');
    expect(['A', 'B']).toContain(finalText);
  });
});

describe('createFileQueue', () => {
  it('вторая операция стартует после конца первой; ошибка первой не отменяет вторую', async () => {
    const enqueue = createFileQueue();
    const order: string[] = [];

    let rejectFirst!: (error: Error) => void;
    const first = enqueue(
      () =>
        new Promise<void>((_resolve, reject) => {
          order.push('first-start');
          rejectFirst = reject;
        }),
    );

    let secondStarted = false;
    const second = enqueue(async () => {
      secondStarted = true;
      order.push('second-start');
    });

    // Первая ещё не завершилась (ни успехом, ни ошибкой) — вторая не должна была стартовать.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    rejectFirst(new Error('первая упала'));
    await expect(first).rejects.toThrow('первая упала');
    await second;

    expect(order).toEqual(['first-start', 'second-start']);
  });

  it('очередь возвращает результат/ошибку каждой операции вызывающему', async () => {
    const enqueue = createFileQueue();
    await expect(enqueue(() => Promise.resolve(42))).resolves.toBe(42);
    await expect(enqueue(() => Promise.reject(new Error('oops')))).rejects.toThrow('oops');
    await expect(enqueue(() => Promise.resolve('after-error'))).resolves.toBe('after-error');
  });
});
