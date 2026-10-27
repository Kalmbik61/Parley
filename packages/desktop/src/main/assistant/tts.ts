/**
 * Нейроголос помощника в main (план этапа 3b, B10; план 3, Task 2 — изменён): `TtsService` над клиентом
 * `speech worker` (B05). Предложения синтезируются по очереди, куски f32 уходят потребителю по мере прихода (шов
 * `island:tts-chunk`, спека #9 §6.3). Каждый кусок получает постоянное усиление голоса из каталога и ограничитель пика
 * −1 dBFS (Р4); ведущая тишина попытки не отправляется (Р4а).
 *
 * Срыв по длине (E2): клиент повторяет предложение с новым seed и зовёт `onRunaway`. Сорвавшаяся попытка уже частично
 * на острове (worker быстрее реального времени), поэтому служба перестаёт её пересылать и зовёт `onDiscard` с первым
 * seq этой попытки; повтор идёт дальше со старшими seq (решение интегратора по m-1448).
 *
 * `unavailable` клиента B05 липкий. Новый клиент создаётся после скачивания весов и после временного сбоя (процесс
 * не запустился или вышел до `ready`); чужой протокол, `fatal`, нет бинаря — голос недоступен (E6).
 *
 * Выгрузка (Р5): через 15 мин без синтеза worker закрывается; следующая нужда запускает его снова.
 */
import { TTS_VOICES, ttsModel, type AssistantVoice, type TtsModelId } from '../../shared/tts-types.js';
import type { DownloadResult } from '../../shared/voice-types.js';
import type { ModelProgress, ModelStore } from '../voice/models.js';
import type { SpeechWorker } from './speech-worker.js';

/** Простой до выгрузки модели (Р5). */
export const IDLE_UNLOAD_MS = 15 * 60_000;
/** Порог слышимости кадра — RMS −40 dBFS, как в замерах B01. */
export const AUDIBLE_RMS = 10 ** (-40 / 20);
/** Потолок ограничителя: −1 dBFS (Р4). */
export const PEAK_LIMIT = 10 ** (-1 / 20);
const FRAME_SECONDS = 0.02;
/** Постоянная времени спада огибающей ограничителя (Р4). */
const RELEASE_SECONDS = 0.05;
/** Частота Qwen3-TTS, пока worker не сказал свою. */
const DEFAULT_SAMPLE_RATE = 24_000;
/** Один файл весов на пять голосов (Р6). */
const MODEL_ID: TtsModelId = 'qwen3-tts-0.6b-q8_0';
/** Временные отказы клиента B05: процесс не запустился или вышел до `ready`. Остальные причины — навсегда. */
const TRANSIENT = /^(spawn failed|exited with .* before ready)/;
const MAX_TRANSIENT_RETRIES = 1;

export interface TtsChunk {
  utteranceId: string;
  seq: number;
  sampleRate: number;
  channels: 1;
  format: 'f32';
  pcm: Float32Array;
  /** Последний кусок предложения; он пустой, звук — в предыдущих. */
  final: boolean;
}

export interface SpeakRequest {
  utteranceId: string;
  text: string;
  /** Id голоса каталога (`qwen3-0.6b/serena`). */
  voice: string;
  language: string;
}

export interface SpeakOptions {
  /** Попытка сорвалась: куски этого `utteranceId` с `seq >= fromSeq` надо выбросить. */
  onDiscard?(utteranceId: string, fromSeq: number): void;
}

export type TtsState =
  | { state: 'unavailable'; reason: string }
  | { state: 'not-downloaded' }
  | { state: 'warming' }
  | { state: 'ready' }
  | { state: 'speaking' };

