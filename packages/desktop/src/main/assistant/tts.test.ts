import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttsAvailable } from '../../shared/island.js';
import { TTS_VOICES, type TtsModelId } from '../../shared/tts-types.js';
import type { ModelStore } from '../voice/models.js';
import {
  createSpeechWorker,
  type SpeechChild,
  type SpeechWorker,
  type SpeechWorkerStatus,
  type SynthesizeOptions,
  type SynthesizeRequest,
} from './speech-worker.js';
import {
  AUDIBLE_RMS,
  createFakeTtsService,
  createLimiter,
  createTtsService,
  IDLE_UNLOAD_MS,
  isAudible,
  PEAK_LIMIT,
  type TtsChunk,
  type TtsService,
  type TtsServiceDeps,
} from './tts.js';

const SMALL: TtsModelId = 'qwen3-tts-0.6b-q8_0';
const LARGE: TtsModelId = 'qwen3-tts-1.7b-q8_0';
const SERENA = TTS_VOICES.find((voice) => voice.id === 'qwen3-0.6b/serena')!;
const RATE = 24_000;

/** Поток кусков одного запроса: тест толкает, служба тянет (как `Channel` клиента B05). */
class FakeStream implements AsyncIterableIterator<Float32Array> {
  private readonly items: Float32Array[] = [];
  private waiter: ((result: IteratorResult<Float32Array>) => void) | null = null;
  done = false;

  push(item: Float32Array): void {
    if (this.done) return;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter === null) this.items.push(item);
    else waiter({ done: false, value: item });
  }

  end(): void {
    this.done = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<Float32Array>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => (this.waiter = resolve));
  }

  return(): Promise<IteratorResult<Float32Array>> {
    this.done = true;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Float32Array> {
    return this;
  }
}

interface FakeRequest {
  request: SynthesizeRequest;
  options: SynthesizeOptions;
  stream: FakeStream;
}

/** Поддельный клиент worker: `start` по умолчанию сразу даёт `ready`, `cancel` только записывается. */
function fakeWorker(options: { holdStart?: boolean } = {}) {
  let status: SpeechWorkerStatus = { state: 'stopped' };
  let release: ((next: SpeechWorkerStatus) => void) | null = null;
  const requests: FakeRequest[] = [];
  const calls = { start: 0, close: 0, stop: 0, cancel: [] as string[] };
  const worker: SpeechWorker = {
    status: () => status,
    start() {
      calls.start += 1;
      if (status.state === 'ready' || status.state === 'unavailable') return Promise.resolve(status);
      status = { state: 'starting' };
      return new Promise((resolve) => {
        release = (next) => {
          status = next;
          resolve(next);
        };
        if (options.holdStart !== true) release({ state: 'ready', sampleRate: RATE });
      });
    },
    synthesize(request, synthOptions = {}) {
      const stream = new FakeStream();
      requests.push({ request, options: synthOptions, stream });
      return stream;
    },
    cancel(id) {
      calls.cancel.push(id);
    },
    async close() {
      calls.close += 1;
      status = { state: 'stopped' };
    },
    stop() {
      calls.stop += 1;
      status = { state: 'stopped' };
    },
  };
  return {
    worker,
    requests,
    calls,
    ready: () => release?.({ state: 'ready', sampleRate: RATE }),
    last: (): FakeRequest => requests[requests.length - 1]!,
  };
}

/** Хранилище весов: `initial` — какие модели уже скачаны (по умолчанию одна 0.6B). */
function fakeModels(initial: TtsModelId[] = [SMALL]) {
  const state = { ids: [...initial] };
  const store: ModelStore<TtsModelId> = {
    list: async () => [...state.ids],
    path: () => '/tts/model.gguf',
    download: vi.fn(async (id: TtsModelId, onProgress) => {
      onProgress({ id, receivedBytes: 10, totalBytes: 10 });
      if (!state.ids.includes(id)) state.ids.push(id);
      return { ok: true as const };
    }),
    cancel: vi.fn(),
    remove: vi.fn(async (id: TtsModelId) => {
      state.ids = state.ids.filter((entry) => entry !== id);
    }),
  };
  return { store, state };
}

