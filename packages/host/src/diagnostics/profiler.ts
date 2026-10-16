import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import path from 'node:path';
import type { ProfileStatus } from '@parley/protocol';
import type { Log } from '../log.js';

export const PROFILE_DEFAULT_SECONDS = 20;
export const PROFILE_MAX_SECONDS = 60;
export const PROFILE_KEEP = 5;
export const PROFILE_SAMPLING_US = 1000;

const PROFILE_EXT = '.cpuprofile';

/** Часть `node:inspector` `Session`, которой пользуется профилировщик: в тестах подменяется. */
export interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object | undefined, cb: (err: Error | null, result?: unknown) => void): void;
}

export interface Profiler {
  /** Запускает запись; во время записи второй вызов отдаёт текущий `running` и ничего не трогает. */
  start(seconds?: number): ProfileStatus;
  status(): ProfileStatus;
  /** Пути `.cpuprofile` в каталоге, новые первыми. */
  files(): Promise<string[]>;
  /** Останавливает идущую запись и пишет файл; без записи ничего не делает. */
  stop(): Promise<void>;
}

/** `20261016-100000` по UTC: имя файла не зависит от часового пояса машины. */
const stamp = (at: Date): string => at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const post = (session: ProfilerSession, method: string, params?: object): Promise<unknown> =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err === null ? resolve(result) : reject(err)));
  });

/** Идущая запись: `ready` — готовность профилировщика, `finishing` — единственный общий конец (таймер, `stop()`, сбой). */
interface Run {
  session: ProfilerSession;
  startedAt: Date;
  ready: Promise<unknown>;
  timer: ReturnType<typeof setTimeout>;
  finishing: Promise<void> | null;
}

/**
 * Профиль CPU хоста по запросу через `node:inspector`: выборка раз в 1 мс, пока идёт запись, и ни копейки
 * накладных расходов вне её. Файл `<dir>/host-YYYYMMDD-HHMMSS.cpuprofile` открывается в DevTools Chrome
 * (Performance → Load profile); хранятся `keep` последних.
 */
export function createProfiler(deps: {
  dir: string;
  log: Log;
  session?: () => ProfilerSession;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  keep?: number;
}): Profiler {
  const { dir, log } = deps;
  const makeSession = deps.session ?? (() => new Session());
  const now = deps.now ?? (() => new Date());
  const keep = deps.keep ?? PROFILE_KEEP;

  let status: ProfileStatus = { state: 'idle' };
  let run: Run | null = null;

  const files = async (): Promise<string[]> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(PROFILE_EXT))
        .map(async (name) => {
          const file = path.join(dir, name);
          try {
            return { file, mtimeMs: (await stat(file)).mtimeMs };
          } catch {
            // Файл исчез между readdir и stat (чистка соседнего профиля) — в список не попадает.
            return null;
          }
        }),
    ).then((found) => found.filter((entry) => entry !== null));
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1));
    return entries.map((entry) => entry.file);
  };

  const prune = async (): Promise<void> => {
    try {
      for (const file of (await files()).slice(keep)) await rm(file, { force: true });
    } catch (err) {
      log.warn('host: старые профили CPU не удалены', { error: messageOf(err) });
    }
  };

  const finish = (current: Run): Promise<void> => {
    current.finishing ??= (async () => {
      clearTimeout(current.timer);
      // Имя файла не зависит от результата записи: временный файл виден и из `catch`.
      const file = path.join(dir, `host-${stamp(current.startedAt)}${PROFILE_EXT}`);
      const tmp = `${file}.tmp`;
      try {
        await current.ready;
        const result = (await post(current.session, 'Profiler.stop')) as { profile: unknown };
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(result.profile));
        await rename(tmp, file);
        status = { state: 'done', file, finishedAt: now().toISOString() };
        log.info('host: профиль CPU записан', { file });
      } catch (err) {
        status = { state: 'failed', error: messageOf(err) };
        log.warn('host: профиль CPU не записан', { error: messageOf(err) });
        try {
          await rm(tmp, { force: true });
        } catch {
          // Не удалился — остаётся `.tmp`, который файлом профиля не считается.
        }
      } finally {
        try {
          current.session.disconnect();
        } catch {
          // Сессия могла не успеть подключиться: закрывать нечего.
        }
        run = null;
      }
      if (status.state === 'done') await prune();
    })();
    return current.finishing;
  };

  return {
    start(seconds) {
      if (run !== null) return status;
      const length = Math.min(seconds ?? PROFILE_DEFAULT_SECONDS, PROFILE_MAX_SECONDS);
      const startedAt = now();
      const session = makeSession();
      try {
        session.connect();
      } catch (err) {
        status = { state: 'failed', error: messageOf(err) };
        log.warn('host: профиль CPU не записан', { error: messageOf(err) });
        return status;
      }
      const current: Run = {
        session,
        startedAt,
        ready: (async () => {
          await post(session, 'Profiler.enable');
          await post(session, 'Profiler.setSamplingInterval', { interval: PROFILE_SAMPLING_US });
          await post(session, 'Profiler.start');
        })(),
        timer: (deps.setTimer ?? setTimeout)(() => void finish(current), length * 1000),
        finishing: null,
      };
      run = current;
      // Сбой подготовки закрывает запись сразу, не дожидаясь таймера.
      current.ready.catch(() => void finish(current));
      status = { state: 'running', startedAt: startedAt.toISOString(), seconds: length };
      log.info('host: профиль CPU запущен', { seconds: length });
      return status;
    },
    status: () => status,
    files,
    async stop() {
      if (run !== null) await finish(run);
    },
  };
}
