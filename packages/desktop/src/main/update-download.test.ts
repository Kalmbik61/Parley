/**
 * Попытка самообновления (U2, спека self-update §5.3, §5.1 «Попытка»; сценарии SU-03...SU-07). Сеть подставная,
 * часы ручные (пределы — настоящие константы спеки), а `ditto`, `defaults` и `xattr` — настоящие, на архиве, который
 * тест собирает из поддельного `Parley.app`. Нужны утилиты macOS, поэтому набор идёт только на darwin (CI — macOS).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_IDLE_MS,
  ARCHIVE_MAX_BYTES,
  BUNDLE_ID,
  MANIFEST_MAX_BYTES,
  MANIFEST_TIMEOUT_MS,
  runAttempt,
  spawnRun,
  type AttemptClock,
  type AttemptDeps,
  type AttemptInput,
  type AttemptOutcome,
  type RunningProcess,
} from './update-download.js';
import type { UpdateFetch } from './update-check.js';

const exec = promisify(execFile);
const VERSION = '1.2.3';
const ARCH = 'arm64';
const ARCHIVE = 'parley-macos-arm64.zip';
const BASE = `https://github.com/Kalmbik61/Parley/releases/download/v${VERSION}`;
const MANIFEST_URL = `${BASE}/SHA256SUMS.txt`;
const ARCHIVE_URL = `${BASE}/${ARCHIVE}`;

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const plist = (version: string, id: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
</dict></plist>
`;

/** Часы вручную: таймеры срабатывают только от `advance`; `step` — на сколько `now()` уходит вперёд при каждом чтении. */
function manualClock(step = 0): AttemptClock & { advance(ms: number): void; pending(): number } {
  let time = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => {
      const value = time;
      time += step;
      return value;
    },
    setTimeout: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { at: time + ms, fn });
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

/** Тело, которым управляет тест: куски, конец, обрыв. */
function controlledBody(headers: Record<string, string> = {}): {
  response: Response;
  push(chunk: Buffer | string): void;
  end(): void;
  fail(error: Error): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers }),
    push: (chunk) => controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    end: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

const flush = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Попытка ещё не закончилась (после того как всё, что могло случиться, случилось). */
async function stillPending(done: Promise<AttemptOutcome>): Promise<boolean> {
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  await flush();
  return !settled;
}

type Handler = (url: string, init: Parameters<UpdateFetch>[1]) => Response | Promise<Response>;

