import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfiler } from './profiler.js';
import type { ProfilerSession } from './profiler.js';

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

type Post = (method: string, params: object | undefined, cb: (err: Error | null, result?: unknown) => void) => void;

/** Сессия-пустышка: `post` отвечает сразу; `Profiler.stop` отдаёт минимальный профиль. */
function fakeSession(failOn?: string) {
  const posts: string[] = [];
  const post: Post = (method, _params, cb) => {
    posts.push(method);
    if (method === failOn) {
      cb(new Error(`${method} failed`));
      return;
    }
    cb(null, method === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : undefined);
  };
  const session: ProfilerSession = { connect: vi.fn(), disconnect: vi.fn(), post };
  return { session, posts };
}

let root: string;
let dir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(path.join(tmpdir(), 'parley-profiler-'));
  dir = path.join(root, 'diagnostics');
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-16T10:00:00Z');
const PROFILE_FILE = 'host-20261016-100000.cpuprofile';

describe('createProfiler', () => {
  it('start пишет .cpuprofile через заданное число секунд и переводит статус в done', async () => {
    const { session, posts } = fakeSession();
    const profiler = createProfiler({ dir, log: fakeLog(), session: () => session, now: () => NOW });

    expect(profiler.status()).toEqual({ state: 'idle' });
    expect(profiler.start(2)).toEqual({ state: 'running', startedAt: '2026-10-16T10:00:00.000Z', seconds: 2 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(profiler.status().state).toBe('running');
    expect(posts).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(profiler.status().state).toBe('done'));
    expect(profiler.status()).toEqual({
      state: 'done',
      file: path.join(dir, PROFILE_FILE),
      finishedAt: '2026-10-16T10:00:00.000Z',
    });
    expect(posts).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop']);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path.join(dir, PROFILE_FILE), 'utf8'))).toHaveProperty('nodes');
    expect(await profiler.files()).toEqual([path.join(dir, PROFILE_FILE)]);
  });

  it('интервал выборки — 1 мс (1000 мкс)', async () => {
    const params: Array<object | undefined> = [];
    const post: Post = (method, p, cb) => {
      if (method === 'Profiler.setSamplingInterval') params.push(p);
      cb(null, method === 'Profiler.stop' ? { profile: { nodes: [] } } : undefined);
    };
    const profiler = createProfiler({
      dir,
      log: fakeLog(),
      session: () => ({ connect: vi.fn(), disconnect: vi.fn(), post }),
      now: () => NOW,
    });
    profiler.start(1);
    await profiler.stop();
    expect(params).toEqual([{ interval: 1000 }]);
  });

  it('повторный start во время записи возвращает running и не открывает вторую сессию', async () => {
    const { session } = fakeSession();
    const makeSession = vi.fn(() => session);
    const profiler = createProfiler({ dir, log: fakeLog(), session: makeSession, now: () => NOW });

    const first = profiler.start(5);
    expect(profiler.start(30)).toEqual(first);
    expect(makeSession).toHaveBeenCalledTimes(1);
    expect(session.connect).toHaveBeenCalledTimes(1);
    await profiler.stop();
  });

  it('seconds > 60 режется до 60, без аргумента — 20', async () => {
    const { session } = fakeSession();
    const profiler = createProfiler({ dir, log: fakeLog(), session: () => session, now: () => NOW });

    expect(profiler.start(90)).toMatchObject({ state: 'running', seconds: 60 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(profiler.status().state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(profiler.status().state).toBe('done'));

    expect(profiler.start()).toMatchObject({ state: 'running', seconds: 20 });
    await profiler.stop();
  });

  it('хранит только 5 последних файлов', async () => {
    await mkdir(dir, { recursive: true });
    const old: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const file = path.join(dir, `host-2020010${i}-000000.cpuprofile`);
      await writeFile(file, '{}');
      await utimes(file, new Date(2020, 0, i), new Date(2020, 0, i));
      old.push(file);
    }
    const { session } = fakeSession();
    const profiler = createProfiler({ dir, log: fakeLog(), session: () => session, now: () => NOW });

    profiler.start(1);
    await profiler.stop();

    const fresh = path.join(dir, PROFILE_FILE);
    // Новый файл первым, затем четыре самых свежих из прежних; два самых старых удалены.
    expect(await profiler.files()).toEqual([fresh, old[5], old[4], old[3], old[2]]);
    expect((await readdir(dir)).sort()).toEqual([fresh, ...old.slice(2)].map((file) => path.basename(file)).sort());
  });

  it('stop() во время записи останавливает профиль и пишет файл; без записи ничего не делает', async () => {
    const { session, posts } = fakeSession();
    const profiler = createProfiler({ dir, log: fakeLog(), session: () => session, now: () => NOW });

    await profiler.stop();
    expect(posts).toEqual([]);

    profiler.start(30);
    await profiler.stop();
    expect(profiler.status()).toMatchObject({ state: 'done', file: path.join(dir, PROFILE_FILE) });
    expect(posts.at(-1)).toBe('Profiler.stop');
    // Таймер снят: позднее срабатывание не пишет второй профиль.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posts.filter((m) => m === 'Profiler.stop')).toHaveLength(1);
  });

  it('ошибка post переводит статус в failed и закрывает сессию', async () => {
    const log = fakeLog();
    const { session } = fakeSession('Profiler.start');
    const profiler = createProfiler({ dir, log, session: () => session, now: () => NOW });

    profiler.start(5);
    await vi.waitFor(() => expect(profiler.status().state).toBe('failed'));
    expect(profiler.status()).toEqual({ state: 'failed', error: 'Profiler.start failed' });
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // После сбоя можно стартовать заново.
    expect(profiler.start(1)).toMatchObject({ state: 'running' });
    await profiler.stop();
  });

  it('настоящий inspector: профиль за 300 мс парсится и содержит nodes', async () => {
    vi.useRealTimers();
    const profiler = createProfiler({ dir, log: fakeLog() });

    expect(profiler.start(0.3)).toMatchObject({ state: 'running', seconds: 0.3 });
    await vi.waitFor(() => expect(profiler.status().state).not.toBe('running'), { timeout: 5_000, interval: 25 });

    const status = profiler.status();
    expect(status.state).toBe('done');
    if (status.state !== 'done') return;
    const profile = JSON.parse(await readFile(status.file, 'utf8')) as { nodes: unknown[] };
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
  });
});
