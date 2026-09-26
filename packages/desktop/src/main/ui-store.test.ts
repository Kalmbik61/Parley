import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI } from '../shared/ui-types.js';
import { createUiStore } from './ui-store.js';

describe('createUiStore', () => {
  let home: string;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-ui-'));
    file = path.join(home, 'desktop', 'ui.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('файла нет → load отдаёт DEFAULT_UI (тест 1)', async () => {
    const store = createUiStore(file);
    await expect(store.load()).resolves.toEqual(DEFAULT_UI);
  });

  it('save({ appearance: "dark" }) → load отдаёт dark при остальных значениях по умолчанию (тест 2)', async () => {
    const store = createUiStore(file);
    await store.save({ appearance: 'dark' });

    await expect(store.load()).resolves.toEqual({ ...DEFAULT_UI, appearance: 'dark' });
  });

  it('битый JSON → DEFAULT_UI, следующий save пишет валидный файл (тест 2)', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ этот json нарочно битый', 'utf8');
    const store = createUiStore(file);

    await expect(store.load()).resolves.toEqual(DEFAULT_UI);

    await store.save({ appearance: 'light' });

    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(store.load()).resolves.toEqual({ ...DEFAULT_UI, appearance: 'light' });
  });

  it('save сливает вложенный объект целиком, а не по полям (план, «ui.json»)', async () => {
    const store = createUiStore(file);
    await store.save({
      notifications: { needsYou: false, finished: false, mail: false, sound: false },
    });

    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_UI,
      notifications: { needsYou: false, finished: false, mail: false, sound: false },
    });
  });

  it('запись атомарна: во время записи ui.json всегда читается как валидный JSON (тест 3, как тест 5 куска 2.2 прошлого плана)', async () => {
    const store = createUiStore(file);
    await store.save({ appearance: 'dark' });

    // `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`
    // («Cannot redefine property») — стор поэтому берёт `rename` как
    // подставляемую зависимость, как и `layout-store.ts`.
    let releaseRename: (() => void) | null = null;
    const delayedStore = createUiStore(file, {
      rename: (...args) =>
        new Promise<void>((resolve) => {
          releaseRename = () => {
            void rename(...args).then(resolve);
          };
        }),
    });

    const savePromise = delayedStore.save({ appearance: 'light' });
    await vi.waitFor(() => {
      if (releaseRename === null) throw new Error('rename ещё не позвали');
    });

    // Пока `rename` не отпущен — на диске всё ещё старое, но обязательно
    // валидное содержимое: запись идёт только в `.tmp`.
    const duringWrite = JSON.parse(await readFile(file, 'utf8')) as { appearance: string };
    expect(duringWrite.appearance).toBe('dark');

    releaseRename?.();
    await savePromise;

    const after = JSON.parse(await readFile(file, 'utf8')) as { appearance: string };
    expect(after.appearance).toBe('light');
  });
});
