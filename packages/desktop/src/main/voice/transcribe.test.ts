import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscribeRequest } from '../../shared/voice-types.js';
import { createTranscriber, killRunningEngines, removeStaleRecordings, runEngine, transcribeTimeoutMs, whisperArgs, WAV_PREFIX, type RunEngine, type TranscriberDeps } from './transcribe.js';

const ENGINE = { bin: '/e/whisper-cli', vadModel: '/e/vad.bin' };
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-voice-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Секунда тишины: 16 000 сэмплов Int16. */
const request = (overrides: Partial<TranscribeRequest> = {}): TranscribeRequest => ({
  pcm: new ArrayBuffer(32_000),
  language: 'ru',
  model: 'small',
  ...overrides,
});

function deps(run: RunEngine, overrides: Partial<TranscriberDeps> = {}): TranscriberDeps {
  return {
    engine: () => ENGINE,
    modelPath: (id) => `/models/ggml-${id}.bin`,
    exists: async () => true,
    run,
    tmpDir: dir,
    log: vi.fn(),
    ...overrides,
  };
}

describe('whisperArgs', () => {
  it('модель, файл, язык, без таймстемпов и журнала, VAD', () => {
    expect(whisperArgs(ENGINE, { model: '/m.bin', wav: '/t.wav', language: 'auto' })).toEqual([
      '-m', '/m.bin', '-f', '/t.wav', '-l', 'auto', '-nt', '-np', '-sns', '--vad', '-vm', '/e/vad.bin',
    ]);
  });

  it('таймаут — 60 с плюс длина записи', () => {
    expect(transcribeTimeoutMs(15_000)).toBe(75_000);
  });
});

describe('createTranscriber (спека 4.2, 6.4)', () => {
  it('успех: WAV во временной папке, текст через фильтр, WAV удалён', async () => {
    let seenArgs: string[] = [];
    const run: RunEngine = async (_bin, args) => {
      seenArgs = args;
      const wav = args[args.indexOf('-f') + 1] as string;
      expect(path.basename(wav).startsWith(WAV_PREFIX)).toBe(true);
      expect((await readdir(dir)).length).toBe(1);
      return { code: 0, stdout: ' Привет, мир\n', stderr: '', timedOut: false };
    };
    const transcribe = createTranscriber(deps(run));
    await expect(transcribe(request())).resolves.toEqual({ text: 'Привет, мир' });
    expect(seenArgs).toContain('/models/ggml-small.bin');
    expect(seenArgs.slice(seenArgs.indexOf('-l'), seenArgs.indexOf('-l') + 2)).toEqual(['-l', 'ru']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('нет движка — engine_missing, ничего не запускается', async () => {
    const run = vi.fn<RunEngine>();
    await expect(createTranscriber(deps(run, { engine: () => null }))(request())).resolves.toEqual({ error: 'engine_missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('файла модели нет (удалён руками) — model_missing, движок не запускается', async () => {
    const run = vi.fn<RunEngine>();
    await expect(createTranscriber(deps(run, { exists: async () => false }))(request())).resolves.toEqual({ error: 'model_missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('ненулевой код — failed, stderr в журнал, WAV удалён', async () => {
    const log = vi.fn();
    const run: RunEngine = async () => ({ code: 3, stdout: '', stderr: 'boom', timedOut: false });
    await expect(createTranscriber(deps(run, { log }))(request())).resolves.toEqual({ error: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(await readdir(dir)).toEqual([]);
  });

  it('таймаут — failed; таймаут считается от длины записи', async () => {
    let timeout = 0;
    const run: RunEngine = async (_bin, _args, ms) => {
      timeout = ms;
      return { code: null, stdout: '', stderr: '', timedOut: true };
    };
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'failed' });
    expect(timeout).toBe(61_000);
  });

  it('тишина и галлюцинация — no_speech', async () => {
    const run: RunEngine = async () => ({ code: 0, stdout: 'Продолжение следует...\n', stderr: '', timedOut: false });
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'no_speech' });
  });

  it('запуск бросил — failed, WAV удалён', async () => {
    const run: RunEngine = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'failed' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('runEngine', () => {
  it('killRunningEngines завершает запущенный движок: выход приложения не оставляет whisper-cli сиротой', async () => {
    const started = Date.now();
    const pending = runEngine('/bin/sleep', ['30'], 60_000);
    killRunningEngines();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('stdout ограничен хвостом, как stderr', async () => {
    const result = await runEngine('/usr/bin/yes', ['x'.repeat(1000)], 500);
    expect(result.timedOut).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(256_000);
  });
});

describe('removeStaleRecordings', () => {
  it('удаляет только parley-voice-*.wav', async () => {
    await writeFile(path.join(dir, `${WAV_PREFIX}old.wav`), '');
    await writeFile(path.join(dir, 'other.wav'), '');
    await removeStaleRecordings(dir);
    expect(await readdir(dir)).toEqual(['other.wav']);
  });
});
