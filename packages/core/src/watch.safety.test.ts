import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionIndex } from './session-index.js';
import {
  WATCH_RECREATE_MAX_MS,
  WATCH_RECREATE_MS,
  watchSessions,
  type SessionChange,
  type WatchSource,
} from './watch.js';

type Listener = (event: string, name: string | null) => void;
interface FakeFsWatcher extends EventEmitter {
  close: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  attempts: [] as number[],
  watchers: [] as { listener: unknown; emitter: unknown }[],
  failing: false,
  /** Подписи файлов для подменённого stat: путь → размер и mtime. */
  files: new Map<string, { size: number; mtimeMs: number }>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    watch: (_root: string, _options: unknown, listener: unknown) => {
      state.attempts.push(Date.now());
      if (state.failing) throw new Error('watch недоступен');
      const emitter = Object.assign(new Emitter(), { close: vi.fn() });
      state.watchers.push({ listener, emitter });
      return emitter;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (file: string, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith('/fake-root/')) {
        const info = state.files.get(file);
        if (info === undefined) return Promise.reject(Object.assign(new Error('нет файла'), { code: 'ENOENT' }));
        return Promise.resolve(info);
      }
      return (actual.stat as (...args: unknown[]) => unknown)(file, ...rest);
    },
  };
});

const ROOT = '/fake-root';
const FILE = `${ROOT}/a.jsonl`;

describe('watchSessions: потолок ожидания, пересоздание, rescan', () => {
  let indexTimes: number[];
  let changes: SessionChange[];
  let errors: unknown[];
  let source: WatchSource;
  let index: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    state.attempts = [];
    state.watchers = [];
    state.failing = false;
    state.files = new Map([[FILE, { size: 10, mtimeMs: 1 }]]);
    indexTimes = [];
    changes = [];
    errors = [];
    index = vi.fn(async () => {
      indexTimes.push(Date.now());
      return {} as SessionIndex;
    });
    source = {
      root: ROOT,
      resolve: (changed) => (changed.startsWith(`${ROOT}/`) && changed.endsWith('.jsonl') ? changed : null),
      index: index as unknown as WatchSource['index'],
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const listenerOf = (n: number): Listener => state.watchers[n]!.listener as Listener;
  const emitterOf = (n: number): FakeFsWatcher => state.watchers[n]!.emitter as FakeFsWatcher;

  it('непрерывные события: первое перечитывание не позже maxWaitMs, промежутки не короче minIntervalMs', async () => {
    const watcher = watchSessions((c) => changes.push(c), [source], {
      debounceMs: 300,
      minIntervalMs: 700,
      maxWaitMs: 1500,
    });
    const start = Date.now();
    for (let t = 0; t < 6000; t += 100) {
      listenerOf(0)('change', 'a.jsonl');
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(3000);
    watcher.close();

    expect(indexTimes.length).toBeGreaterThanOrEqual(3);
    expect(indexTimes[0]! - start).toBeLessThanOrEqual(1500);
    for (let i = 1; i < indexTimes.length; i++) {
      const gap = indexTimes[i]! - indexTimes[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(700);
      expect(gap).toBeLessThanOrEqual(1700);
    }
  });

  it('одиночное событие после тишины перечитывается через debounceMs', async () => {
    const watcher = watchSessions((c) => changes.push(c), [source], { debounceMs: 300, minIntervalMs: 700 });
    await vi.advanceTimersByTimeAsync(5000);
    const start = Date.now();
    listenerOf(0)('change', 'a.jsonl');
    await vi.advanceTimersByTimeAsync(299);
    expect(index).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(index).toHaveBeenCalledTimes(1);
    expect(indexTimes[0]! - start).toBe(300);
    watcher.close();
  });

  it('ошибка наблюдателя: onError, закрытие, новый наблюдатель корня через WATCH_RECREATE_MS, его события доходят; close() отменяет пересоздание', async () => {
    const watcher = watchSessions((c) => changes.push(c), [source], {
      debounceMs: 300,
      onError: (error) => errors.push(error),
    });
    expect(state.watchers).toHaveLength(1);
    emitterOf(0).emit('error', new Error('FSEvents'));
    expect(errors).toHaveLength(1);
    expect(emitterOf(0).close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WATCH_RECREATE_MS - 1);
    expect(state.watchers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.watchers).toHaveLength(2);

    listenerOf(1)('change', 'a.jsonl');
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toEqual([{ kind: 'updated', file: FILE, session: {} }]);

    emitterOf(1).emit('error', new Error('снова'));
    watcher.close();
    await vi.advanceTimersByTimeAsync(WATCH_RECREATE_MAX_MS);
    expect(state.watchers).toHaveLength(2);
  });

  it('пока пересоздание не удаётся, паузы удваиваются и не превышают WATCH_RECREATE_MAX_MS', async () => {
    const watcher = watchSessions(() => undefined, [source], { onError: (error) => errors.push(error) });
    state.failing = true;
    emitterOf(0).emit('error', new Error('FSEvents'));
    await vi.advanceTimersByTimeAsync(WATCH_RECREATE_MAX_MS * 12);
    watcher.close();

    // attempts[0] — первое создание; дальше попытки пересоздания.
    const gaps = state.attempts.slice(1).map((at, i) => at - state.attempts[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(8);
    expect(gaps[1]).toBe(WATCH_RECREATE_MS * 2);
    expect(gaps[2]).toBe(WATCH_RECREATE_MS * 4);
    expect(gaps[3]).toBe(WATCH_RECREATE_MS * 8);
    for (const gap of gaps.slice(1)) expect(gap).toBeLessThanOrEqual(WATCH_RECREATE_MAX_MS);
    expect(gaps.at(-1)).toBe(WATCH_RECREATE_MAX_MS);
  });

  it('rescan: без изменений не перечитывает, дописанный перечитывает, вне корней пропускает, незнакомый перечитывает один раз', async () => {
    const watcher = watchSessions((c) => changes.push(c), [source], { debounceMs: 300 });

    // Незнакомый файл: один раз.
    watcher.rescan([FILE]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(index).toHaveBeenCalledTimes(1);

    // Без изменений размера и mtime.
    watcher.rescan([FILE]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(index).toHaveBeenCalledTimes(1);

    // Дописанный файл.
    state.files.set(FILE, { size: 20, mtimeMs: 2 });
    watcher.rescan([FILE]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(index).toHaveBeenCalledTimes(2);

    // Вне корней.
    watcher.rescan(['/other-root/b.jsonl']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(index).toHaveBeenCalledTimes(2);
    watcher.close();
  });
});
