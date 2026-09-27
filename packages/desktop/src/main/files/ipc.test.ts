import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { FilesDeniedError, type RootsRegistry } from '../roots.js';
import type { GitRunner } from './git-api.js';
import { registerFilesIpc } from './ipc.js';
import type { WatchFs } from './watch.js';

/** Подставной `ipcMain`, как в `main/ipc.test.ts`. */
class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    return this.invokeFrom(new FakeSender(), channel, ...args);
  }

  invokeFrom(sender: FakeSender, channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`нет обработчика для ${channel}`);
    return handler({ sender }, ...args);
  }
}

/** Подставной `webContents` окна: события навигации и закрытия, журнал `send`. */
class FakeSender extends EventEmitter {
  static next = 1;
  readonly id = FakeSender.next++;
  readonly sent: Array<[string, unknown]> = [];
  destroyed = false;

  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload]);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/** Подставной git: rev-parse — корень без prefix, grep висит до отмены, прочее — пустой ответ. */
function fakeGit(): GitRunner & { run: ReturnType<typeof vi.fn> } {
  const empty = { code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: false };
  return {
    run: vi.fn(async (args: string[], _cwd: string, options?: { signal?: AbortSignal }) => {
      if (args.includes('rev-parse')) return { ...empty, stdout: Buffer.from('\n') };
      if (args.includes('grep')) {
        return new Promise<Awaited<ReturnType<GitRunner['run']>>>((resolve) => {
          const done = (): void => resolve({ ...empty, code: null });
          if (options?.signal?.aborted) done();
          options?.signal?.addEventListener('abort', done, { once: true });
        });
      }
      return empty;
    }),
  };
}

function fakeWatchFs(): WatchFs & {
  mock: { calls: unknown[][] };
  watchers: Array<{ close: ReturnType<typeof vi.fn>; listener: (event: string, filename: string | null) => void }>;
} {
  const watchers: Array<{ close: ReturnType<typeof vi.fn>; listener: (event: string, filename: string | null) => void }> = [];
  const fn = vi.fn((_target: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchers.push({ close: watcher.close, listener });
    return watcher;
  });
  return Object.assign(fn, { watchers }) as unknown as ReturnType<typeof fakeWatchFs>;
}

function setup(
  extra: { rootPath?: string; git?: GitRunner; watchFs?: WatchFs } = {},
): { ipcMain: FakeIpcMain; roots: { [K in keyof RootsRegistry]: ReturnType<typeof vi.fn> } } {
  const ipcMain = new FakeIpcMain();
  const roots = {
    resolve: vi.fn().mockRejectedValue(new FilesDeniedError('outside')),
    locate: vi.fn().mockResolvedValue(null),
    insideAnyRoot: vi.fn().mockResolvedValue(null),
    roots: vi.fn().mockReturnValue([]),
    expandHome: vi.fn((p: string) => p),
    rootPath: vi.fn(() => {
      if (extra.rootPath !== undefined) return extra.rootPath;
      throw new FilesDeniedError('no roots');
    }),
  };
  if (extra.rootPath !== undefined) {
    const base = extra.rootPath;
    roots.resolve.mockImplementation(async (_root: unknown, rel: string) => path.join(base, rel));
  }
  registerFilesIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    roots: roots as unknown as RootsRegistry,
    git: extra.git ?? fakeGit(),
    spawnGrepWorker: () => {
      throw new Error('воркер в тестах каналов не нужен');
    },
    ...(extra.watchFs === undefined ? {} : { watchFs: extra.watchFs }),
  });
  return { ipcMain, roots };
}

const KEY = '/p/proj w-1';
const ROOT = { workKey: KEY, spec: { kind: 'project' } };

async function code(promise: unknown): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return decodeIpcError(error).code;
  }
  return 'resolved';
}

