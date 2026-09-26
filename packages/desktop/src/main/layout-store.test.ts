import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, LayoutTooLargeError } from './layout-store.js';

describe('createLayoutStore', () => {
  let home: string;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-layout-'));
    file = path.join(home, 'desktop', 'layouts.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('save → load возвращает то же самое (тест 1)', async () => {
    const store = createLayoutStore(file);
    const layout = { grid: { root: { type: 'leaf' } }, panels: { a: { id: 'a' } } };

    await store.save('w-01', layout);

    await expect(store.load('w-01')).resolves.toEqual(layout);
  });

  it('битый JSON → load даёт null, следующий save пишет валидный файл (тест 2)', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ этот json нарочно битый', 'utf8');
    const store = createLayoutStore(file);

    await expect(store.load('w-01')).resolves.toBeNull();

    await store.save('w-01', { a: 1 });

    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
  });

  it('раскладка не трогает чужие ключи файла', async () => {
    const store = createLayoutStore(file);
    await store.save('w-01', { a: 1 });
    await store.save('w-02', { b: 2 });

    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
    await expect(store.load('w-02')).resolves.toEqual({ b: 2 });
  });

  it('файл больше лимита → save отказывает, старая раскладка остаётся', async () => {
    const store = createLayoutStore(file);
    await store.save('w-01', { a: 1 });

    // Второй стор смотрит на тот же файл с тесным лимитом — первый `save`
    // (настройка) не должен упасть из-за него же.
    const limited = createLayoutStore(file, { maxBytes: 64 });
    await expect(limited.save('w-01', { text: 'x'.repeat(200) })).rejects.toBeInstanceOf(LayoutTooLargeError);

    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
  });

  it('запись атомарна: во время записи layouts.json всегда читается как валидный JSON (тест 5)', async () => {
    const store = createLayoutStore(file);
    await store.save('w-01', { a: 1 });

    // `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`
    // («Cannot redefine property») — стор поэтому берёт `rename` как
    // подставляемую зависимость (см. `CreateLayoutStoreOptions.rename`).
    let releaseRename: (() => void) | null = null;
    const delayedStore = createLayoutStore(file, {
      rename: (...args) =>
        new Promise<void>((resolve) => {
          releaseRename = () => {
            void rename(...args).then(resolve);
          };
        }),
    });

    const savePromise = delayedStore.save('w-01', { a: 2 });
    await vi.waitFor(() => {
      if (releaseRename === null) throw new Error('rename ещё не позвали');
    });

    // Пока `rename` не отпущен — на диске всё ещё старое, но обязательно
    // валидное содержимое: запись в само `layouts.json` не идёт, только в `.tmp`.
    const duringWrite = JSON.parse(await readFile(file, 'utf8')) as { layouts: Record<string, unknown> };
    expect(duringWrite.layouts['w-01']).toEqual({ a: 1 });

    releaseRename?.();
    await savePromise;

    const after = JSON.parse(await readFile(file, 'utf8')) as { layouts: Record<string, unknown> };
    expect(after.layouts['w-01']).toEqual({ a: 2 });
  });
});
