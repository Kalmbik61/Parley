import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { FilesDeniedError, type RootsRegistry } from '../roots.js';
import { registerFilesIpc } from './ipc.js';

/** Подставной `ipcMain`, как в `main/ipc.test.ts`. */
class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`нет обработчика для ${channel}`);
    return handler({}, ...args);
  }
}

function setup(): { ipcMain: FakeIpcMain; roots: { [K in keyof RootsRegistry]: ReturnType<typeof vi.fn> } } {
  const ipcMain = new FakeIpcMain();
  const roots = {
    resolve: vi.fn().mockRejectedValue(new FilesDeniedError('outside')),
    locate: vi.fn().mockResolvedValue(null),
    insideAnyRoot: vi.fn().mockResolvedValue(null),
    roots: vi.fn().mockReturnValue([]),
    expandHome: vi.fn((p: string) => p),
    rootPath: vi.fn(() => {
      throw new FilesDeniedError('no roots');
    }),
  };
  registerFilesIpc({ ipcMain: ipcMain as unknown as IpcMain, roots: roots as unknown as RootsRegistry });
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
  it('регистрирует ровно каналы 5.2 и 7.1a', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual([
      'files:list',
      'files:locate',
      'files:read-bytes',
      'files:read-text',
      'files:stat',
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