export interface TtsService {
  /** Ставит предложение в очередь; промис — когда оно кончилось, с состоянием (для «нет голоса» — сразу). */
  speak(request: SpeakRequest, sink: (chunk: TtsChunk) => void, options?: SpeakOptions): Promise<TtsState>;
  /** После отмены кусков предложения нет, даже `final`. */
  cancel(utteranceId: string): void;
  cancelAll(): void;
  /** `ready` — голос может звучать, в том числе когда worker выгружен: `speak` запустит его сам. */
  state(): TtsState;
  onState(listener: (state: TtsState) => void): () => void;
  warmup(): Promise<TtsState>;
  voices(): Promise<AssistantVoice[]>;
  /** Качает веса (только по кнопке, E5); после успеха — новый клиент worker и прогрев. */
  download(onProgress: (progress: ModelProgress<TtsModelId>) => void): Promise<DownloadResult>;
  /** Отмена идущего скачивания весов (D5: как у моделей Whisper). */
  cancelDownload(): void;
  /**
   * Удаление весов (D5): речь отменяется, worker останавливается, файл удаляется; дальше голоса `downloaded: false`,
   * ответы — текстом (G3), само ничего не качается.
   */
  remove(): Promise<void>;
  /** Выход приложения: отмена всего и `SIGKILL` worker. */
  stop(): void;
}

export interface TtsServiceDeps {
  /** Движок есть только на Apple Silicon: на x64 голос недоступен (Р8). */
  supported: boolean;
  models: ModelStore<TtsModelId>;
  /** Новый клиент worker (`createSpeechWorker`). */
  createWorker(): SpeechWorker;
  log(message: string): void;
}

/** Есть ли в куске кадр 20 мс с RMS не ниже −40 dBFS (Р4а). Хвост короче кадра считается кадром. */
export function isAudible(pcm: Float32Array, sampleRate: number): boolean {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  for (let start = 0; start < pcm.length; start += frame) {
    const end = Math.min(pcm.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += pcm[i]! * pcm[i]!;
    if (Math.sqrt(sum / (end - start)) >= AUDIBLE_RMS) return true;
  }
  return false;
}

/**
 * Усиление голоса и ограничитель пика −1 dBFS без клиппинга (Р4): огибающая с мгновенной атакой и спадом ~50 мс.
 * Огибающая живёт в замыкании — один ограничитель на попытку предложения, уровень на стыках кусков не прыгает.
 */
export function createLimiter(sampleRate: number): (pcm: Float32Array, gain: number) => Float32Array {
  const release = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
  let envelope = 1;
  return (pcm, gain) => {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      const x = pcm[i]! * gain;
      const level = Math.abs(x);
      const need = level > PEAK_LIMIT ? PEAK_LIMIT / level : 1;
      envelope = need < envelope ? need : need + (envelope - need) * release;
      out[i] = x * envelope;
    }
    return out;
  };
}

const EMPTY = new Float32Array(0);

interface Job {
  request: SpeakRequest;
  sink(chunk: TtsChunk): void;
  options: SpeakOptions;
  resolve(state: TtsState): void;
  cancelled: boolean;
  /** Id запроса к worker: `utteranceId` может повториться, пока прошлый запрос ещё ждёт `cancelled`. */
  requestId: string | null;
}

