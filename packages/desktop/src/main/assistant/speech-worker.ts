/**
 * Клиент `speech worker` (speech.cpp, Qwen3-TTS; план этапа 3b, B05). Дочерний процесс main (Р1): stdin и stdout —
 * JSON Lines протокола 3 (`docs/worker.md` speech.cpp), stderr — в журнал. Строка stdout, которая не JSON-объект, —
 * дефект worker: процесс перезапускается. Синтез отдаёт куски PCM как `Float32Array` по мере прихода.
 *
 * Страж длины (исследование TTS §6.5 п. 8, E2): в каждом запросе `max_seconds`; worker сам останавливает срыв и
 * отвечает `end` со `stop: "max_seconds"`. Тогда — один повтор с новым seed (Р9), снова срыв — предложение
 * пропускается. Отданные куски сорвавшейся попытки уже ушли потребителю: `onRunaway` говорит ему их выбросить.
 *
 * Выгрузка (Р5) — `close()`: stdin закрывается, worker доделывает запросы и выходит с 0. `stop()` — `SIGKILL` при
 * выходе приложения.
 */
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** Версия протокола worker, с которой говорит клиент (speech.cpp v0.9.0). */
export const SPEECH_PROTOCOL = 3;
/** Тайм-аут на предложение: по нему уходит `cancel` (план 3, исследование §6.5 п. 4). */
export const SENTENCE_TIMEOUT_MS = 20_000;
/** Сколько ждать ответа на `cancel` после тайм-аута; без ответа — `SIGKILL` и перезапуск. Обычно ответ — ~20 мс. */
export const CANCEL_GRACE_MS = 2_000;
/** `close()`: столько ждём выхода с 0, потом `SIGKILL` (Р5). */
export const CLOSE_TIMEOUT_MS = 5_000;
const THREADS = '4';
/** Частота Qwen3-TTS; берётся из `ready.model.sample_rate`, это — запас на случай её отсутствия. */
const DEFAULT_SAMPLE_RATE = 24_000;
/** Сколько строки не-JSON попадает в журнал. */
const LOG_LINE_MAX = 200;

export interface SpeechLocation {
  isPackaged: boolean;
  resourcesPath: string;
  /** `build/speech/darwin-arm64` пакета окна (кладёт `scripts/fetch-speech.mjs`). */
  devDir: string;
  isFile(candidate: string): boolean;
}

/** Бинарь `speech`: `Resources/speech/bin/speech` в собранном приложении, `build/speech/darwin-arm64` в разработке. */
export function resolveSpeech(location: SpeechLocation): string | null {
  const dir = location.isPackaged ? path.join(location.resourcesPath, 'speech') : location.devDir;
  const bin = path.join(dir, 'bin', 'speech');
  return location.isFile(bin) ? bin : null;
}

/** Лимит длины речи по тексту: `max(3 с, 0,1 с × символы) × 2`. */
export function lengthLimitSeconds(text: string): number {
  return Math.max(3, 0.1 * [...text].length) * 2;
}

/** PCM16 LE моно в base64 → отсчёты `x / 32768`. */
export function decodePcm(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

/** Нужная клиенту часть `ChildProcess`: поддельный процесс тестов реализует только её. */
export interface SpeechChild {
  readonly stdin: { write(data: string): boolean; end(): void; on(event: 'error', listener: (error: Error) => void): unknown };
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnSpeech = (bin: string, args: string[]) => SpeechChild;

export const spawnSpeech: SpawnSpeech = (bin, args) => spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

export interface SpeechWorkerDeps {
  /** Путь к `speech` (`resolveSpeech`) или `null`, если бинаря нет. */
  bin(): string | null;
  /** Путь к GGUF модели. */
  model(): string;
  spawn: SpawnSpeech;
  log(message: string): void;
  /** Seed повтора после срыва (Р9); по умолчанию случайный. */
  newSeed?(): number;
}

export type SpeechWorkerStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'ready'; sampleRate: number }
  | { state: 'unavailable'; reason: string };

export interface SynthesizeRequest {
  id: string;
  text: string;
  voice: string;
  language: string;
  seed?: number;
}

export interface SynthesizeOptions {
  /** Попытка сорвалась по длине: отданные куски этого запроса — срыв, их надо выбросить. */
  onRunaway?(): void;
}

/**
 * Конец потока с ошибкой. `code` — код `error` worker (`out_of_range`, `invalid_argument`…) или свой: `unavailable`,
 * `timeout`, `restarted`, `exited`, `stopped`.
 */
export class SpeechWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpeechWorkerError';
  }
}