function service(overrides: Partial<TtsServiceDeps> & { workers?: SpeechWorker[] } = {}) {
  const fake = fakeWorker();
  const workers = overrides.workers ?? [fake.worker];
  let created = 0;
  const createWorker = vi.fn<TtsServiceDeps['createWorker']>(() => workers[Math.min(created++, workers.length - 1)]!);
  const tts = createTtsService({
    supported: true,
    models: fakeModels().store,
    createWorker,
    log: () => undefined,
    ...overrides,
  });
  return { tts, fake, createWorker };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const loud = (n = 480, value = 0.3): Float32Array => new Float32Array(n).fill(value);
/** −60 dBFS: ниже порога слышимости −40 dBFS. */
const hush = (n = 480): Float32Array => new Float32Array(n).fill(0.001);
const peak = (pcm: Float32Array): number => pcm.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
const request = (utteranceId = 'u1', language = 'ru') => ({ utteranceId, text: 'Привет.', voice: SERENA.id, language });

function collect(): { sink: (chunk: TtsChunk) => void; chunks: TtsChunk[] } {
  const chunks: TtsChunk[] = [];
  return { sink: (chunk) => chunks.push(chunk), chunks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isAudible (Р4а)', () => {
  it('кусок слышим, если хоть один кадр 20 мс громче −40 dBFS', () => {
    expect(isAudible(new Float32Array(2400), RATE)).toBe(false);
    expect(isAudible(hush(2400), RATE)).toBe(false);
    const late = hush(2400);
    late.fill(0.05, 1920);
    expect(isAudible(late, RATE)).toBe(true);
    expect(isAudible(loud(10, AUDIBLE_RMS * 1.01), RATE)).toBe(true);
  });
});

describe('createLimiter (Р4)', () => {
  it('усиление голоса и пик ≤ −1 dBFS без клиппинга на заданном буфере', () => {
    const buffer = new Float32Array(4800).map((_, i) => 0.8 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    const out = createLimiter(RATE)(buffer, 2.419);
    expect(PEAK_LIMIT).toBeCloseTo(10 ** (-1 / 20), 6);
    expect(peak(out)).toBeLessThanOrEqual(PEAK_LIMIT + 1e-6);
    expect(peak(out)).toBeGreaterThan(PEAK_LIMIT * 0.99);
    // Тихий буфер только усиливается.
    const quiet = loud(480, 0.1);
    expect(createLimiter(RATE)(quiet, 1.592)[0]).toBeCloseTo(0.1592, 5);
  });

  it('огибающая переходит из куска в кусок: после пика следующий кусок ещё прижат и отпускается за ~50 мс', () => {
    const limiter = createLimiter(RATE);
    limiter(loud(480, 0.9), 2);
    const next = limiter(loud(4800, 0.4), 1);
    expect(next[0]).toBeLessThan(0.4 * 0.6);
    expect(next[0]).toBeCloseTo(PEAK_LIMIT / 1.8 * 0.4, 2);
    // Через 200 мс (четыре постоянных времени) — почти без ослабления.
    expect(next[4799]).toBeGreaterThan(0.39);
    // Новый ограничитель (новое предложение) кусок не трогает.
    expect(createLimiter(RATE)(loud(10, 0.4), 1)[0]).toBeCloseTo(0.4, 6);
  });
});

describe('createTtsService: поток кусков', () => {
  it('E1: первый кусок уходит в sink до конца синтеза; gain голоса, seq по порядку, final — пустой кусок', async () => {
    const { tts, fake } = service();
    const { sink, chunks } = collect();
    const done = tts.speak(request(), sink);
    await flush();
    expect(fake.requests).toHaveLength(1);
    expect(fake.last().request).toMatchObject({ text: 'Привет.', voice: 'serena', language: 'ru' });
    fake.last().stream.push(loud(480, 0.1));
    await flush();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ utteranceId: 'u1', seq: 0, sampleRate: RATE, channels: 1, format: 'f32', final: false });
    expect(chunks[0]!.pcm[0]).toBeCloseTo(0.1 * SERENA.gain, 5);
    expect(tts.state()).toEqual({ state: 'speaking' });
    fake.last().stream.push(loud(480, 0.1));
    fake.last().stream.end();
    await expect(done).resolves.toEqual({ state: 'ready' });
    expect(chunks.map((chunk) => [chunk.seq, chunk.final, chunk.pcm.length])).toEqual([
      [0, false, 480],
      [1, false, 480],
      [2, true, 0],
    ]);
    expect(tts.state()).toEqual({ state: 'ready' });
  });

  it('E1/Р4а: куски ведущей тишины ниже порога не уходят, первый отправленный слышим; паузы после голоса уходят', async () => {
    const { tts, fake } = service();
    const { sink, chunks } = collect();
    const done = tts.speak(request(), sink);
    await flush();
    const { stream } = fake.last();
    stream.push(new Float32Array(480));
    stream.push(hush());
    stream.push(loud());
    stream.push(new Float32Array(480));
    stream.end();
    await done;
    expect(chunks).toHaveLength(3);
    expect(isAudible(chunks[0]!.pcm, RATE)).toBe(true);
    expect(chunks[0]!.seq).toBe(0);
    expect(peak(chunks[1]!.pcm)).toBe(0);
    expect(chunks[2]!.final).toBe(true);
  });

  it('предложения синтезируются по очереди: второе уходит в worker только после конца первого', async () => {
    const { tts, fake } = service();
    const first = collect();
    const second = collect();
    const a = tts.speak(request('u1'), first.sink);
    const b = tts.speak(request('u2'), second.sink);
    await flush();
    expect(fake.requests).toHaveLength(1);
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await a;
    await flush();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.request.id).not.toBe(fake.requests[1]!.request.id);
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await b;
    expect(first.chunks.every((chunk) => chunk.utteranceId === 'u1')).toBe(true);
    expect(second.chunks.map((chunk) => [chunk.utteranceId, chunk.seq])).toEqual([
      ['u2', 0],
      ['u2', 1],
    ]);
  });
});