export function createTtsService(deps: TtsServiceDeps): TtsService {
  let downloaded = false;
  let worker: SpeechWorker | null = null;
  /** Причина последнего отказа worker; сбрасывается с новым клиентом и с `ready`. */
  let failure: string | null = null;
  /**
   * Новых клиентов после временного сбоя подряд. Один повтор, дальше голос недоступен до скачивания, удаления весов
   * или перезапуска: каждый запуск грузит 1,2 ГБ, холодный — до 15 с (критик m-1457).
   */
  let transientRetries = 0;
  const queue: Job[] = [];
  let current: Job | null = null;
  let requests = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(state: TtsState) => void>();
  let reported = '';

  function state(): TtsState {
    if (!deps.supported) return { state: 'unavailable', reason: 'the voice engine needs Apple Silicon' };
    if (!downloaded) return { state: 'not-downloaded' };
    if (failure !== null) return { state: 'unavailable', reason: failure };
    if (worker?.status().state === 'starting') return { state: 'warming' };
    return current === null ? { state: 'ready' } : { state: 'speaking' };
  }

  function notify(): void {
    const next = state();
    const key = JSON.stringify(next);
    if (key === reported) return;
    reported = key;
    for (const listener of listeners) listener(next);
  }

  async function refresh(): Promise<void> {
    downloaded = (await deps.models.list()).includes(MODEL_ID);
    notify();
  }

  function clearIdle(): void {
    if (idle !== null) clearTimeout(idle);
    idle = null;
  }

  function armIdle(): void {
    clearIdle();
    idle = setTimeout(() => {
      idle = null;
      if (current !== null || worker?.status().state !== 'ready') return;
      deps.log(`speech worker unloads after ${IDLE_UNLOAD_MS / 60_000} min idle`);
      void worker.close();
    }, IDLE_UNLOAD_MS);
  }

  /** Запускает worker, если надо. Синхронно до `start()`: после возврата промиса состояние уже `warming`. */
  async function ensureWorker(): Promise<TtsState> {
    if (!deps.supported || !downloaded) return state();
    if (worker === null) {
      worker = deps.createWorker();
      failure = null;
    }
    const target = worker;
    const starting = target.start();
    notify();
    const status = await starting;
    if (worker === target && status.state === 'ready') {
      failure = null;
      transientRetries = 0;
    }
    if (worker === target && status.state === 'unavailable') {
      failure = status.reason;
      if (TRANSIENT.test(status.reason) && transientRetries < MAX_TRANSIENT_RETRIES) {
        // Повтор ещё есть: голос считается доступным, следующий `speak` запустит новый клиент (критик m-1463).
        transientRetries += 1;
        worker = null;
        failure = null;
      }
    }
    notify();
    // `stopped` — worker остановили посреди запуска (`stop()` при выходе).
    return status.state === 'stopped' ? { state: 'unavailable', reason: 'the speech worker was stopped' } : state();
  }

  function chunk(job: Job, seq: number, sampleRate: number, pcm: Float32Array, final: boolean): TtsChunk {
    return { utteranceId: job.request.utteranceId, seq, sampleRate, channels: 1, format: 'f32', pcm, final };
  }

  /** Синтез одного предложения. `null` — кончилось штатно, итог — состояние службы после него. */
  async function run(job: Job): Promise<TtsState | null> {
    const { utteranceId, text, voice: voiceId, language } = job.request;
    let seq = 0;
    let sampleRate = DEFAULT_SAMPLE_RATE;
    const silent = (outcome: TtsState): TtsState => {
      job.sink(chunk(job, seq, sampleRate, EMPTY, true));
      return outcome;
    };
    const voice = TTS_VOICES.find((entry) => entry.id === voiceId);
    if (!deps.supported) return silent(state());
    if (voice === undefined || !voice.languages.includes(language)) {
      return silent({ state: 'unavailable', reason: `no voice ${voiceId} for language ${language}` });
    }
    await refresh();
    if (job.cancelled) return null;
    const ready = await ensureWorker();
    if (job.cancelled) return null;
    const target = worker;
    if (ready.state !== 'ready' && ready.state !== 'speaking') return silent(ready);
    if (target === null) return silent(state());
    const status = target.status();
    if (status.state === 'ready') sampleRate = status.sampleRate;

    const requestId = `${utteranceId}#${(requests += 1)}`;
    job.requestId = requestId;
    let attempt = { firstSeq: 0, audible: false, limit: createLimiter(sampleRate) };
    /**
     * Срыв приходит в том же такте, что и последний кусок попытки: этот кусок мог уже уйти ожидающему циклу ниже, и
     * цикл получит его следующей микрозадачей. Флаг держится до конца этой очереди микрозадач — куски повтора
     * приходят позже, с новыми строками stdout.
     */
    let discarding = false;
    const stream = target.synthesize(
      { id: requestId, text, voice: voice.id.slice(voice.id.indexOf('/') + 1), language },
      {
        onRunaway() {
          if (job.cancelled) return;
          job.options.onDiscard?.(utteranceId, attempt.firstSeq);
          attempt = { firstSeq: seq, audible: false, limit: createLimiter(sampleRate) };
          discarding = true;
          queueMicrotask(() => {
            discarding = false;
          });
        },
      },
    );
    try {
      for await (const pcm of stream) {
        if (job.cancelled) break;
        if (discarding) continue;
        if (!attempt.audible) {
          if (!isAudible(pcm, sampleRate)) continue;
          attempt.audible = true;
        }
        job.sink(chunk(job, seq, sampleRate, attempt.limit(pcm, voice.gain), false));
        seq += 1;
      }
    } catch (error) {
      deps.log(`tts: ${utteranceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (job.cancelled) return null;
    job.sink(chunk(job, seq, sampleRate, EMPTY, true));
    return null;
  }

  let pumping = false;
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    clearIdle();
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      current = job;
      notify();
      let outcome: TtsState | null;
      try {
        outcome = await run(job);
      } catch (error) {
        deps.log(`tts: ${job.request.utteranceId} failed: ${error instanceof Error ? error.message : String(error)}`);
        outcome = null;
      }
      current = null;
      job.resolve(outcome ?? state());
    }
    pumping = false;
    notify();
    armIdle();
  }

  function cancelJob(job: Job): void {
    job.cancelled = true;
    if (job.requestId !== null) worker?.cancel(job.requestId);
  }

  function cancelQueued(predicate: (job: Job) => boolean): void {
    for (const job of queue.filter(predicate)) {
      queue.splice(queue.indexOf(job), 1);
      job.cancelled = true;
      job.resolve(state());
    }
  }

  void refresh().catch((error: unknown) => deps.log(`tts: models: ${String(error)}`));

  return {
    speak(request, sink, options = {}) {
      return new Promise((resolve) => {
        queue.push({ request, sink, options, resolve, cancelled: false, requestId: null });
        void pump();
      });
    },
    cancel(utteranceId) {
      cancelQueued((job) => job.request.utteranceId === utteranceId);
      if (current?.request.utteranceId === utteranceId) cancelJob(current);
    },
    cancelAll() {
      cancelQueued(() => true);
      if (current !== null) cancelJob(current);
    },
    state,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async warmup() {
      await refresh();
      const outcome = await ensureWorker();
      if (!pumping) armIdle();
      return outcome;
    },
    async voices() {
      await refresh();
      return TTS_VOICES.map((voice) => ({ ...voice, downloaded: downloaded && voice.modelId === MODEL_ID }));
    },
    async download(onProgress) {
      const result = await deps.models.download(MODEL_ID, onProgress);
      if (!('ok' in result)) return result;
      downloaded = true;
      worker?.stop();
      worker = null;
      failure = null;
      transientRetries = 0;
      void ensureWorker().then(() => {
        if (!pumping) armIdle();
      });
      return result;
    },
    cancelDownload() {
      deps.models.cancel(MODEL_ID);
    },
    async remove() {
      clearIdle();
      cancelQueued(() => true);
      if (current !== null) current.cancelled = true;
      worker?.stop();
      worker = null;
      failure = null;
      transientRetries = 0;
      downloaded = false;
      notify();
      await deps.models.remove(MODEL_ID);
      await refresh();
    },
    stop() {
      clearIdle();
      cancelQueued(() => true);
      if (current !== null) current.cancelled = true;
      worker?.stop();
    },
  };
}

const FAKE_CHUNK_SAMPLES = Math.round(DEFAULT_SAMPLE_RATE * 0.2);

/** Подмена для E2E (`PARLEY_TTS=fake`): веса «скачаны», `speak` отдаёт два куска тишины по 0,2 с. */
export function createFakeTtsService(): TtsService {
  const ready: TtsState = { state: 'ready' };
  return {
    async speak(request, sink) {
      for (const seq of [0, 1]) {
        sink({
          utteranceId: request.utteranceId,
          seq,
          sampleRate: DEFAULT_SAMPLE_RATE,
          channels: 1,
          format: 'f32',
          pcm: new Float32Array(FAKE_CHUNK_SAMPLES),
          final: seq === 1,
        });
      }
      return ready;
    },
    cancel: () => undefined,
    cancelAll: () => undefined,
    state: () => ready,
    onState: () => () => undefined,
    warmup: async () => ready,
    voices: async () => TTS_VOICES.map((voice) => ({ ...voice, downloaded: true })),
    download: async (onProgress) => {
      const { bytes } = ttsModel(MODEL_ID);
      onProgress({ id: MODEL_ID, receivedBytes: bytes, totalBytes: bytes });
      return { ok: true };
    },
    cancelDownload: () => undefined,
    remove: async () => undefined,
    stop: () => undefined,
  };
}