describe.skipIf(process.platform !== 'darwin')('runAttempt', () => {
  let root: string;
  let input: AttemptInput;
  let requests: { url: string; init: Parameters<UpdateFetch>[1] }[];
  let progress: [number, number | null][];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-update-download-'));
    await mkdir(path.join(root, 'apps'));
    input = {
      version: VERSION,
      arch: ARCH,
      downloadDir: path.join(root, 'home', 'desktop', 'updates', '1'),
      stagingDir: path.join(root, 'apps', '.Parley.app.update-100-1'),
    };
    requests = [];
    progress = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Поддельное приложение в архиве; `tweak` дописывает или портит каталог перед упаковкой. */
  async function makeArchive(
    options: {
      version?: string;
      bundleId?: string;
      appName?: string;
      binary?: boolean;
      tweak?: (app: string) => Promise<void>;
    } = {},
  ): Promise<Buffer> {
    const {
      version = VERSION,
      bundleId = BUNDLE_ID,
      appName = 'Parley.app',
      binary = true,
      tweak,
    } = options;
    const work = await mkdtemp(path.join(root, 'build-'));
    const app = path.join(work, appName);
    await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(app, 'Contents', 'Info.plist'), plist(version, bundleId));
    if (binary)
      await writeFile(path.join(app, 'Contents', 'MacOS', 'Parley'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
    await tweak?.(app);
    const zip = path.join(work, 'out.zip');
    await exec('/usr/bin/ditto', ['-ck', '--keepParent', app, zip]);
    return readFile(zip);
  }

  const manifestFor = (archive: Buffer | string, name = ARCHIVE): string =>
    `${sha256(archive)}  ${name}\n`;

  /** `fetch`: каждый адрес отвечает своим обработчиком; запросы записываются. */
  function fetchOf(handlers: { manifest: Handler; archive: Handler }): UpdateFetch {
    return async (url, init) => {
      requests.push({ url, init });
      if (url === MANIFEST_URL) return handlers.manifest(url, init);
      if (url === ARCHIVE_URL) return handlers.archive(url, init);
      throw new Error(`unexpected url ${url}`);
    };
  }

  const ok =
    (body: Buffer | string): Handler =>
    () =>
      new Response(body, { status: 200 });

  function start(
    fetch: UpdateFetch,
    patch: Partial<AttemptDeps> = {},
    overrideInput: Partial<AttemptInput> = {},
  ): ReturnType<typeof runAttempt> {
    return runAttempt(
      {
        fetch,
        run: spawnRun,
        onProgress: (received, total) => progress.push([received, total]),
        clock: manualClock(),
        ...patch,
      },
      { ...input, ...overrideInput },
    );
  }

  /** Подставной процесс: тест сам решает, когда он закончится; убийство только записывается. */
  function gatedProcess(events: string[]): {
    process: RunningProcess;
    finish(code: number | null): void;
  } {
    let finish!: (code: number | null) => void;
    const exited = new Promise<{ code: number | null; stdout: string }>((resolve) => {
      finish = (code) => resolve({ code, stdout: '' });
    });
    return {
      process: {
        exited,
        kill: () => {
          events.push('kill');
        },
      },
      finish,
    };
  }

  const dirsGone = (): void => {
    expect(existsSync(input.downloadDir)).toBe(false);
    expect(existsSync(input.stagingDir)).toBe(false);
  };

  describe('SU-03: успешная попытка', () => {
    it('ровно два запроса на адреса из констант, без куки; ход виден; приложение подготовлено; загрузка убрана', async () => {
      const archive = await makeArchive();
      const chunks = [archive.subarray(0, 100), archive.subarray(100, 500), archive.subarray(500)];
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(chunk);
          c.close();
        },
      });
      const fetch = fetchOf({
        manifest: ok(manifestFor(archive)),
        archive: () =>
          new Response(stream, {
            status: 200,
            headers: { 'content-length': String(archive.length) },
          }),
      });
      const attempt = start(fetch, { clock: manualClock(300) });
      const outcome = await attempt.done;

      expect(outcome).toEqual({ ok: true, stagedApp: path.join(input.stagingDir, 'Parley.app') });
      expect(requests.map((r) => r.url)).toEqual([MANIFEST_URL, ARCHIVE_URL]);
      for (const request of requests) {
        expect(request.init.credentials).toBe('omit');
        expect(Object.keys(request.init.headers).map((k) => k.toLowerCase())).not.toContain(
          'authorization',
        );
        expect(Object.keys(request.init.headers).map((k) => k.toLowerCase())).not.toContain(
          'cookie',
        );
        expect(request.init.headers['User-Agent']).toBe('Parley');
      }
      expect(progress[0]).toEqual([0, archive.length]);
      expect(progress.at(-1)).toEqual([archive.length, archive.length]);
      expect(progress.map(([received]) => received)).toEqual(
        [...progress.map(([received]) => received)].sort((a, b) => a - b),
      );
      expect(
        existsSync(path.join(input.stagingDir, 'Parley.app', 'Contents', 'MacOS', 'Parley')),
      ).toBe(true);
      expect(existsSync(input.downloadDir)).toBe(false);
    });

    it('карантин снят настоящим xattr', async () => {
      const archive = await makeArchive({
        tweak: async (app) => {
          await exec('/usr/bin/xattr', [
            '-w',
            'com.apple.quarantine',
            '0081;00000000;Test;',
            path.join(app, 'Contents', 'MacOS', 'Parley'),
          ]);
        },
      });
      const outcome = await start(
        fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }),
      ).done;
      expect(outcome.ok).toBe(true);
      const binary = path.join(input.stagingDir, 'Parley.app', 'Contents', 'MacOS', 'Parley');
      await expect(
        exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', binary]),
      ).rejects.toBeDefined();
    });

    it('ход загрузки — не чаще четырёх событий в секунду', async () => {
      const clock = manualClock();
      const body = controlledBody();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => body.response }),
        { clock },
      );
      await vi.waitFor(() => expect(progress.length).toBe(1));
      for (let i = 0; i < 10; i += 1) body.push('ab');
      await flush();
      expect(progress).toEqual([[0, null]]);
      clock.advance(249);
      body.push('c');
      await flush();
      expect(progress.length).toBe(1);
      clock.advance(1);
      body.push('d');
      await vi.waitFor(() => expect(progress.length).toBe(2));
      expect(progress[1]).toEqual([22, null]);
      await attempt.cancel();
    });

    it('неподдерживаемая архитектура и версия не вида X.Y.Z — cannot_replace без запросов и каталогов', async () => {
      const fetch = fetchOf({ manifest: ok(''), archive: ok('') });
      expect(await start(fetch, {}, { arch: 'ia32' }).done).toEqual({
        ok: false,
        reason: 'cannot_replace',
      });
      expect(await start(fetch, {}, { version: '1.2' }).done).toEqual({
        ok: false,
        reason: 'cannot_replace',
      });
      expect(requests).toEqual([]);
      dirsGone();
    });
  });

  describe('SU-04: контрольная сумма', () => {
    it.each([
      [
        'хэш не совпал',
        (archive: Buffer) => manifestFor('другой архив', ARCHIVE) + String(archive.length),
      ],
      ['архива нет в манифесте', () => manifestFor('x', 'parley-macos-x64.zip')],
      ['пустой манифест', () => ''],
      ['хэш короче 64 знаков', () => `${'a'.repeat(63)}  ${ARCHIVE}\n`],
      ['хэш не шестнадцатеричный', () => `${'g'.repeat(64)}  ${ARCHIVE}\n`],
      ['имя с признаком двоичного файла', () => `${'a'.repeat(64)} *${ARCHIVE}\n`],
      ['лишнее поле в строке', () => `${'a'.repeat(64)}  ${ARCHIVE}  extra\n`],
      ['имя только префиксом', () => `${'a'.repeat(64)}  ${ARCHIVE}.sig\n`],
    ])('%s → checksum, каталоги удалены', async (_title, manifest) => {
      const archive = await makeArchive();
      const outcome = await start(
        fetchOf({ manifest: ok(manifest(archive)), archive: ok(archive) }),
      ).done;
      expect(outcome).toEqual({ ok: false, reason: 'checksum' });
      dirsGone();
    });

    it('форма манифеста отвергнута до загрузки архива: второго запроса нет', async () => {
      const archive = await makeArchive();
      await start(fetchOf({ manifest: ok('garbage\n'), archive: ok(archive) })).done;
      expect(requests.map((r) => r.url)).toEqual([MANIFEST_URL]);
    });

    it('две строки архива с разными хэшами — checksum; с одним и тем же — принимаются', async () => {
      const archive = await makeArchive();
      const good = sha256(archive);
      const bad = await start(
        fetchOf({
          manifest: ok(`${'a'.repeat(64)}  ${ARCHIVE}\n${good}  ${ARCHIVE}\n`),
          archive: ok(archive),
        }),
      ).done;
      expect(bad).toEqual({ ok: false, reason: 'checksum' });
      dirsGone();
      const same = await start(
        fetchOf({
          manifest: ok(`${good}  ${ARCHIVE}\n${good.toUpperCase()}  ${ARCHIVE}\n`),
          archive: ok(archive),
        }),
      ).done;
      expect(same.ok).toBe(true);
    });

    it('хэш найден среди прочих строк, перевод строки CRLF', async () => {
      const archive = await makeArchive();
      const manifest = `${'b'.repeat(64)}  parley-macos-x64.zip\r\n${sha256(archive)}  ${ARCHIVE}\r\n`;
      expect((await start(fetchOf({ manifest: ok(manifest), archive: ok(archive) })).done).ok).toBe(
        true,
      );
    });
  });

  describe('SU-05: приложение в архиве', () => {
    const outcomeFor = async (
      archive: Buffer,
      patch: Partial<AttemptDeps> = {},
    ): Promise<AttemptOutcome> =>
      start(fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }), patch).done;

    it('не архив (ditto вернул ошибку) → bad_archive', async () => {
      const junk = Buffer.from('это не zip');
      expect(await outcomeFor(junk)).toEqual({ ok: false, reason: 'bad_archive' });
      dirsGone();
    });

    it.each([
      ['нет Parley.app', { appName: 'Other.app' }],
      ['нет исполняемого файла', { binary: false }],
      ['чужая версия', { version: '9.9.9' }],
      ['чужой идентификатор', { bundleId: 'dev.example.other' }],
      [
        'исполняемый файл — ссылка',
        {
          binary: false,
          tweak: async (app: string) => {
            await symlink('/bin/sh', path.join(app, 'Contents', 'MacOS', 'Parley'));
          },
        },
      ],
    ])('%s → bad_archive, каталоги удалены', async (_title, options) => {
      const archive = await makeArchive(options);
      expect(await outcomeFor(archive)).toEqual({ ok: false, reason: 'bad_archive' });
      dirsGone();
    });

    it('xattr вернул ошибку → bad_archive, каталоги удалены', async () => {
      const archive = await makeArchive();
      const run: AttemptDeps['run'] = (command, args) =>
        command === '/usr/bin/xattr'
          ? { exited: Promise.resolve({ code: 1, stdout: '' }), kill: () => {} }
          : spawnRun(command, args);
      expect(await outcomeFor(archive, { run })).toEqual({ ok: false, reason: 'bad_archive' });
      dirsGone();
    });

    it('запуск процесса не удался (код null) → bad_archive', async () => {
      const archive = await makeArchive();
      const run: AttemptDeps['run'] = (command, args) =>
        command === '/usr/bin/defaults'
          ? { exited: Promise.resolve({ code: null, stdout: '' }), kill: () => {} }
          : spawnRun(command, args);
      expect(await outcomeFor(archive, { run })).toEqual({ ok: false, reason: 'bad_archive' });
    });
  });

  describe('SU-06: сеть и пределы', () => {
    it('манифест и архив не 2xx → network, каталоги удалены', async () => {
      const archive = await makeArchive();
      const notFound = () => new Response('', { status: 404 });
      expect(await start(fetchOf({ manifest: notFound, archive: ok(archive) })).done).toEqual({
        ok: false,
        reason: 'network',
      });
      dirsGone();
      expect(
        await start(
          fetchOf({
            manifest: ok(manifestFor(archive)),
            archive: () => new Response('', { status: 500 }),
          }),
        ).done,
      ).toEqual({
        ok: false,
        reason: 'network',
      });
      dirsGone();
    });

    it('fetch отказал → network', async () => {
      const outcome = await start(
        fetchOf({
          manifest: () => {
            throw new TypeError('fetch failed');
          },
          archive: ok(''),
        }),
      ).done;
      expect(outcome).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('обрыв тела архива → network, каталоги удалены', async () => {
      const body = controlledBody();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => body.response }),
      );
      await vi.waitFor(() => expect(progress.length).toBe(1));
      body.push('abc');
      body.fail(new Error('connection reset'));
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('обрыв тела манифеста → network', async () => {
      const body = controlledBody();
      const attempt = start(fetchOf({ manifest: () => body.response, archive: ok('') }));
      await vi.waitFor(() => expect(existsSync(input.stagingDir)).toBe(true));
      body.push('abc');
      body.fail(new Error('reset'));
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      expect(requests.length).toBe(1);
      dirsGone();
    });

    it('манифест: ответа нет 30 с → network, ни секундой раньше', async () => {
      const clock = manualClock();
      // fetch, не слушающий сигнал и не отвечающий вовсе.
      const attempt = start(
        fetchOf({ manifest: () => new Promise<Response>(() => {}), archive: ok('') }),
        { clock },
      );
      await vi.waitFor(() => expect(clock.pending()).toBe(1));
      clock.advance(MANIFEST_TIMEOUT_MS - 1);
      expect(await stillPending(attempt.done)).toBe(true);
      clock.advance(1);
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('манифест: тело тянется дольше 30 с от начала запроса → network, сколько бы кусков ни пришло', async () => {
      const clock = manualClock();
      const body = controlledBody();
      const attempt = start(fetchOf({ manifest: () => body.response, archive: ok('') }), { clock });
      await vi.waitFor(() => expect(clock.pending()).toBe(1));
      clock.advance(20_000);
      body.push('a');
      await flush();
      clock.advance(MANIFEST_TIMEOUT_MS - 20_000);
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('манифест больше 64 КиБ → too_large; ровно 64 КиБ предел не нарушает', async () => {
      const archive = await makeArchive();
      const big = await start(
        fetchOf({ manifest: ok('a'.repeat(MANIFEST_MAX_BYTES + 1)), archive: ok(archive) }),
      ).done;
      expect(big).toEqual({ ok: false, reason: 'too_large' });
      dirsGone();
      // 64 КиБ комментариев и одна верная строка: предел не нарушен, и до разбора доходит весь манифест.
      const padding = `${'#'.repeat(MANIFEST_MAX_BYTES - 200)}\n`;
      const manifest = padding + manifestFor(archive);
      expect(Buffer.byteLength(manifest)).toBeLessThanOrEqual(MANIFEST_MAX_BYTES);
      expect((await start(fetchOf({ manifest: ok(manifest), archive: ok(archive) })).done).ok).toBe(
        true,
      );
    });

    it('архив: нет заголовков 60 с → network; сброса от заголовков нет', async () => {
      const clock = manualClock();
      let release!: (response: Response) => void;
      const attempt = start(
        fetchOf({
          manifest: ok(manifestFor('x')),
          archive: () => new Promise<Response>((resolve) => (release = resolve)),
        }),
        { clock },
      );
      await vi.waitFor(() => expect(requests.length).toBe(2));
      clock.advance(50_000);
      // Заголовки пришли на 50-й секунде, тела нет: отсчёт от начала запроса идёт дальше.
      release(controlledBody().response);
      await flush();
      clock.advance(ARCHIVE_IDLE_MS - 50_000 - 1);
      expect(await stillPending(attempt.done)).toBe(true);
      clock.advance(1);
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('архив: подвешенный запрос без ответа вовсе → network ровно через 60 с', async () => {
      const clock = manualClock();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => new Promise<Response>(() => {}) }),
        {
          clock,
        },
      );
      await vi.waitFor(() => expect(requests.length).toBe(2));
      clock.advance(ARCHIVE_IDLE_MS - 1);
      expect(await stillPending(attempt.done)).toBe(true);
      clock.advance(1);
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('архив: затишье в теле 60 с → network; каждый полученный байт отсчёт сбрасывает', async () => {
      const clock = manualClock();
      const body = controlledBody();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => body.response }),
        { clock },
      );
      await vi.waitFor(() => expect(progress.length).toBe(1));
      clock.advance(ARCHIVE_IDLE_MS - 1_000);
      body.push('a');
      await flush();
      clock.advance(ARCHIVE_IDLE_MS - 1);
      expect(await stillPending(attempt.done)).toBe(true);
      clock.advance(1);
      expect(await attempt.done).toEqual({ ok: false, reason: 'network' });
      dirsGone();
    });

    it('таймер манифеста не переживает манифест: 30 с загрузки архива попытку не обрывают', async () => {
      const clock = manualClock();
      const body = controlledBody();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => body.response }),
        { clock },
      );
      await vi.waitFor(() => expect(progress.length).toBe(1));
      clock.advance(MANIFEST_TIMEOUT_MS);
      body.push('a');
      await flush();
      expect(await stillPending(attempt.done)).toBe(true);
      await attempt.cancel();
    });

    it('архив: заявленный размер больше 1 ГиБ → too_large без чтения тела', async () => {
      const outcome = await start(
        fetchOf({
          manifest: ok(manifestFor('x')),
          archive: () =>
            new Response('abc', {
              status: 200,
              headers: { 'content-length': String(ARCHIVE_MAX_BYTES + 1) },
            }),
        }),
      ).done;
      expect(outcome).toEqual({ ok: false, reason: 'too_large' });
      expect(progress).toEqual([]);
      dirsGone();
    });

    it('архив: тело больше предела при любом заголовке → too_large; ровно предел — нет', async () => {
      const archive = await makeArchive();
      const deps = { limits: { archiveBytes: archive.length - 1 } };
      const over = await start(
        fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }),
        deps,
      ).done;
      expect(over).toEqual({ ok: false, reason: 'too_large' });
      dirsGone();
      const exact = await start(
        fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }),
        {
          limits: { archiveBytes: archive.length },
        },
      ).done;
      expect(exact.ok).toBe(true);
    });

    it('диск: каталог загрузки уже есть → disk, чужой каталог не тронут и не удалён', async () => {
      await mkdir(input.downloadDir, { recursive: true });
      await writeFile(path.join(input.downloadDir, 'keep'), 'x');
      const outcome = await start(fetchOf({ manifest: ok(''), archive: ok('') })).done;
      expect(outcome).toEqual({ ok: false, reason: 'disk' });
      expect(await readdir(input.downloadDir)).toEqual(['keep']);
      expect(requests).toEqual([]);
    });

    it('диск: каталог подготовки уже есть → disk; свой каталог загрузки убран, чужой каталог цел', async () => {
      await mkdir(input.stagingDir);
      await writeFile(path.join(input.stagingDir, 'keep'), 'x');
      const outcome = await start(fetchOf({ manifest: ok(''), archive: ok('') })).done;
      expect(outcome).toEqual({ ok: false, reason: 'disk' });
      expect(existsSync(input.downloadDir)).toBe(false);
      expect(await readdir(input.stagingDir)).toEqual(['keep']);
      expect(requests).toEqual([]);
    });
  });

  describe('SU-07: отмена', () => {
    it('во время загрузки → cancelled, каталоги удалены, запрос оборван', async () => {
      const body = controlledBody();
      const attempt = start(
        fetchOf({ manifest: ok(manifestFor('x')), archive: () => body.response }),
      );
      await vi.waitFor(() => expect(progress.length).toBe(1));
      body.push('abc');
      await flush();
      expect(existsSync(input.downloadDir)).toBe(true);
      await attempt.cancel();
      dirsGone();
      expect(await attempt.done).toEqual({ ok: false, reason: 'cancelled' });
      expect(requests[1]?.init.signal.aborted).toBe(true);
    });

    it('во время запроса манифеста, который не отвечает → cancelled', async () => {
      const attempt = start(
        fetchOf({ manifest: () => new Promise<Response>(() => {}), archive: ok('') }),
      );
      await vi.waitFor(() => expect(requests.length).toBe(1));
      await attempt.cancel();
      expect(await attempt.done).toEqual({ ok: false, reason: 'cancelled' });
      dirsGone();
    });

    it('во время распаковки: процесс убит, каталоги удалены только после его конца', async () => {
      const archive = await makeArchive();
      const events: string[] = [];
      const gate = gatedProcess(events);
      const run: AttemptDeps['run'] = (command, args) => {
        if (command !== '/usr/bin/ditto') return spawnRun(command, args);
        events.push('ditto');
        return gate.process;
      };
      const attempt = start(fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }), {
        run,
      });
      await vi.waitFor(() => expect(events).toContain('ditto'));

      const cancelling = attempt.cancel();
      await vi.waitFor(() => expect(events).toContain('kill'));
      // Процесс ещё не закончился: каталоги на месте, отмена и `done` не завершились.
      await flush(80);
      expect(existsSync(input.stagingDir)).toBe(true);
      expect(existsSync(input.downloadDir)).toBe(true);
      expect(await stillPending(attempt.done)).toBe(true);

      gate.finish(null);
      await cancelling;
      dirsGone();
      expect(await attempt.done).toEqual({ ok: false, reason: 'cancelled' });
    });

    it('после отмены новые процессы не запускаются', async () => {
      const archive = await makeArchive();
      const gate = gatedProcess([]);
      const spawned: string[] = [];
      const run: AttemptDeps['run'] = (command, args) => {
        spawned.push(command);
        return command === '/usr/bin/ditto' ? gate.process : spawnRun(command, args);
      };
      const attempt = start(fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }), {
        run,
      });
      await vi.waitFor(() => expect(spawned).toEqual(['/usr/bin/ditto']));
      const cancelling = attempt.cancel();
      // Ditto «закончился успешно», но попытка отменена: проверка приложения не стартует.
      gate.finish(0);
      await cancelling;
      expect(spawned).toEqual(['/usr/bin/ditto']);
      dirsGone();
    });

    it('новая попытка той же версии, начатая сразу, идёт в своих каталогах и доходит до готовности', async () => {
      const archive = await makeArchive();
      const gate = gatedProcess([]);
      let first = true;
      const run: AttemptDeps['run'] = (command, args) => {
        if (command === '/usr/bin/ditto' && first) {
          first = false;
          return gate.process;
        }
        return spawnRun(command, args);
      };
      const fetch = fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) });
      const a = start(fetch, { run });
      await vi.waitFor(() => expect(first).toBe(false));
      const cancellingA = a.cancel();

      const second: Partial<AttemptInput> = {
        downloadDir: path.join(root, 'home', 'desktop', 'updates', '2'),
        stagingDir: path.join(root, 'apps', '.Parley.app.update-100-2'),
      };
      const b = start(fetch, { run }, second);
      const outcomeB = await b.done;
      expect(outcomeB).toEqual({
        ok: true,
        stagedApp: path.join(second.stagingDir as string, 'Parley.app'),
      });

      // Каталоги отменённой попытки A ещё не убраны (её процесс не кончился), каталоги B целы.
      expect(existsSync(input.stagingDir)).toBe(true);
      gate.finish(null);
      await cancellingA;
      dirsGone();
      expect(
        existsSync(
          path.join(second.stagingDir as string, 'Parley.app', 'Contents', 'MacOS', 'Parley'),
        ),
      ).toBe(true);
    });

    it('после готовности cancel убирает подготовленное приложение; повторный вызов безвреден', async () => {
      const archive = await makeArchive();
      const attempt = start(fetchOf({ manifest: ok(manifestFor(archive)), archive: ok(archive) }));
      expect((await attempt.done).ok).toBe(true);
      expect(existsSync(input.stagingDir)).toBe(true);
      const first = attempt.cancel();
      expect(attempt.cancel()).toBe(first);
      await first;
      dirsGone();
    });

    it('после отказа cancel ничего не делает с чужими каталогами', async () => {
      const attempt = start(fetchOf({ manifest: ok('garbage'), archive: ok('') }));
      expect((await attempt.done).ok).toBe(false);
      await mkdir(input.stagingDir);
      await attempt.cancel();
      expect(existsSync(input.stagingDir)).toBe(true);
    });
  });
});