describe('files/ipc: каналы files:stat и files:locate (кусок 5.2)', () => {
  it('регистрирует ровно каналы 5.2, 7.1a и 7.1b', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual([
      'files:cancel',
      'files:git-show',
      'files:git-status',
      'files:grep',
      'files:list',
      'files:locate',
      'files:ls-files',
      'files:read-bytes',
      'files:read-text',
      'files:stat',
      'files:unwatch',
      'files:watch',
      'files:write',
    ]);
  });

  it('files:stat: путь вне корня — null, а не отказ пачки', async () => {
    const { ipcMain, roots } = setup();
    expect(await ipcMain.invoke('files:stat', ROOT, ['a.ts', '../b'])).toEqual([null, null]);
    expect(roots.resolve).toHaveBeenCalledTimes(2);
  });

  it('files:locate: пути уходят в locate своей работы', async () => {
    const { ipcMain, roots } = setup();
    expect(await ipcMain.invoke('files:locate', KEY, ['/x/a.ts', '~/b'])).toEqual([null, null]);
    expect(roots.locate).toHaveBeenCalledWith(KEY, '/x/a.ts');
    expect(roots.locate).toHaveBeenCalledWith(KEY, '~/b');
  });

  it('201 путь — отказ всего вызова (тест 8)', async () => {
    const { ipcMain, roots } = setup();
    const paths = Array.from({ length: 201 }, (_, i) => `/x/${i}`);
    expect(await code(ipcMain.invoke('files:locate', KEY, paths))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:stat', ROOT, paths))).toBe('bad_request');
    expect(roots.locate).not.toHaveBeenCalled();
    expect(roots.resolve).not.toHaveBeenCalled();
    // Ровно 200 — можно.
    expect(await ipcMain.invoke('files:locate', KEY, paths.slice(0, 200))).toHaveLength(200);
  });

  it('проверка аргументов до диска (тест 14): неверная форма — отказ, resolve и locate не вызваны', async () => {
    const { ipcMain, roots } = setup();
    const badRoots: unknown[] = [
      { workKey: KEY },
      { workKey: KEY, spec: { kind: 'other' } },
      { workKey: KEY, spec: { kind: 'worktree' } },
      { workKey: KEY, spec: { kind: 'worktree', sessionId: '' } },
      // sessionId проверяется как id (раунд исправлений 1): имена прототипа и сверхдлинный — отказ.
      { workKey: KEY, spec: { kind: 'worktree', sessionId: '__proto__' } },
      { workKey: KEY, spec: { kind: 'worktree', sessionId: 'constructor' } },
      { workKey: KEY, spec: { kind: 'worktree', sessionId: 's'.repeat(4097) } },
      { workKey: KEY, spec: { kind: 'worktree', sessionId: 42 } },
      { workKey: '__proto__', spec: { kind: 'project' } },
      { workKey: 'x'.repeat(4097), spec: { kind: 'project' } },
      null,
      'root',
    ];
    for (const root of badRoots) {
      expect(await code(ipcMain.invoke('files:stat', root, ['a.ts'])), JSON.stringify(root)?.slice(0, 60)).toBe('bad_request');
    }
    expect(await code(ipcMain.invoke('files:stat', ROOT, ['a\0b']))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:stat', ROOT, [42]))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:stat', ROOT, 'a.ts'))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:locate', '__proto__', ['/a']))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:locate', 'x'.repeat(4097), ['/a']))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:locate', KEY, ['/a\0']))).toBe('bad_request');
    expect(await code(ipcMain.invoke('files:locate', KEY, [null]))).toBe('bad_request');
    expect(roots.resolve).not.toHaveBeenCalled();
    expect(roots.locate).not.toHaveBeenCalled();
  });

  it('отказ реестра доходит с кодом (тест 15)', async () => {
    const { ipcMain, roots } = setup();
    roots.locate.mockRejectedValueOnce(new FilesDeniedError('outside'));
    expect(await code(ipcMain.invoke('files:locate', KEY, ['/a']))).toBe('files:denied');
  });
});