export interface SpeechWorker {
  status(): SpeechWorkerStatus;
  /** Запускает worker, если он не запущен, и ждёт `ready` или отказа. */
  start(): Promise<SpeechWorkerStatus>;
  /** Поток кончается ровно одним из `end`, `error` (бросает) или `cancelled`. */
  synthesize(request: SynthesizeRequest, options?: SynthesizeOptions): AsyncIterable<Float32Array>;
  /** `cancel` уходит сразу; своего ответа нет, поток кончится на `cancelled`. Не забранные и новые куски не отдаются. */
  cancel(id: string): void;
  close(): Promise<void>;
  stop(): void;
}

interface Proc {
  child: SpeechChild;
  exited: Promise<number | null>;
}

/** Очередь кусков одного запроса: main толкает, потребитель тянет. */
class Channel implements AsyncIterableIterator<Float32Array> {
  private readonly items: Float32Array[] = [];
  private waiter: { resolve(result: IteratorResult<Float32Array>): void; reject(error: unknown): void } | null = null;
  private done = false;
  private failure: { error: unknown } | null = null;

  constructor(private readonly onReturn: () => void) {}

  push(item: Float32Array): void {
    if (this.done) return;
    if (this.waiter === null) {
      this.items.push(item);
      return;
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve({ done: false, value: item });
  }

  /** Выбрасывает куски, которые потребитель ещё не забрал. */
  drop(): void {
    this.items.length = 0;
  }

  end(): void {
    this.settle(null);
  }

  fail(error: unknown): void {
    this.settle({ error });
  }

  private settle(failure: { error: unknown } | null): void {
    if (this.done) return;
    this.done = true;
    this.failure = failure;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter === null) return;
    if (failure === null) waiter.resolve({ done: true, value: undefined });
    else waiter.reject(failure.error);
  }