describe('createTtsService: срыв по длине (страж E2, решение интегратора по m-1448)', () => {
  it('срыв посреди предложения: onDiscard с первым seq попытки, её куски дальше не идут, повтор — со старшими seq', async () => {
    const { tts, fake } = service();
    const { sink, chunks } = collect();
    const onDiscard = vi.fn();
    const done = tts.speak(request(), sink, { onDiscard });
    await flush();
    const { stream, options } = fake.last();
    stream.push(loud());
    stream.push(loud());
    await flush();
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
    // Кусок попытки уже отдан ожидающей службе, и в том же такте приходит `end` со `stop: max_seconds`.
    stream.push(loud(480, 0.2));
    options.onRunaway?.();
    expect(onDiscard).toHaveBeenCalledWith('u1', 0);
    await flush();
    expect(chunks).toHaveLength(2);
    // Повтор с новым seed: ведущая тишина снова срезается.
    stream.push(hush());
    stream.push(loud(480, 0.05));
    stream.push(loud(480, 0.05));
    stream.end();
    await done;
    expect(chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    expect(chunks[2]!.pcm[0]).toBeCloseTo(0.05 * SERENA.gain, 5);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('второй срыв: onDiscard с первым seq повтора, предложение кончается пустым final', async () => {
    const { tts, fake } = service();
    const { sink, chunks } = collect();
    const onDiscard = vi.fn();
    const done = tts.speak(request(), sink, { onDiscard });
    await flush();
    const { stream, options } = fake.last();
    stream.push(loud());
    await flush();
    options.onRunaway?.();
    await flush();
    stream.push(loud());
    stream.push(loud());
    await flush();
    options.onRunaway?.();
    stream.end();
    await done;
    expect(onDiscard.mock.calls).toEqual([
      ['u1', 0],
      ['u1', 1],
    ]);
    expect(chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true],
    ]);
  });
});

describe('createTtsService: отмена (E3)', () => {
  it('cancel останавливает поток: cancel уходит в worker, кусков после него нет, даже final', async () => {
    const { tts, fake } = service();
    const { sink, chunks } = collect();
    const done = tts.speak(request(), sink);
    await flush();
    fake.last().stream.push(loud());
    await flush();
    tts.cancel('u1');
    expect(fake.calls.cancel).toEqual([fake.last().request.id]);
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await done;
    expect(chunks).toHaveLength(1);
  });

  it('cancel предложения в очереди: в worker оно не уходит; cancelAll снимает текущее и очередь', async () => {
    const { tts, fake } = service();
    const sinks = [collect(), collect(), collect()];
    const a = tts.speak(request('u1'), sinks[0]!.sink);
    const b = tts.speak(request('u2'), sinks[1]!.sink);
    const c = tts.speak(request('u3'), sinks[2]!.sink);
    tts.cancel('u2');
    await flush();
    fake.last().stream.end();
    await a;
    await b;
    await flush();
    expect(fake.requests.map((entry) => entry.request.text)).toHaveLength(2);
    tts.cancelAll();
    expect(fake.calls.cancel).toEqual([fake.last().request.id]);
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await c;
    expect(sinks[1]!.chunks).toEqual([]);
    expect(sinks[2]!.chunks).toEqual([]);
  });
});

describe('createTtsService: голоса нет (Р8)', () => {
  it('язык без голоса — сразу пустой final и unavailable, worker не создаётся', async () => {
    const { tts, createWorker } = service();
    const { sink, chunks } = collect();
    const state = await tts.speak(request('u1', 'uk'), sink);
    expect(state).toMatchObject({ state: 'unavailable' });
    expect(chunks.map((chunk) => [chunk.seq, chunk.final, chunk.pcm.length])).toEqual([[0, true, 0]]);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('x64 — unavailable, worker не создаётся', async () => {
    const { tts, createWorker } = service({ supported: false });
    const { sink, chunks } = collect();
    await expect(tts.speak(request(), sink)).resolves.toMatchObject({ state: 'unavailable' });
    expect(tts.state()).toMatchObject({ state: 'unavailable' });
    expect(chunks).toHaveLength(1);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('веса не скачаны — not-downloaded, пустой final, ничего не качается само', async () => {
    const models = fakeModels([]);
    const { tts, createWorker } = service({ models: models.store });
    const { sink, chunks } = collect();
    await expect(tts.speak(request(), sink)).resolves.toEqual({ state: 'not-downloaded' });
    expect(chunks.map((chunk) => chunk.final)).toEqual([true]);
    expect(createWorker).not.toHaveBeenCalled();
    expect(models.store.download).not.toHaveBeenCalled();
    expect(tts.state()).toEqual({ state: 'not-downloaded' });
  });
});

describe('createTtsService: выгрузка и прогрев', () => {
  it('E4: через 15 мин простоя worker закрывается; следующий speak снова его запускает', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { tts, fake, createWorker } = service();
    const first = tts.speak(request('u1'), () => undefined);
    await flush();
    fake.last().stream.end();
    await first;
    vi.advanceTimersByTime(IDLE_UNLOAD_MS - 1000);
    expect(fake.calls.close).toBe(0);
    // Синтез сдвигает простой.
    const second = tts.speak(request('u2'), () => undefined);
    await flush();
    fake.last().stream.end();
    await second;
    vi.advanceTimersByTime(IDLE_UNLOAD_MS - 1000);
    expect(fake.calls.close).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(fake.calls.close).toBe(1);
    expect(fake.worker.status()).toEqual({ state: 'stopped' });
    const { sink, chunks } = collect();
    const third = tts.speak(request('u3'), sink);
    await flush();
    expect(fake.calls.start).toBe(3);
    expect(fake.worker.status()).toMatchObject({ state: 'ready' });
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await third;
    expect(chunks).toHaveLength(2);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('warmup: warming до ready worker, потом ready; voices — каталог с флагом downloaded', async () => {
    const fake = fakeWorker({ holdStart: true });
    const { tts } = service({ workers: [fake.worker] });
    const warm = tts.warmup();
    await flush();
    expect(tts.state()).toEqual({ state: 'warming' });
    fake.ready();
    await warm;
    expect(tts.state()).toEqual({ state: 'ready' });
    const voices = await tts.voices();
    expect(voices.map((voice) => voice.id)).toEqual(TTS_VOICES.map((voice) => voice.id));
    expect(voices.every((voice) => voice.downloaded)).toBe(true);
  });

  it('E5: после скачивания весов — клиент worker, warming, затем ready; onState сообщает смены', async () => {
    const models = fakeModels([]);
    const fresh = fakeWorker({ holdStart: true });
    const { tts, createWorker } = service({ models: models.store, workers: [fresh.worker] });
    await tts.warmup();
    expect(tts.state()).toEqual({ state: 'not-downloaded' });
    expect((await tts.voices()).some((voice) => voice.downloaded)).toBe(false);
    const states: string[] = [];
    tts.onState((next) => states.push(next.state));
    const progress = vi.fn();
    await expect(tts.download(SMALL, progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith({ id: SMALL, receivedBytes: 10, totalBytes: 10 });
    await flush();
    expect(tts.state()).toEqual({ state: 'warming' });
    fresh.ready();
    await flush();
    expect(tts.state()).toEqual({ state: 'ready' });
    expect(states).toEqual(['warming', 'ready']);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledWith(SMALL);
    expect((await tts.voices()).every((voice) => voice.downloaded)).toBe(true);
  });

  it('два запроса скачивания одной модели разом — одно скачивание и один новый клиент worker (критик m-1471)', async () => {
    const models = fakeModels([]);
    const { tts, createWorker } = service({ models: models.store });
    const [first, second] = await Promise.all([tts.download(SMALL, () => undefined), tts.download(SMALL, () => undefined)]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    await flush();
    expect(models.store.download).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('D5: cancelDownload отменяет скачивание весов именно этой модели в хранилище', () => {
    const models = fakeModels([]);
    const { tts } = service({ models: models.store });
    tts.cancelDownload(LARGE);
    expect(models.store.cancel).toHaveBeenCalledTimes(1);
    expect(models.store.cancel).toHaveBeenCalledWith(LARGE);
  });

  it('D5: remove — речь снята, worker остановлен, файл удалён; дальше not-downloaded, текст, само не качается', async () => {
    const models = fakeModels();
    const { tts, fake, createWorker } = service({ models: models.store });
    await tts.warmup();
    const first = collect();
    const speaking = tts.speak(request('u1'), first.sink);
    await flush();
    await tts.remove(SMALL);
    expect(fake.calls.stop).toBe(1);
    expect(models.store.remove).toHaveBeenCalledWith(SMALL);
    expect(tts.state()).toEqual({ state: 'not-downloaded' });
    expect((await tts.voices()).some((voice) => voice.downloaded)).toBe(false);
    fake.last().stream.end();
    await speaking;
    expect(first.chunks.filter((chunk) => chunk.pcm.length > 0)).toEqual([]);
    const after = collect();
    await expect(tts.speak(request('u2'), after.sink)).resolves.toEqual({ state: 'not-downloaded' });
    expect(after.chunks.map((chunk) => chunk.final)).toEqual([true]);
    expect(models.store.download).not.toHaveBeenCalled();
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});

describe('createTtsService: две модели, говорит самая большая из скачанных', () => {
  /** Идущее предложение: worker держит поток открытым, пока тест не закончит его сам. */
  async function startSpeaking(tts: TtsService, fake: ReturnType<typeof fakeWorker>) {
    const collected = collect();
    const done = tts.speak(request('u1'), collected.sink);
    await flush();
    fake.last().stream.push(loud());
    await flush();
    return { ...collected, done };
  }

  it('скачана только 1.7B — worker создаётся для 1.7B', async () => {
    const { tts, createWorker } = service({ models: fakeModels([LARGE]).store });
    await tts.warmup();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledWith(LARGE);
  });

  it('скачаны обе — worker для 1.7B; только 0.6B — для 0.6B', async () => {
    const both = service({ models: fakeModels([SMALL, LARGE]).store });
    await both.tts.warmup();
    expect(both.createWorker).toHaveBeenCalledWith(LARGE);
    const small = service({ models: fakeModels([SMALL]).store });
    await small.tts.warmup();
    expect(small.createWorker).toHaveBeenCalledWith(SMALL);
  });

  it('голоса скачаны, если есть хоть одна модель; models() — скачанные id', async () => {
    const large = service({ models: fakeModels([LARGE]).store });
    expect((await large.tts.voices()).every((voice) => voice.downloaded)).toBe(true);
    await expect(large.tts.models()).resolves.toEqual([LARGE]);
    const none = service({ models: fakeModels([]).store });
    expect((await none.tts.voices()).some((voice) => voice.downloaded)).toBe(false);
    await expect(none.tts.models()).resolves.toEqual([]);
  });

  it('докачали 1.7B, пока работал worker 0.6B: старый остановлен, следующий создан для 1.7B', async () => {
    const models = fakeModels([SMALL]);
    const small = fakeWorker();
    const large = fakeWorker();
    const { tts, createWorker } = service({ models: models.store, workers: [small.worker, large.worker] });
    await tts.warmup();
    expect(createWorker).toHaveBeenLastCalledWith(SMALL);
    await expect(tts.download(LARGE, () => undefined)).resolves.toEqual({ ok: true });
    await flush();
    expect(small.calls.stop).toBe(1);
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenLastCalledWith(LARGE);
    expect(large.calls.start).toBe(1);
    expect(tts.state()).toEqual({ state: 'ready' });
    const { sink } = collect();
    const next = tts.speak(request('u2'), sink);
    await flush();
    expect(small.requests).toHaveLength(0);
    expect(large.requests).toHaveLength(1);
    large.last().stream.end();
    await next;
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('докачали 0.6B при активной 1.7B: worker не остановлен, речь не отменена, нового worker нет', async () => {
    const models = fakeModels([LARGE]);
    const { tts, fake, createWorker } = service({ models: models.store });
    const speaking = await startSpeaking(tts, fake);
    const states: string[] = [];
    tts.onState((next) => states.push(next.state));
    await expect(tts.download(SMALL, () => undefined)).resolves.toEqual({ ok: true });
    await flush();
    expect(fake.calls.stop).toBe(0);
    expect(fake.calls.cancel).toEqual([]);
    expect(tts.state()).toEqual({ state: 'speaking' });
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await expect(speaking.done).resolves.toEqual({ state: 'ready' });
    expect(speaking.chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledWith(LARGE);
    await expect(tts.models()).resolves.toEqual([LARGE, SMALL]);
    expect(states).not.toContain('warming');
  });

  it('удалили активную 1.7B при скачанной 0.6B: речь отменена, worker остановлен, ready, следующий warmup — worker для 0.6B', async () => {
    const models = fakeModels([SMALL, LARGE]);
    const large = fakeWorker();
    const small = fakeWorker();
    const { tts, createWorker } = service({ models: models.store, workers: [large.worker, small.worker] });
    const speaking = await startSpeaking(tts, large);
    expect(createWorker).toHaveBeenLastCalledWith(LARGE);
    await tts.remove(LARGE);
    expect(large.calls.stop).toBe(1);
    expect(models.store.remove).toHaveBeenCalledWith(LARGE);
    // Поток отменённого предложения кончается — после него куски не уходят, даже final.
    large.last().stream.push(loud());
    large.last().stream.end();
    await speaking.done;
    expect(speaking.chunks).toHaveLength(1);
    expect(tts.state()).toEqual({ state: 'ready' });
    expect((await tts.voices()).every((voice) => voice.downloaded)).toBe(true);
    expect(createWorker).toHaveBeenCalledTimes(1);
    await tts.warmup();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenLastCalledWith(SMALL);
    expect(small.calls.start).toBe(1);
    expect(tts.state()).toEqual({ state: 'ready' });
  });

  it('удалили неактивную 0.6B: worker не остановлен, речь не отменена, файл удалён', async () => {
    const models = fakeModels([SMALL, LARGE]);
    const { tts, fake, createWorker } = service({ models: models.store });
    const speaking = await startSpeaking(tts, fake);
    await tts.remove(SMALL);
    expect(models.store.remove).toHaveBeenCalledTimes(1);
    expect(models.store.remove).toHaveBeenCalledWith(SMALL);
    expect(fake.calls.stop).toBe(0);
    expect(fake.calls.cancel).toEqual([]);
    expect(tts.state()).toEqual({ state: 'speaking' });
    fake.last().stream.push(loud());
    fake.last().stream.end();
    await speaking.done;
    expect(speaking.chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    await expect(tts.models()).resolves.toEqual([LARGE]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('удалили последнюю модель (1.7B при уже удалённой 0.6B) — not-downloaded, голоса не скачаны', async () => {
    const models = fakeModels([LARGE]);
    const { tts, fake } = service({ models: models.store });
    await tts.warmup();
    await tts.remove(LARGE);
    expect(fake.calls.stop).toBe(1);
    expect(tts.state()).toEqual({ state: 'not-downloaded' });
    expect((await tts.voices()).some((voice) => voice.downloaded)).toBe(false);
    await expect(tts.models()).resolves.toEqual([]);
  });

  it('два download одного id — один models.download; разные id — по одному на каждый', async () => {
    const models = fakeModels([]);
    const { tts } = service({ models: models.store });
    await Promise.all([tts.download(LARGE, () => undefined), tts.download(LARGE, () => undefined)]);
    expect(models.store.download).toHaveBeenCalledTimes(1);
    const progress = vi.fn();
    await Promise.all([tts.download(SMALL, progress), tts.download(LARGE, progress)]);
    expect(models.store.download).toHaveBeenCalledTimes(3);
    expect(vi.mocked(models.store.download).mock.calls.map(([id]) => id)).toEqual([LARGE, SMALL, LARGE]);
  });

  it('скачивание одной модели не мешает другой: обе качаются разом, у каждой свой результат', async () => {
    const models = fakeModels([]);
    const results: Record<string, (value: { ok: true } | { error: 'cancelled' }) => void> = {};
    vi.mocked(models.store.download).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          results[id] = (value) => {
            if ('ok' in value) models.state.ids.push(id);
            resolve(value);
          };
        }),
    );
    const { tts } = service({ models: models.store });
    const small = tts.download(SMALL, () => undefined);
    const large = tts.download(LARGE, () => undefined);
    expect(models.store.download).toHaveBeenCalledTimes(2);
    results[LARGE]!({ error: 'cancelled' });
    await expect(large).resolves.toEqual({ error: 'cancelled' });
    expect(tts.state()).toEqual({ state: 'not-downloaded' });
    results[SMALL]!({ ok: true });
    await expect(small).resolves.toEqual({ ok: true });
    await flush();
    expect(tts.state()).toEqual({ state: 'ready' });
  });

  it('набор скачанных сменился без нашего участия (файл появился): следующий прогрев останавливает старый worker и создаёт новый', async () => {
    const models = fakeModels([SMALL]);
    const small = fakeWorker();
    const large = fakeWorker();
    const { tts, createWorker } = service({ models: models.store, workers: [small.worker, large.worker] });
    await tts.warmup();
    models.state.ids.push(LARGE);
    await tts.warmup();
    expect(small.calls.stop).toBe(1);
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenLastCalledWith(LARGE);
    expect(tts.state()).toEqual({ state: 'ready' });
  });
});

/** Минимальный поддельный процесс `speech` для настоящего клиента B05: строки stdout задаёт тест. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { write: (): boolean => true, end: (): void => this.exit(0), on: (): unknown => this.stdin };

  send(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  exit(code: number | null): void {
    this.stdout.once('end', () => this.emit('close', code, null));
    this.stdout.end();
    this.stderr.end();
  }

  kill(): boolean {
    this.exit(null);
    return true;
  }
}

const READY_LINE = JSON.stringify({ type: 'ready', protocol: 3, model: { sample_rate: RATE } });
type Launch = 'ready' | 'spawn-error' | 'exit' | 'protocol' | 'fatal';

/** Служба на настоящем `createSpeechWorker`: каждый запуск процесса ведёт себя по очередному пункту `launches`. */
function realService(launches: Launch[], models = fakeModels()) {
  let spawned = 0;
  const createWorker = vi.fn<TtsServiceDeps['createWorker']>(() =>
    createSpeechWorker({
      bin: () => '/speech/bin/speech',
      model: () => '/tts/model.gguf',
      log: () => undefined,
      spawn: () => {
        const launch = launches[Math.min(spawned, launches.length - 1)]!;
        spawned += 1;
        if (launch === 'spawn-error') throw new Error('EACCES');
        const child = new FakeChild();
        if (launch === 'exit') queueMicrotask(() => child.exit(1));
        if (launch === 'ready') child.send(READY_LINE);
        if (launch === 'protocol') child.send(JSON.stringify({ type: 'ready', protocol: 2 }));
        if (launch === 'fatal') child.send('{"type":"fatal","error":{"code":"model_file","message":"the file is not a model"}}');
        return child as unknown as SpeechChild;
      },
    }),
  );
  const tts = createTtsService({ supported: true, models: models.store, createWorker, log: () => undefined });
  return { tts, createWorker, spawns: () => spawned };
}

describe('createTtsService: unavailable клиента B05 липкий — новый клиент только после временного сбоя или скачивания (m-1448)', () => {
  it.each<Launch>(['spawn-error', 'exit'])('временный сбой (%s): голос остаётся доступным, следующий запуск — новый клиент и ready', async (launch) => {
    const { tts, createWorker, spawns } = realService([launch, 'ready']);
    await tts.warmup();
    expect(tts.state()).toEqual({ state: 'ready' });
    expect(ttsAvailable(tts.state())).toBe(true);
    await tts.warmup();
    expect(tts.state()).toEqual({ state: 'ready' });
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(spawns()).toBe(2);
    tts.stop();
  });

  it('временный сбой при прогреве: следующий speak сам запускает новый клиент (критик m-1463, F2)', async () => {
    const { tts, createWorker } = realService(['exit', 'ready']);
    await tts.warmup();
    expect(ttsAvailable(tts.state())).toBe(true);
    void tts.speak(request(), () => undefined);
    await flush();
    expect(createWorker).toHaveBeenCalledTimes(2);
    tts.stop();
  });

  it('worker падает при каждом запуске — один повтор, дальше недоступен до скачивания (критик m-1457, W3)', async () => {
    const { tts, createWorker } = realService(['exit', 'exit', 'exit', 'ready']);
    await tts.warmup();
    await tts.warmup();
    await tts.warmup();
    expect(tts.state()).toMatchObject({ state: 'unavailable' });
    expect(createWorker).toHaveBeenCalledTimes(2);
    await expect(tts.download(SMALL, () => undefined)).resolves.toEqual({ ok: true });
    await flush();
    expect(createWorker).toHaveBeenCalledTimes(3);
    tts.stop();
  });

  it.each<Launch>(['protocol', 'fatal'])('%s: голос остаётся недоступным, новый клиент не создаётся', async (launch) => {
    const { tts, createWorker, spawns } = realService([launch, 'ready']);
    await tts.warmup();
    expect(tts.state()).toMatchObject({ state: 'unavailable' });
    const { sink, chunks } = collect();
    await expect(tts.speak(request(), sink)).resolves.toMatchObject({ state: 'unavailable' });
    expect(chunks.map((chunk) => chunk.final)).toEqual([true]);
    expect(tts.state()).toMatchObject({ state: 'unavailable' });
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(spawns()).toBe(1);
    tts.stop();
  });

  it('fatal на испорченных весах, затем скачивание: новый клиент и ready', async () => {
    const { tts, createWorker } = realService(['fatal', 'ready']);
    await tts.warmup();
    expect(tts.state()).toMatchObject({ state: 'unavailable' });
    await expect(tts.download(SMALL, () => undefined)).resolves.toEqual({ ok: true });
    await flush();
    expect(tts.state()).toEqual({ state: 'ready' });
    expect(createWorker).toHaveBeenCalledTimes(2);
    tts.stop();
  });
});

describe('createFakeTtsService (PARLEY_TTS=fake)', () => {
  it('отдаёт два куска тишины f32 по 0,2 с, второй — final; голоса скачаны, состояние ready', async () => {
    const tts: TtsService = createFakeTtsService();
    const { sink, chunks } = collect();
    await expect(tts.speak(request(), sink)).resolves.toEqual({ state: 'ready' });
    expect(chunks.map((chunk) => [chunk.utteranceId, chunk.seq, chunk.final, chunk.pcm.length, chunk.sampleRate])).toEqual([
      ['u1', 0, false, 4800, RATE],
      ['u1', 1, true, 4800, RATE],
    ]);
    expect(peak(chunks[0]!.pcm)).toBe(0);
    expect(tts.state()).toEqual({ state: 'ready' });
    expect((await tts.voices()).every((voice) => voice.downloaded)).toBe(true);
    await expect(tts.models()).resolves.toEqual([SMALL, LARGE]);
    const progress = vi.fn();
    await expect(tts.download(LARGE, progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith({ id: LARGE, receivedBytes: 2_287_780_352, totalBytes: 2_287_780_352 });
    await expect(tts.download(SMALL, progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenLastCalledWith({ id: SMALL, receivedBytes: 1_213_534_464, totalBytes: 1_213_534_464 });
  });
});