describe('files/ipc: list, read-text, read-bytes, write (кусок 7.1a)', () => {
  const MB = 1024 * 1024;

  it('верные аргументы доходят до реестра; его отказ — files:denied', async () => {
    const { ipcMain, roots } = setup();
    expect(await code(ipcMain.invoke('files:list', ROOT, ''))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:read-text', ROOT, 'a.ts'))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:read-bytes', ROOT, 'a.png'))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:read-bytes', ROOT, 'a.png', undefined))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:read-bytes', ROOT, 'a.png', 1))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:read-bytes', ROOT, 'a.png', 20 * MB))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:write', ROOT, 'a.ts', 'text', null))).toBe('files:denied');
    expect(await code(ipcMain.invoke('files:write', ROOT, 'a.ts', '', 1.5))).toBe('files:denied');
    expect(roots.resolve).toHaveBeenCalledTimes(8);
  });

  it('проверка аргументов (тест 11): неверная форма — bad_request, диск не тронут', async () => {
    const { ipcMain, roots } = setup();
    const bad: Array<[string, ...unknown[]]> = [
      ['files:list', null, ''],
      ['files:list', ROOT, 42],
      ['files:list', ROOT, 'a\0b'],
      ['files:read-text', ROOT, 'a\0b'],
      ['files:read-text', { workKey: KEY }, 'a.ts'],
      ['files:read-text', ROOT, undefined],
      ['files:read-bytes', ROOT, 'a\0b'],
      ['files:read-bytes', ROOT, 'a.png', 0],
      ['files:read-bytes', ROOT, 'a.png', 21 * MB],
      ['files:read-bytes', ROOT, 'a.png', 20 * MB + 1],
      ['files:read-bytes', ROOT, 'a.png', 1.5],
      ['files:read-bytes', ROOT, 'a.png', -1],
      ['files:read-bytes', ROOT, 'a.png', '5'],
      ['files:read-bytes', ROOT, 'a.png', null],
      ['files:write', ROOT, 'a\0b', 't', null],
      ['files:write', ROOT, 'a.ts', 't', Number.NaN],
      ['files:write', ROOT, 'a.ts', 't', Number.POSITIVE_INFINITY],
      ['files:write', ROOT, 'a.ts', 't', '123'],
      ['files:write', ROOT, 'a.ts', 't', undefined],
      ['files:write', ROOT, 'a.ts', 42, null],
      ['files:write', ROOT, 'a.ts', null, null],
      ['files:write', null, 'a.ts', 't', null],
    ];
    for (const [channel, ...args] of bad) {
      expect(await code(ipcMain.invoke(channel, ...args)), `${channel} ${String(args.at(-1))}`).toBe('bad_request');
    }
    expect(roots.resolve).not.toHaveBeenCalled();
  });
});

const QUERY = { text: 'needle', caseSensitive: false, wholeWord: false, regex: false };

