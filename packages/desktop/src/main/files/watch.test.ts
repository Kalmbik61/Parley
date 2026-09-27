import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChangedEvent, FileRoot, TreeChangedEvent } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { HostError } from '../host-connection.js';
import { createFileWatch, type FileWatch, type WatchSink } from './watch.js';

const ROOT: FileRoot = { workKey: '/p w-1', spec: { kind: 'project' } };

let dir = '';
let watch: FileWatch;

function sink(): WatchSink & { changed: ReturnType<typeof vi.fn>; treeChanged: ReturnType<typeof vi.fn> } {
  return { changed: vi.fn<(e: FileChangedEvent) => void>(), treeChanged: vi.fn<(e: TreeChangedEvent) => void>() };
}

function roots(base: string) {
  return {
    rootPath: () => base,
    resolve: async (_root: FileRoot, rel: string) => realpath(path.join(base, rel)),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-watch-')));
});

afterEach(async () => {
  watch?.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe('watch файла (тест 10)', () => {
  it('запись → changed; замена через rename → changed; удаление → deleted', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, '1');
    watch = createFileWatch({ roots: roots(dir) });
    const s = sink();
    const id = await watch.watch(ROOT, 'a.txt', s);
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(128);

    await sleep(50);
    await writeFile(file, '22');
    await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(s.changed.mock.calls[0]?.[0]).toMatchObject({ id, path: 'a.txt', deleted: false });
    expect(typeof s.changed.mock.calls[0]?.[0].mtimeMs).toBe('number');

    await sleep(150);
    await writeFile(path.join(dir, '.a.txt.tmp'), '333');
    await rename(path.join(dir, '.a.txt.tmp'), file);
    await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(s.changed.mock.calls[1]?.[0]).toMatchObject({ id, path: 'a.txt', deleted: false });

    await sleep(150);
    await unlink(file);
    await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(s.changed.mock.calls[2]?.[0]).toEqual({ id, path: 'a.txt', mtimeMs: null, deleted: true });
  });

  it('частые записи — дроссель: событий меньше записей', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, '0');
    watch = createFileWatch({ roots: roots(dir) });
    const s = sink();
    await watch.watch(ROOT, 'a.txt', s);
    await sleep(50);
    for (let i = 1; i <= 10; i++) await writeFile(file, String(i).repeat(i));
    await sleep(600);
    expect(s.changed.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(s.changed.mock.calls.length).toBeLessThan(10);
  });

  it('unwatch — событий больше нет', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, '0');
    watch = createFileWatch({ roots: roots(dir) });
    const s = sink();
    const id = await watch.watch(ROOT, 'a.txt', s);
    watch.unwatch(id);
    await writeFile(file, '11');
    await sleep(500);
    expect(s.changed).not.toHaveBeenCalled();
  });
});

describe('watch дерева (тест 10)', () => {
  it('новый файл → treeChanged с папкой; запись в .harnas/works/w/log и node_modules — нет', async () => {
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, '.harnas', 'works', 'w'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules'));
    const invalidated: string[] = [];
    watch = createFileWatch({ roots: roots(dir), onTreeInvalidate: (key) => invalidated.push(key) });
    const s = sink();
    await watch.watch(ROOT, '', s);
    expect(watch.isTreeWatched(rootKey(ROOT))).toBe(true);
    // FSEvents отдаёт и события создания папок за миг до старта слежения: ждём их и забываем.
    await sleep(500);
    s.treeChanged.mockClear();
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(dir, '.harnas', 'works', 'w', 'log'), `line ${i}\n`, { flag: 'a' });
      await writeFile(path.join(dir, 'node_modules', `m${i}`), '');
    }
    await sleep(900);
    expect(s.treeChanged).not.toHaveBeenCalled();

    await writeFile(path.join(dir, 'src', 'new.ts'), '');
    await writeFile(path.join(dir, 'top.ts'), '');
    await vi.waitFor(() => expect(s.treeChanged).toHaveBeenCalled(), { timeout: 3000 });
    await sleep(400);
    const dirs = new Set(s.treeChanged.mock.calls.flatMap(([e]) => (e as TreeChangedEvent).dirs));
    expect(dirs).toEqual(new Set(['src', '']));
    for (const [e] of s.treeChanged.mock.calls) expect((e as TreeChangedEvent).rootKey).toBe(rootKey(ROOT));
    // Пачка раз в 300 мс: две записи подряд — одно событие.
    expect(s.treeChanged.mock.calls.length).toBeLessThanOrEqual(2);
    expect(invalidated).toContain(rootKey(ROOT));
  });

  it('один fs.watch на корень; последний unwatch закрывает его и сбрасывает кэш', async () => {
    const watchers: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
    const watchFs = vi.fn<(target: string, options: { recursive?: boolean }) => EventEmitter & { close(): void }>(() => {
      const w = Object.assign(new EventEmitter(), { close: vi.fn() });
      watchers.push(w);
      return w;
    });
    const invalidated: string[] = [];
    watch = createFileWatch({ roots: roots(dir), watchFs, onTreeInvalidate: (key) => invalidated.push(key) });
    const a = await watch.watch(ROOT, '', sink());
    const b = await watch.watch(ROOT, '', sink());
    expect(watchFs).toHaveBeenCalledTimes(1);
    expect(watchFs.mock.calls[0]?.[0]).toBe(dir);
    expect(watchFs.mock.calls[0]?.[1]).toMatchObject({ recursive: true });
    watch.unwatch(a);
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    watch.unwatch(b);
    expect(watchers[0]?.close).toHaveBeenCalled();
    expect(watch.isTreeWatched(rootKey(ROOT))).toBe(false);
    expect(invalidated).toEqual([rootKey(ROOT)]);
  });
});

describe('слежение не запустилось (тест 13)', () => {
  it('EMFILE — files:watch-failed и предупреждение; ошибка по ходу — только предупреждение', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    watch = createFileWatch({
      roots: roots(dir),
      watchFs: () => {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      },
    });
    const error = await watch.watch(ROOT, '', sink()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('files:watch-failed');
    expect(warn).toHaveBeenCalled();

    const emitter = Object.assign(new EventEmitter(), { close: vi.fn() });
    const s = sink();
    watch = createFileWatch({ roots: roots(dir), watchFs: () => emitter });
    await watch.watch(ROOT, '', s);
    warn.mockClear();
    emitter.emit('error', new Error('boom'));
    expect(warn).toHaveBeenCalled();
    expect(s.treeChanged).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
