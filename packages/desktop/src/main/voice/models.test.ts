import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS_MODELS, type TtsModel } from '../../shared/tts-types.js';
import type { VoiceModel } from '../../shared/voice-types.js';
import { createModelStore, ttsModelsDir, voiceModelsDir, type ModelStoreDeps } from './models.js';

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

const TTS_CONTENT = Buffer.from('fake qwen3 tts gguf bytes');
const TTS_URL = `https://huggingface.co/acme/tts-gguf/resolve/${'a'.repeat(40)}/tts.gguf`;
const TTS_CATALOG: readonly TtsModel[] = [
  {
    id: 'qwen3-tts-0.6b-q8_0',
    file: 'tts.gguf',
    bytes: TTS_CONTENT.length,
    sha256: createHash('sha256').update(TTS_CONTENT).digest('hex'),
    url: TTS_URL,
  },
];

function ttsStore(overrides: Partial<ModelStoreDeps<TtsModel>> = {}) {
  return createModelStore({ dir, catalog: TTS_CATALOG, fetch: () => ok(TTS_CONTENT), freeBytes: async () => 10 ** 12, ...overrides });
}

describe('ttsModelsDir', () => {
  it('~/.parley/desktop/voice/tts от дома Parley', () => {
    expect(ttsModelsDir('/home/p')).toBe(path.join('/home/p', 'desktop', 'voice', 'tts'));
  });
});

describe('createModelStore с моделью TTS (план 3b, B04, E5)', () => {
  it('качает по адресу модели, проверяет sha256, файл на месте, модель в списке', async () => {
    const fetch = vi.fn<ModelStoreDeps['fetch']>(() => ok(TTS_CONTENT));
    const progress = vi.fn();
    const models = ttsStore({ fetch });
    await expect(models.download('qwen3-tts-0.6b-q8_0', progress)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(TTS_URL, expect.anything());
    expect(progress).toHaveBeenLastCalledWith({
      id: 'qwen3-tts-0.6b-q8_0',
      receivedBytes: TTS_CONTENT.length,
      totalBytes: TTS_CONTENT.length,
    });
    expect(await readdir(dir)).toEqual(['tts.gguf']);
    await expect(models.list()).resolves.toEqual(['qwen3-tts-0.6b-q8_0']);
    expect(models.path('qwen3-tts-0.6b-q8_0')).toBe(path.join(dir, 'tts.gguf'));
  });

  it('пока поток идёт, байты лежат в .part, а готового файла нет', async () => {
    let release = (): void => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(TTS_CONTENT.subarray(0, 4));
        release = () => {
          controller.enqueue(TTS_CONTENT.subarray(4));
          controller.close();
        };
      },
    });
    const models = ttsStore({ fetch: () => Promise.resolve(new Response(body)) });
    const pending = models.download('qwen3-tts-0.6b-q8_0', vi.fn());
    await vi.waitFor(async () => expect(await readdir(dir)).toEqual(['tts.gguf.part']));
    await expect(models.list()).resolves.toEqual([]);
    release();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(await readdir(dir)).toEqual(['tts.gguf']);
  });

  it('sha256 не совпал — corrupted, ничего не осталось', async () => {
    const models = ttsStore({ fetch: () => ok(Buffer.from('evil qwen3 tts gguf bytes')) });
    await expect(models.download('qwen3-tts-0.6b-q8_0', vi.fn())).resolves.toEqual({ error: 'corrupted' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('места меньше размера + 10 % — disk_full, fetch не зовётся', async () => {
    const fetch = vi.fn();
    const models = ttsStore({ fetch, freeBytes: async () => TTS_CONTENT.length });
    await expect(models.download('qwen3-tts-0.6b-q8_0', vi.fn())).resolves.toEqual({
      error: 'disk_full',
      needBytes: Math.ceil(TTS_CONTENT.length * 1.1),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancel — cancelled, .part удалён', async () => {
    let started = false;
    const fetch: ModelStoreDeps['fetch'] = (_url, init) =>
      new Promise((_resolve, reject) => {
        started = true;
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const models = ttsStore({ fetch });
    const pending = models.download('qwen3-tts-0.6b-q8_0', vi.fn());
    await vi.waitFor(() => expect(started).toBe(true));
    models.cancel('qwen3-tts-0.6b-q8_0');
    await expect(pending).resolves.toEqual({ error: 'cancelled' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('настоящий каталог: место считается от 1,21 ГБ, запрос идёт на закреплённый адрес', async () => {
    const [model] = TTS_MODELS;
    if (model === undefined) throw new Error('empty TTS catalog');
    const fetch = vi.fn<ModelStoreDeps['fetch']>(() => ok(Buffer.from('not the model')));
    const tight = createModelStore({ dir, catalog: TTS_MODELS, fetch, freeBytes: async () => model.bytes });
    await expect(tight.download(model.id, vi.fn())).resolves.toEqual({ error: 'disk_full', needBytes: Math.ceil(model.bytes * 1.1) });
    expect(fetch).not.toHaveBeenCalled();
    const roomy = createModelStore({ dir, catalog: TTS_MODELS, fetch, freeBytes: async () => 10 ** 12 });
    await expect(roomy.download(model.id, vi.fn())).resolves.toEqual({ error: 'corrupted' });
    expect(fetch).toHaveBeenCalledWith(model.url, expect.anything());
    expect(await readdir(dir)).toEqual([]);
  });
});