describe('files/ipc: git, поиск и слежение (кусок 7.1b)', () => {
  it('проверка аргументов (тест 15): неверная форма — bad_request, git не запускался', async () => {
    const git = fakeGit();
    const { ipcMain, roots } = setup({ git });
    const bad: Array<[string, ...unknown[]]> = [
      ['files:grep', ROOT, { ...QUERY, text: '' }, 's'],
      ['files:grep', ROOT, { ...QUERY, text: 'x'.repeat(1001) }, 's'],
      ['files:grep', ROOT, { ...QUERY, text: 'a\0b' }, 's'],
      ['files:grep', ROOT, { ...QUERY, text: 42 }, 's'],
      ['files:grep', ROOT, { ...QUERY, regex: 'true' }, 's'],
      ['files:grep', ROOT, { ...QUERY, caseSensitive: 1 }, 's'],
      ['files:grep', ROOT, { text: 'x', caseSensitive: false, wholeWord: false }, 's'],
      ['files:grep', ROOT, null, 's'],
      ['files:grep', ROOT, QUERY, 's'.repeat(129)],
      ['files:grep', ROOT, QUERY, ''],
      ['files:grep', ROOT, QUERY, 7],
      ['files:grep', null, QUERY, 's'],
      ['files:cancel', 's'.repeat(129)],
      ['files:cancel', ''],
      ['files:cancel', null],
      ['files:unwatch', 'i'.repeat(129)],
      ['files:unwatch', ''],
      ['files:watch', ROOT, 'a\0b'],
      ['files:watch', ROOT, 42],
      ['files:watch', null, ''],
      ['files:ls-files', null],
      ['files:git-status', { workKey: KEY }],
      ['files:git-show', ROOT, '--output=/tmp/x', 'a.ts'],
      ['files:git-show', ROOT, 'HEAD;rm', 'a.ts'],
      ['files:git-show', ROOT, 42, 'a.ts'],
      ['files:git-show', ROOT, 'HEAD', 'a\0b'],
      ['files:git-show', ROOT, 'HEAD', '../x'],
      ['files:git-show', ROOT, 'HEAD', '/etc/hosts'],
      ['files:git-show', null, 'HEAD', 'a.ts'],
    ];
    for (const [channel, ...args] of bad) {
      expect(await code(ipcMain.invoke(channel, ...args)), `${channel} ${JSON.stringify(args).slice(0, 80)}`).toBe('bad_request');
    }
    expect(git.run).not.toHaveBeenCalled();
    expect(roots.resolve).not.toHaveBeenCalled();
    // Граница: ровно 1000 символов и id в 128 — можно.
    expect(await code(ipcMain.invoke('files:cancel', 's'.repeat(128)))).toBe('resolved');
    expect(await code(ipcMain.invoke('files:unwatch', 'i'.repeat(128)))).toBe('resolved');
    expect(await code(ipcMain.invoke('files:grep', ROOT, { ...QUERY, text: 'x'.repeat(1000) }, 's'.repeat(128)))).toBe('files:denied');
  });

  it('перезагрузка окна снимает его слежение и гасит незавершённый grep; закрытие — тоже (тест 13)', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-filesipc-')));
    try {
      const git = fakeGit();
      const watchFs = fakeWatchFs();
      const { ipcMain } = setup({ rootPath: dir, git, watchFs });
      const sender = new FakeSender();
      const other = new FakeSender();
      const id = (await ipcMain.invokeFrom(sender, 'files:watch', ROOT, '')) as string;
      expect(typeof id).toBe('string');
      const otherId = (await ipcMain.invokeFrom(other, 'files:watch', ROOT, '')) as string;
      expect(watchFs.watchers).toHaveLength(1);

      // Событие дерева уходит обоим окнам пачкой.
      watchFs.watchers[0]?.listener('rename', 'src/new.ts');
      await vi.waitFor(() => expect(sender.sent).toContainEqual(['files:tree-changed', { rootKey: `${KEY} project`, dirs: ['src'] }]));
      expect(other.sent).toHaveLength(1);

      const grep = ipcMain.invokeFrom(sender, 'files:grep', ROOT, QUERY, 'sig') as Promise<unknown>;
      await vi.waitFor(() => expect(git.run.mock.calls.some(([args]) => (args as string[]).includes('grep'))).toBe(true));

      // Навигация подкадра и внутри документа — не перезагрузка.
      sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      let settled = false;
      void grep.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      expect(await grep).toEqual({ files: [], truncated: true });
      // Корень ещё смотрит другое окно — fs.watch жив; его подписка снимается закрытием.
      expect(watchFs.watchers[0]?.close).not.toHaveBeenCalled();
      // Чужой id окну не снять.
      await ipcMain.invokeFrom(sender, 'files:unwatch', otherId);
      expect(watchFs.watchers[0]?.close).not.toHaveBeenCalled();
      other.destroyed = true;
      other.emit('destroyed');
      expect(watchFs.watchers[0]?.close).toHaveBeenCalled();

      // Окно после перезагрузки подписывается заново — новый fs.watch.
      await ipcMain.invokeFrom(sender, 'files:watch', ROOT, '');
      expect(watchFs.watchers).toHaveLength(2);
      void id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('watch корня при EMFILE — files:watch-failed (тест 13)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-filesipc-')));
    try {
      const { ipcMain } = setup({
        rootPath: dir,
        watchFs: () => {
          throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
        },
      });
      expect(await code(ipcMain.invoke('files:watch', ROOT, ''))).toBe('files:watch-failed');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cancel гасит grep этого окна по signalId', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-filesipc-')));
    try {
      const git = fakeGit();
      const { ipcMain } = setup({ rootPath: dir, git });
      const sender = new FakeSender();
      const grep = ipcMain.invokeFrom(sender, 'files:grep', ROOT, QUERY, 'sig') as Promise<unknown>;
      await vi.waitFor(() => expect(git.run.mock.calls.some(([args]) => (args as string[]).includes('grep'))).toBe(true));
      // Тот же signalId другого окна — не его поиск.
      await ipcMain.invokeFrom(new FakeSender(), 'files:cancel', 'sig');
      await ipcMain.invokeFrom(sender, 'files:cancel', 'sig');
      expect(await grep).toEqual({ files: [], truncated: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
