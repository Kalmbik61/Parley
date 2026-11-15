/**
 * Попытка самообновления: загрузка, проверка и подготовка нового приложения рядом с запущенным (спека self-update
 * §3 решения 5-7, §5.1 «Попытка», §5.3). Установки здесь нет: `runAttempt` кончается готовым `Parley.app` в каталоге
 * подготовки, а замену делает сценарий на выходе (U3, U6).
 *
 * Пределы из спеки — требования, а не подсказки: манифест `SHA256SUMS.txt` до 64 КиБ и 30 с на весь запрос; архив до
 * 1 ГиБ и 60 с без единого байта (отсчёт идёт от начала запроса и сбрасывается только полученными байтами).
 * Любой отказ и отмена удаляют оба каталога попытки, и только после конца дочернего процесса.
 *
 * Сеть, дочерние процессы и часы — зависимости: тест подставляет `fetch` и часы, а `ditto`, `defaults` и `xattr` в нём
 * настоящие. Файловая система — настоящая: каталоги даёт вызывающий.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateFailure } from '../shared/bridge.js';
import type { UpdateFetch } from './update-check.js';
import { archiveName, assetUrl } from './update-target.js';

export const MANIFEST_FILE = 'SHA256SUMS.txt';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_TIMEOUT_MS = 30_000;
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const ARCHIVE_IDLE_MS = 60_000;
/** Ход загрузки — не чаще четырёх событий в секунду (§5.1). */
export const PROGRESS_INTERVAL_MS = 250;
export const APP_FILE = 'Parley.app';
export const APP_EXECUTABLE = 'Parley';
export const BUNDLE_ID = 'dev.parley.desktop';

const DITTO = '/usr/bin/ditto';
const DEFAULTS = '/usr/bin/defaults';
const XATTR = '/usr/bin/xattr';
/** Вывод дочернего процесса читается до этого размера: `defaults read` печатает одну строку. */
const STDOUT_MAX_BYTES = 64 * 1024;

export interface RunResult {
  /** Код выхода; `null` — запуск не удался или процесс убит сигналом. */
  code: number | null;
  stdout: string;
}

export interface RunningProcess {
  /** Конец процесса (после `kill` тоже); не отказывает. */
  exited: Promise<RunResult>;
  /** Завершает процесс; сам конец ждёт `exited`. */
  kill(): void;
}

/** Запуск настоящего дочернего процесса (`ditto`, `defaults`, `xattr`); без оболочки, вывод ошибок отброшен. */
export function spawnRun(command: string, args: string[]): RunningProcess {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < STDOUT_MAX_BYTES) stdout += chunk;
  });
  const exited = new Promise<RunResult>((resolve) => {
    child.once('error', () => resolve({ code: null, stdout: '' }));
    child.once('close', (code) => resolve({ code, stdout }));
  });
  return { exited, kill: () => void child.kill('SIGKILL') };
}

