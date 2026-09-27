import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, LayoutTooLargeError, type LayoutsFileV2 } from './layout-store.js';

describe('createLayoutStore (формат v2, кусок 2.2)', () => {
  let home: string;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-layout-'));
    file = path.join(home, 'desktop', 'layouts.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('файл v1 (dockview) читается как пустой, save пишет v2 (тест 1)', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, layouts: { window: { grid: {} } } }), 'utf8');
    const store = createLayoutStore(file);

    await expect(store.load('window')).resolves.toBeNull();

    await store.save('w-01', { a: 1 });

    const raw = JSON.parse(await readFile(file, 'utf8')) as LayoutsFileV2;
    expect(raw.version).toBe(2);
    expect(raw.works).toEqual({ 'w-01': { a: 1 } });
  });

  it('v2 туда-обратно: save → load возвращает то же самое', async () => {
    const store = createLayoutStore(file);
    const layout = { root: { type: 'group', id: 'g-1' }, activeGroupId: 'g-1', closedTabs: [] };

    await store.save('w-01', layout);

    await expect(store.load('w-01')).resolves.toEqual(layout);
  });

  it('битый JSON → load даёт null, следующий save пишет валидный v2-файл', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ этот json нарочно битый', 'utf8');
    const store = createLayoutStore(file);

    await expect(store.load('w-01')).resolves.toBeNull();

    await store.save('w-01', { a: 1 });

    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
  });

  it('remove убирает только свой ключ (тест 1)', async () => {
    const store = createLayoutStore(file);
    await store.save('a', { va: 1 });
    await store.save('b', { vb: 2 });

    await store.remove('a');

    await expect(store.load('a')).resolves.toBeNull();
    await expect(store.load('b')).resolves.toEqual({ vb: 2 });
  });

  it('retain(["a"]) оставляет "a" и ключ "window", остальные стирает (тест 1)', async () => {
    const store = createLayoutStore(file);
    await store.save('a', { va: 1 });
    await store.save('b', { vb: 2 });
    await store.save('window', { grid: {} });

    await store.retain(['a']);

    await expect(store.load('a')).resolves.toEqual({ va: 1 });
    await expect(store.load('window')).resolves.toEqual({ grid: {} });
    await expect(store.load('b')).resolves.toBeNull();
  });

  it('раскладка не трогает чужие ключи файла', async () => {
    const store = createLayoutStore(file);
    await store.save('w-01', { a: 1 });
    await store.save('w-02', { b: 2 });

    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
    await expect(store.load('w-02')).resolves.toEqual({ b: 2 });
  });

  it('файл больше лимита → save отказывает, старая раскладка остаётся (тест 1)', async () => {
    const store = createLayoutStore(file);
    await store.save('w-01', { a: 1 });

    // Второй стор смотрит на тот же файл с тесным лимитом — первый `save`
    // (настройка) не должен упасть из-за него же.
    const limited = createLayoutStore(file, { maxBytes: 64 });
    await expect(limited.save('w-01', { text: 'x'.repeat(200) })).rejects.toBeInstanceOf(LayoutTooLargeError);

    await expect(store.load('w-01')).resolves.toEqual({ a: 1 });
  });

  it('запись атомарна: во время записи layouts.json всегда читается как валидный JSON (тест 1)', async () => {
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
    const duringWrite = JSON.parse(await readFile(file, 'utf8')) as LayoutsFileV2;
    expect(duringWrite.works['w-01']).toEqual({ a: 1 });

    releaseRename?.();
    await savePromise;

    const after = JSON.parse(await readFile(file, 'utf8')) as LayoutsFileV2;
    expect(after.works['w-01']).toEqual({ a: 2 });
  });

  it('два параллельных save разных работ без await между ними — обе раскладки на диске (тест 9)', async () => {
    const store = createLayoutStore(file);
    await store.save('seed', { s: 0 }); // файл уже существует — проверяем гонку чтения, а не создания

    const p1 = store.save('a', { va: 1 });
    const p2 = store.save('b', { vb: 2 });
    await Promise.all([p1, p2]);

    await expect(store.load('a')).resolves.toEqual({ va: 1 });
    await expect(store.load('b')).resolves.toEqual({ vb: 2 });
    await expect(store.load('seed')).resolves.toEqual({ s: 0 });
  });

  it('save одной работы параллельно с remove другой — тоже без потерь (тест 9)', async () => {
    const store = createLayoutStore(file);
    await store.save('a', { va: 1 });
    await store.save('b', { vb: 2 });

    const p1 = store.save('c', { vc: 3 });
    const p2 = store.remove('a');
    await Promise.all([p1, p2]);

    await expect(store.load('a')).resolves.toBeNull();
    await expect(store.load('b')).resolves.toEqual({ vb: 2 });
    await expect(store.load('c')).resolves.toEqual({ vc: 3 });
  });

  // Раунд исправлений 1, Important B: workKey "__proto__" на плоском объекте —
  // не обычное свойство, а унаследованный аксессор Object.prototype.__proto__.
  // `remove`/`retain`, построенные на `obj[key] = value` для СВЕЖЕГО объекта,
  // на этом ключе меняют сам [[Prototype]] результата вместо записи значения.
  it('workKey "__proto__" переживает remove другого ключа, не портит объект works', async () => {
    const store = createLayoutStore(file);
    await store.save('__proto__', { polluted: true });
    await store.save('other', { a: 1 });

    await store.remove('other');

    const raw = JSON.parse(await readFile(file, 'utf8')) as LayoutsFileV2;
    expect(Object.hasOwn(raw.works, '__proto__')).toBe(true);
    expect(Object.keys(raw.works)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype); // сам файл не тронут

    await expect(store.load('__proto__')).resolves.toEqual({ polluted: true });
  });

  it('retain(["__proto__"]) сохраняет запись как обычное свойство, не портит объект', async () => {
    const store = createLayoutStore(file);
    await store.save('__proto__', { polluted: true });
    await store.save('other', { a: 1 });

    await store.retain(['__proto__']);

    await expect(store.load('__proto__')).resolves.toEqual({ polluted: true });
    await expect(store.load('other')).resolves.toBeNull();
  });

  it('load("__proto__") без такой записи в файле отдаёт null, а не Object.prototype', async () => {
    const store = createLayoutStore(file);
    await store.save('other', { a: 1 });

    await expect(store.load('__proto__')).resolves.toBeNull();
  });
});