  next(): Promise<IteratorResult<Float32Array>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.done) {
      const failure = this.failure;
      this.failure = null;
      return failure === null ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(failure.error);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<Float32Array>> {
    if (!this.done) this.onReturn();
    this.items.length = 0;
    this.done = true;
    this.failure = null;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Float32Array> {
    return this;
  }
}

interface Pending {
  request: SynthesizeRequest;
  options: SynthesizeOptions;
  channel: Channel;
  /** Процесс, которому ушёл `synthesize`; `null` — ещё не ушёл. */
  proc: Proc | null;
  retried: boolean;
  cancelled: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type Message = Record<string, unknown> & { type: string };

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';
}

function errorOf(message: Message): { code: string; message: string } {
  const error = (typeof message.error === 'object' && message.error !== null ? message.error : {}) as { code?: unknown; message?: unknown };
  return { code: typeof error.code === 'string' ? error.code : 'unknown', message: typeof error.message === 'string' ? error.message : '' };
}

export function createSpeechWorker(deps: SpeechWorkerDeps): SpeechWorker {
  const newSeed = deps.newSeed ?? (() => randomInt(2 ** 31));
  let status: SpeechWorkerStatus = { state: 'stopped' };
  let proc: Proc | null = null;
  /** Процесс, которому закрыли stdin: он доделывает запросы, новый запускается после его выхода. */
  let closingProc: Proc | null = null;
  let starting: { promise: Promise<SpeechWorkerStatus>; resolve(status: SpeechWorkerStatus): void } | null = null;
  const pending = new Map<string, Pending>();

  function settle(next: SpeechWorkerStatus): void {
    status = next;
    const waiting = starting;
    starting = null;
    waiting?.resolve(next);
  }

  function unavailable(reason: string): void {
    deps.log(`speech worker unavailable: ${reason}`);
    settle({ state: 'unavailable', reason });
  }

  function write(target: Proc, message: Record<string, unknown>): void {
    target.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function clearTimer(entry: Pending): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  function finish(entry: Pending): void {
    clearTimer(entry);
    if (pending.get(entry.request.id) === entry) pending.delete(entry.request.id);
    entry.channel.end();
  }

  function fail(entry: Pending, error: SpeechWorkerError): void {
    clearTimer(entry);
    if (pending.get(entry.request.id) === entry) pending.delete(entry.request.id);
    entry.channel.fail(error);
  }

  function failAll(predicate: (entry: Pending) => boolean, error: SpeechWorkerError): void {
    for (const entry of [...pending.values()]) if (predicate(entry)) fail(entry, error);
  }

  /** Убивает процесс: его строки больше не читаются, его запросы кончаются ошибкой. */
  function kill(target: Proc, error: SpeechWorkerError): void {
    if (proc === target) proc = null;
    if (closingProc === target) closingProc = null;
    target.child.kill('SIGKILL');
    failAll((entry) => entry.proc === target, error);
  }

  function restart(target: Proc, reason: string): void {
    deps.log(`speech worker restarts: ${reason}`);
    const wasCurrent = proc === target;
    kill(target, new SpeechWorkerError('restarted', reason));
    if (!wasCurrent) return;
    status = { state: 'stopped' };
    void start();
  }

  function send(entry: Pending, seed: number | undefined): void {
    const target = proc;
    if (target === null) return;
    entry.proc = target;
    const { id, text, voice, language } = entry.request;
    write(target, { type: 'synthesize', id, text, voice, language, seed, max_seconds: lengthLimitSeconds(text) });
    entry.timer = setTimeout(() => onTimeout(entry, target), SENTENCE_TIMEOUT_MS);
  }

  function onTimeout(entry: Pending, target: Proc): void {
    entry.timedOut = true;
    deps.log(`speech worker: ${entry.request.id} has no end after ${SENTENCE_TIMEOUT_MS} ms, cancelling`);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      fail(entry, new SpeechWorkerError('timeout', `no end after ${SENTENCE_TIMEOUT_MS} ms`));
      restart(target, `${entry.request.id} did not answer the cancel`);
    }, CANCEL_GRACE_MS);
    write(target, { type: 'cancel', id: entry.request.id });
  }

  function onRunaway(entry: Pending, message: Message): void {
    deps.log(`speech worker: ${entry.request.id} ran to max_seconds (seed ${String(message.seed)})${entry.retried ? ', skipped' : ', retrying'}`);
    entry.options.onRunaway?.();
    clearTimer(entry);
    if (entry.retried || entry.proc !== proc) {
      finish(entry);
      return;
    }
    entry.retried = true;
    send(entry, newSeed());
  }

  function onRequestMessage(entry: Pending, message: Message): void {
    if (message.type === 'chunk') {
      if (entry.cancelled || entry.timedOut || typeof message.pcm !== 'string') return;
      entry.channel.push(decodePcm(message.pcm));
      return;
    }
    if (message.type !== 'end' && message.type !== 'error' && message.type !== 'cancelled') return;
    if (entry.timedOut) {
      fail(entry, new SpeechWorkerError('timeout', `no end after ${SENTENCE_TIMEOUT_MS} ms`));
      return;
    }
    if (message.type === 'error') {
      const error = errorOf(message);
      fail(entry, new SpeechWorkerError(error.code, error.message));
      return;
    }
    if (message.type === 'end' && message.stop === 'max_seconds' && !entry.cancelled) {
      onRunaway(entry, message);
      return;
    }
    finish(entry);
  }

  function onLine(target: Proc, line: string): void {
    if (target !== proc && target !== closingProc) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    if (!isMessage(message)) {
      const shown = line.slice(0, LOG_LINE_MAX);
      if (status.state === 'starting' && target === proc) {
        kill(target, new SpeechWorkerError('unavailable', 'not JSON'));
        unavailable(`a stdout line before ready is not a JSON object: ${shown}`);
        return;
      }
      restart(target, `a stdout line is not a JSON object: ${shown}`);
      return;
    }
    if (message.type === 'ready') {
      if (status.state !== 'starting' || target !== proc) return;
      if (message.protocol !== SPEECH_PROTOCOL) {
        kill(target, new SpeechWorkerError('unavailable', 'protocol'));
        unavailable(`protocol ${String(message.protocol)}, expected ${SPEECH_PROTOCOL}`);
        return;
      }
      const model = (typeof message.model === 'object' && message.model !== null ? message.model : {}) as { sample_rate?: unknown };
      settle({ state: 'ready', sampleRate: typeof model.sample_rate === 'number' ? model.sample_rate : DEFAULT_SAMPLE_RATE });
      return;
    }
    if (message.type === 'fatal') {
      const error = errorOf(message);
      if (target === proc) unavailable(`fatal ${error.code}: ${error.message}`);
      return;
    }
    if (typeof message.id !== 'string') {
      if (message.type === 'error') deps.log(`speech worker error: ${JSON.stringify(message.error)}`);
      return;
    }
    const entry = pending.get(message.id);
    if (entry?.proc === target) onRequestMessage(entry, message);
  }

  function onExit(target: Proc, code: number | null): void {
    failAll((entry) => entry.proc === target, new SpeechWorkerError('exited', `speech worker exited with ${String(code)}`));
    if (closingProc === target) closingProc = null;
    if (proc !== target) return;
    proc = null;
    if (status.state === 'starting') unavailable(`exited with ${String(code)} before ready`);
    else if (status.state === 'ready') {
      deps.log(`speech worker exited with ${String(code)}`);
      status = { state: 'stopped' };
    }
  }

  async function launch(): Promise<void> {
    if (closingProc !== null) await closingProc.exited;
    if (status.state !== 'starting') return;
    const bin = deps.bin();
    if (bin === null) {
      unavailable('the speech binary is missing');
      return;
    }
    let child: SpeechChild;
    try {
      child = deps.spawn(bin, ['worker', deps.model(), '--threads', THREADS]);
    } catch (error) {
      unavailable(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let exit: (code: number | null) => void = () => undefined;
    const target: Proc = { child, exited: new Promise((resolve) => (exit = resolve)) };
    proc = target;
    child.on('close', (code) => exit(code));
    child.on('error', (error) => {
      deps.log(`speech worker: ${error.message}`);
      if (proc === target && status.state === 'starting') {
        proc = null;
        unavailable(`spawn failed: ${error.message}`);
      }
      exit(null);
    });
    child.stdin.on('error', (error) => deps.log(`speech worker stdin: ${error.message}`));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => onLine(target, line));
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => deps.log(`speech: ${line}`));
    void target.exited.then((code) => onExit(target, code));
  }

  function start(): Promise<SpeechWorkerStatus> {
    if (status.state === 'ready' || status.state === 'unavailable') return Promise.resolve(status);
    if (starting !== null) return starting.promise;
    let resolve: (next: SpeechWorkerStatus) => void = () => undefined;
    const promise = new Promise<SpeechWorkerStatus>((done) => (resolve = done));
    starting = { promise, resolve };
    status = { state: 'starting' };
    void launch();
    return promise;
  }

  async function begin(entry: Pending): Promise<void> {
    const ready = await start();
    if (pending.get(entry.request.id) !== entry) return;
    if (entry.cancelled) {
      finish(entry);
      return;
    }
    if (ready.state !== 'ready' || proc === null) {
      fail(entry, new SpeechWorkerError('unavailable', ready.state === 'unavailable' ? ready.reason : 'the speech worker is not running'));
      return;
    }
    send(entry, entry.request.seed);
  }

  function cancel(id: string): void {
    const entry = pending.get(id);
    if (entry === undefined || entry.cancelled) return;
    entry.cancelled = true;
    entry.channel.drop();
    if (entry.proc !== null) write(entry.proc, { type: 'cancel', id });
  }

  return {
    status: () => status,
    start,
    synthesize(request, options = {}) {
      if (pending.has(request.id)) throw new Error(`speech request ${request.id} is already in flight`);
      const entry: Pending = {
        request,
        options,
        channel: new Channel(() => cancel(request.id)),
        proc: null,
        retried: false,
        cancelled: false,
        timedOut: false,
        timer: null,
      };
      pending.set(request.id, entry);
      void begin(entry);
      return entry.channel;
    },
    cancel,
    async close() {
      const target = proc;
      if (target === null) {
        if (status.state === 'starting') settle({ state: 'stopped' });
        return;
      }
      proc = null;
      closingProc = target;
      if (status.state !== 'unavailable') settle({ state: 'stopped' });
      target.child.stdin.end();
      const timer = setTimeout(() => {
        deps.log(`speech worker did not exit within ${CLOSE_TIMEOUT_MS} ms, killing`);
        target.child.kill('SIGKILL');
      }, CLOSE_TIMEOUT_MS);
      const code = await target.exited;
      clearTimeout(timer);
      if (code !== 0) deps.log(`speech worker exited with ${String(code)} on close`);
    },
    stop() {
      for (const target of [proc, closingProc]) if (target !== null) kill(target, new SpeechWorkerError('stopped', 'the speech worker was stopped'));
      failAll(() => true, new SpeechWorkerError('stopped', 'the speech worker was stopped'));
      if (status.state !== 'unavailable') settle({ state: 'stopped' });
    },
  };
}