/** Файл архива: то, что нужно загрузке от `FileHandle`; тест подставляет свой (короткая запись, нет места). */
export interface ArchiveFile {
  /** Пишет `length` байт `buffer` с `offset`; возвращает, сколько записано на самом деле. */
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

export interface AttemptClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: AttemptClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AttemptLimits {
  manifestBytes: number;
  manifestMs: number;
  archiveBytes: number;
  archiveIdleMs: number;
}

const DEFAULT_LIMITS: AttemptLimits = {
  manifestBytes: MANIFEST_MAX_BYTES,
  manifestMs: MANIFEST_TIMEOUT_MS,
  archiveBytes: ARCHIVE_MAX_BYTES,
  archiveIdleMs: ARCHIVE_IDLE_MS,
};

export interface AttemptDeps {
  /** `net.fetch` Electron; в тестах подставной. Вызывается с `credentials: 'omit'`, без токенов. */
  fetch: UpdateFetch;
  run(command: string, args: string[]): RunningProcess;
  /** Ход загрузки; не чаще `PROGRESS_INTERVAL_MS`. `total` — `null`, если размер неизвестен. */
  onProgress(received: number, total: number | null): void;
  clock: AttemptClock;
  /** Пределы спеки; подменяются только в тестах. */
  limits?: Partial<AttemptLimits>;
  /** Создание файла архива (новый, права 0600); подменяется только в тестах. */
  openFile?(file: string): Promise<ArchiveFile>;
}

export interface AttemptInput {
  /** Версия найденного релиза, `X.Y.Z`. */
  version: string;
  /** `process.arch` запущенной сборки. */
  arch: string;
  /** Каталог загрузки попытки (§5.3): создаётся здесь, права 0700, должен быть новым. */
  downloadDir: string;
  /** Каталог подготовки попытки рядом с приложением: создаётся здесь, должен быть новым. */
  stagingDir: string;
}

export type AttemptFailure = UpdateFailure | 'cancelled';

/**
 * `cancelled` — попытку отменил `cancel()`: вызывающий итог отменённой попытки отбрасывает (состояние он уже
 * поменял сам). `done` приходит после того, как дочерний процесс закончился и каталоги удалены.
 */
export type AttemptOutcome =
  { ok: true; stagedApp: string } | { ok: false; reason: AttemptFailure };

export interface Attempt {
  done: Promise<AttemptOutcome>;
  /**
   * Обрывает запрос, завершает дочерний процесс, ждёт его конца и только потом удаляет оба каталога. После
   * готовой попытки удаляет подготовленное приложение. Повторный вызов — тот же промис. Не бросает.
   */
  cancel(): Promise<void>;
  /**
   * Синхронно и без ожидания: обрывает запрос и посылает kill идущему дочернему процессу, больше ничего (каталоги не
   * трогает). Для выхода в обход шага остановки хоста: каталог тогда убирает следующий старт окна (§13, п. 14).
   */
  abandon(): void;
}

/** Отказ с известной причиной. */
class Fail extends Error {
  constructor(readonly reason: UpdateFailure) {
    super(reason);
  }
}

/** Прерывание попытки: вышло время ожидания или её отменили. */
class Stop extends Error {
  constructor(readonly kind: 'timeout' | 'cancel') {
    super(kind);
  }
}

const HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Хэш архива из `SHA256SUMS.txt`: строка из двух полей, где второе в точности равно имени архива, а первое — 64
 * шестнадцатеричных знака (§5.3, п. 1). Нет строки, другая форма или две строки с разными хэшами — `checksum`.
 */
function expectedHash(manifest: string, file: string): string {
  const hashes = new Set<string>();
  for (const line of manifest.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== file) continue;
    const hash = fields[0];
    if (fields.length !== 2 || hash === undefined || !HASH_RE.test(hash))
      throw new Fail('checksum');
    hashes.add(hash.toLowerCase());
  }
  const [hash] = hashes;
  if (hashes.size !== 1 || hash === undefined) throw new Fail('checksum');
  return hash;
}

/** Размер из `Content-Length`; нет заголовка или не число — `null`. */
function declaredLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// Заголовки как у проверки версии (`update-check.ts`), кроме `Accept` и `X-GitHub-Api-Version`: это запрос файла, а
// не JSON-API. `User-Agent` — константа без версии окна, `Accept-Language` Chromium иначе дописал бы по локали.
const HEADERS = { Accept: '*/*', 'Accept-Language': 'en', 'User-Agent': 'Parley' };

