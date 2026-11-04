import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceModel } from '../../shared/voice-types.js';
import { createModelStore, removeLegacyTtsDir, voiceModelsDir, type ModelStoreDeps } from './models.js';

const CONTENT = Buffer.from('fake whisper model bytes');
const CATALOG: readonly VoiceModel[] = [
  { id: 'base', file: 'ggml-base.bin', bytes: CONTENT.length, sha256: createHash('sha256').update(CONTENT).digest('hex') },
  { id: 'small', file: 'ggml-small.bin', bytes: 4, sha256: '0'.repeat(64) },
];
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-models-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (body: Uint8Array): Promise<Response> => Promise.resolve(new Response(body));

function store(overrides: Partial<ModelStoreDeps> = {}) {
  return createModelStore({ dir, catalog: CATALOG, fetch: () => ok(CONTENT), freeBytes: async () => 10 ** 12, ...overrides });
}

describe('voiceModelsDir', () => {
  it('~/.parley/desktop/voice/models от дома Parley', () => {
    expect(voiceModelsDir('/home/p')).toBe(path.join('/home/p', 'desktop', 'voice', 'models'));
  });
});

describe('createModelStore (спека 4.2, 6.2)', () => {
  it('скачивание: прогресс, проверка sha256, файл на месте, .part нет, модель в списке', async () => {
    const progress = vi.fn();
    const models = store();
    await expect(models.download('base', progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenLastCalledWith({ id: 'base', receivedBytes: CONTENT.length, totalBytes: CONTENT.length });
    expect(await readdir(dir)).toEqual(['ggml-base.bin']);
    await expect(models.list()).resolves.toEqual(['base']);
  });

  it('sha256 не совпал — corrupted, ничего не осталось', async () => {
    const models = store({ fetch: () => ok(Buffer.from('evil')) });
    await expect(models.download('small', vi.fn())).resolves.toEqual({ error: 'corrupted' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('ответ не 200 — network', async () => {
    const models = store({ fetch: () => Promise.resolve(new Response('no', { status: 404 })) });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'network' });
  });

  it('обрыв посреди потока — network, .part удалён', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(CONTENT.subarray(0, 4));
        controller.error(new Error('ECONNRESET'));
      },
    });
    const models = store({ fetch: () => Promise.resolve(new Response(body)) });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'network' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('места меньше размера + 10 % — disk_full с нужным числом байт, fetch не зовётся', async () => {
    const fetch = vi.fn();
    const models = store({ fetch, freeBytes: async () => 1 });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'disk_full', needBytes: Math.ceil(CONTENT.length * 1.1) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancel — cancelled, .part удалён', async () => {
    let started = false;
    const fetch: ModelStoreDeps['fetch'] = (_url, init) =>
      new Promise((_resolve, reject) => {
        started = true;
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const models = store({ fetch });
    const pending = models.download('base', vi.fn());
    // Отмена — когда запрос уже ушёл: до fetch идут mkdir и проверка места.
    await vi.waitFor(() => expect(started).toBe(true));
    models.cancel('base');
    await expect(pending).resolves.toEqual({ error: 'cancelled' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('повторный download той же модели — тот же промис, fetch один раз (Фокус ревью, 3)', async () => {
    const fetch = vi.fn(() => ok(CONTENT));
    const models = store({ fetch });
    const [first, second] = await Promise.all([models.download('base', vi.fn()), models.download('base', vi.fn())]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('list не видит .part и файлы чужого размера; remove удаляет файл', async () => {
    await writeFile(path.join(dir, 'ggml-base.bin.part'), 'x');
    await writeFile(path.join(dir, 'ggml-small.bin'), 'too long for small');
    const models = store();
    await expect(models.list()).resolves.toEqual([]);
    await models.download('base', vi.fn());
    await models.remove('base');
    await expect(models.list()).resolves.toEqual([]);
  });
});

describe('removeLegacyTtsDir (S-del)', () => {
  it('удаляет только desktop/voice/tts вместе с .part; модели Whisper целы', async () => {
    const voice = path.join(dir, 'desktop', 'voice');
    await mkdir(path.join(voice, 'tts'), { recursive: true });
    await mkdir(path.join(voice, 'models'), { recursive: true });
    await writeFile(path.join(voice, 'tts', 'Qwen-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf'), 'weights');
    await writeFile(path.join(voice, 'tts', 'Qwen-TTS-12Hz-1.7B-CustomVoice-Q8_0.gguf.part'), 'partial');
    await writeFile(path.join(voice, 'models', 'ggml-base.bin'), 'whisper');
    await writeFile(path.join(voice, 'other.txt'), 'x');

    await expect(removeLegacyTtsDir(dir)).resolves.toBe(true);

    expect(await readdir(voice)).toEqual(['models', 'other.txt']);
    expect(await readdir(path.join(voice, 'models'))).toEqual(['ggml-base.bin']);
  });

  it('повторный запуск и чистый дом ничего не делают', async () => {
    await expect(removeLegacyTtsDir(dir)).resolves.toBe(false);
    await mkdir(path.join(dir, 'desktop', 'voice', 'tts'), { recursive: true });
    await expect(removeLegacyTtsDir(dir)).resolves.toBe(true);
    await expect(removeLegacyTtsDir(dir)).resolves.toBe(false);
    expect(await readdir(path.join(dir, 'desktop', 'voice'))).toEqual([]);
  });
});