export function runAttempt(deps: AttemptDeps, input: AttemptInput): Attempt {
  const limits: AttemptLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { clock } = deps;
  const controller = new AbortController();
  const created = { download: false, staging: false };
  const stagedApp = path.join(input.stagingDir, APP_FILE);

  let stopped: Stop | null = null;
  // Подписки на прерывание: `fetch`, не слушающий сигнал, и подвисшее чтение тела не держат попытку. Подписка живёт
  // только пока длится одно ожидание и снимается, когда оно кончилось: общий вечный промис копил бы по обработчику
  // (а с ним и по уже прочитанному куску архива) на каждое чтение.
  const waiters = new Set<(error: Stop) => void>();

  const stop = (kind: Stop['kind']): void => {
    if (stopped !== null) return;
    const error = new Stop(kind);
    stopped = error;
    controller.abort();
    const pending = [...waiters];
    waiters.clear();
    for (const reject of pending) reject(error);
  };
  const throwIfStopped = (): void => {
    if (stopped !== null) throw stopped;
  };
  const guard = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (stopped !== null) {
        promise.catch(() => {});
        reject(stopped);
        return;
      }
      const onStop = (error: Stop): void => reject(error);
      waiters.add(onStop);
      promise.then(
        (value) => {
          waiters.delete(onStop);
          resolve(value);
        },
        (error: unknown) => {
          waiters.delete(onStop);
          reject(error);
        },
      );
    });

  // Один таймер на попытку: сперва манифест (30 с на весь запрос), потом архив (60 с без байта).
  let timer: unknown = null;
  const disarm = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const arm = (ms: number): void => {
    disarm();
    timer = clock.setTimeout(() => stop('timeout'), ms);
  };

  let current: RunningProcess | null = null;
  const exec = async (command: string, args: string[]): Promise<RunResult> => {
    throwIfStopped();
    const child = deps.run(command, args);
    current = child;
    try {
      // Конец процесса ждём всегда, без гонки с прерыванием: каталоги нельзя убирать из-под живого `ditto`.
      return await child.exited.catch((): RunResult => ({ code: null, stdout: '' }));
    } finally {
      current = null;
    }
  };

  const onDisk = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch {
      throw new Fail('disk');
    }
  };

  const cleanup = async (): Promise<void> => {
    for (const [key, dir] of [
      ['download', input.downloadDir],
      ['staging', input.stagingDir],
    ] as const) {
      if (!created[key]) continue;
      created[key] = false;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  /** Ответ больше не нужен: тело обрывается (у занятого читателем — через читателя). */
  const release = (
    response: Response,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
  ): void => {
    void (reader ?? response.body)?.cancel().catch(() => {});
  };

  const fetchFile = async (url: string): Promise<Response> => {
    const request = deps.fetch(url, {
      headers: { ...HEADERS },
      signal: controller.signal,
      credentials: 'omit',
    });
    let response: Response;
    try {
      response = await guard(request);
    } catch (error) {
      // Попытку прервали раньше ответа: ответ, пришедший позже, никому не нужен, но тело за ним надо оборвать.
      request.then(
        (late) => release(late, null),
        () => {},
      );
      throw error;
    }
    if (!response.ok) {
      release(response, null);
      throw new Fail('network');
    }
    return response;
  };

  /** Манифест: тело потоком до предела; больше — `too_large`. */
  const readManifest = async (url: string): Promise<string> => {
    const response = await fetchFile(url);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (response.body === null) throw new Fail('network');
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await guard(reader.read());
        if (done) break;
        total += value.byteLength;
        if (total > limits.manifestBytes) throw new Fail('too_large');
        chunks.push(value);
      }
    } finally {
      release(response, reader);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  const openArchive = deps.openFile ?? ((file: string) => open(file, 'wx', 0o600));

  /** Кусок целиком в файл: короткая запись дописывается, ни одного байта за вызов или ошибка записи — `disk`. */
  const writeAll = async (archive: ArchiveFile, chunk: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await onDisk(
        archive.write(chunk, offset, chunk.byteLength - offset),
      );
      if (!(bytesWritten > 0)) throw new Fail('disk');
      offset += bytesWritten;
    }
  };

  /** Архив потоком в файл; SHA-256 считается по ходу. Возвращает хэш. */
  const downloadArchive = async (url: string, file: string): Promise<string> => {
    // Отсчёт простоя — от начала запроса: покрывает заголовки и перенаправления; сбрасывают его только байты.
    arm(limits.archiveIdleMs);
    const response = await fetchFile(url);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let archive: ArchiveFile | null = null;
    try {
      if (response.body === null) throw new Fail('network');
      const total = declaredLength(response);
      if (total !== null && total > limits.archiveBytes) throw new Fail('too_large');
      const hash = createHash('sha256');
      archive = await onDisk(openArchive(file));
      reader = response.body.getReader();
      let received = 0;
      let lastProgress = clock.now();
      deps.onProgress(0, total);
      for (;;) {
        const { done, value } = await guard(reader.read());
        if (done) break;
        // Пустой кусок — не байт: отсчёт простоя он не сбрасывает.
        if (value.byteLength === 0) continue;
        received += value.byteLength;
        if (received > limits.archiveBytes) throw new Fail('too_large');
        arm(limits.archiveIdleMs);
        await writeAll(archive, value);
        // Сумма считается по тому, что дошло до файла, а не по тому, что пришло.
        hash.update(value);
        const now = clock.now();
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          deps.onProgress(received, total);
        }
      }
      disarm();
      return hash.digest('hex');
    } finally {
      release(response, reader);
      await archive?.close().catch(() => {});
    }
  };

  /** Проверка распакованного приложения (§5.3, п. 5): настоящие каталог и файлы, версия и идентификатор. */
  const verifyApp = async (): Promise<void> => {
    const contents = path.join(stagedApp, 'Contents');
    const needed: [string, 'dir' | 'file'][] = [
      [stagedApp, 'dir'],
      [contents, 'dir'],
      [path.join(contents, 'MacOS', APP_EXECUTABLE), 'file'],
      [path.join(contents, 'Info.plist'), 'file'],
    ];
    for (const [target, kind] of needed) {
      // `lstat`: ссылка вместо каталога или файла — не то, что мы ставим.
      const stat = await lstat(target).catch(() => null);
      if (stat === null || (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()))
        throw new Fail('bad_archive');
    }
    const read = async (key: string): Promise<string> => {
      const result = await exec(DEFAULTS, ['read', path.join(contents, 'Info'), key]);
      if (result.code !== 0) throw new Fail('bad_archive');
      return result.stdout.trim();
    };
    if ((await read('CFBundleShortVersionString')) !== input.version) throw new Fail('bad_archive');
    if ((await read('CFBundleIdentifier')) !== BUNDLE_ID) throw new Fail('bad_archive');
  };

  const attempt = async (): Promise<AttemptOutcome> => {
    // Адреса — из констант и версии найденного релиза (U1), а не из входа окна.
    const file = archiveName(input.arch);
    if (file === null) throw new Fail('cannot_replace');
    let manifestUrl: string;
    let archiveUrl: string;
    try {
      manifestUrl = assetUrl(input.version, MANIFEST_FILE);
      archiveUrl = assetUrl(input.version, file);
    } catch {
      // Версия не `X.Y.Z`: такой релиз ставить нельзя.
      throw new Fail('cannot_replace');
    }

    // Оба каталога — до первого запроса: нет места или права — отказ без загрузки 200 МБ. Каталоги новые: чужой не
    // трогаем и не переиспользуем, поэтому `created` ставится только после успешного `mkdir`.
    await onDisk(mkdir(path.dirname(input.downloadDir), { recursive: true }));
    await onDisk(mkdir(input.downloadDir, { mode: 0o700 }));
    created.download = true;
    await onDisk(mkdir(input.stagingDir, { mode: 0o700 }));
    created.staging = true;

    arm(limits.manifestMs);
    const expected = expectedHash(await readManifest(manifestUrl), file);
    disarm();

    const archivePath = path.join(input.downloadDir, file);
    const actual = await downloadArchive(archiveUrl, archivePath);
    if (actual !== expected) throw new Fail('checksum');

    const unpacked = await exec(DITTO, ['-xk', archivePath, input.stagingDir]);
    throwIfStopped();
    if (unpacked.code !== 0) throw new Fail('bad_archive');

    await verifyApp();

    const unquarantined = await exec(XATTR, ['-dr', 'com.apple.quarantine', stagedApp]);
    throwIfStopped();
    if (unquarantined.code !== 0) throw new Fail('bad_archive');

    // Архив больше не нужен. Не удалось убрать — не отказ: старт окна чистит каталог загрузок.
    created.download = false;
    await rm(input.downloadDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, stagedApp };
  };

  let cancelled = false;
  const pipeline: Promise<AttemptOutcome> = attempt()
    .catch((error: unknown): AttemptOutcome => {
      // Любой отказ обрывает и сам запрос: тело, которое никто не дочитает, не должно висеть на соединении.
      controller.abort();
      if (error instanceof Fail) return { ok: false, reason: error.reason };
      if (error instanceof Stop && error.kind === 'cancel')
        return { ok: false, reason: 'cancelled' };
      // Время вышло, оборвался запрос или тело — всё это сеть.
      return { ok: false, reason: 'network' };
    })
    .then(async (outcome) => {
      disarm();
      if (cancelled) {
        await cleanup();
        return { ok: false, reason: 'cancelled' };
      }
      if (!outcome.ok) await cleanup();
      return outcome;
    });

  let cancelling: Promise<void> | null = null;
  return {
    done: pipeline,
    cancel() {
      cancelling ??= (async () => {
        cancelled = true;
        stop('cancel');
        current?.kill();
        await pipeline;
        await cleanup();
      })();
      return cancelling;
    },
    abandon() {
      controller.abort();
      current?.kill();
    },
  };
}
