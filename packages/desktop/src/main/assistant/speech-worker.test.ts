import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANCEL_GRACE_MS,
  CLOSE_TIMEOUT_MS,
  createSpeechWorker,
  decodePcm,
  lengthLimitSeconds,
  resolveSpeech,
  SENTENCE_TIMEOUT_MS,
  SpeechWorkerError,
  type SpeechChild,
  type SpeechWorkerDeps,
} from './speech-worker.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Фикстуры — stdout живого worker из спайка B01 (speech.cpp v0.9.0): строки дословно, только PCM укорочен до 8
 * отсчётов на кусок, а `end.samples` пересчитан под укороченные куски. `non-json-out` — `normal` со вставленной
 * строкой не-JSON (сам worker такой не пишет). `fatal` в B01 не снимался: его строка — из `docs/worker.md` speech.cpp.
 */
function fixture(name: string): string[] {
  return readFileSync(path.join(dirname, 'fixtures', `speech-worker-${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

const READY = fixture('ready');
const FATAL = '{"type":"fatal","error":{"code":"model_file","option":null,"message":"the file is not a model"}}';

type Line = Record<string, unknown>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Line[] = [];
  readonly signals: string[] = [];
  stdinEnded = false;
  private exited = false;
  /** stdin синхронный: тест видит строку сразу после вызова клиента. */
  readonly stdin = {
    write: (data: string): boolean => {
      for (const text of data.split('\n').filter((part) => part !== '')) {
        const line = JSON.parse(text) as Line;
        this.written.push(line);
        this.script(this, line);
      }
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
    on: (): unknown => this.stdin,
  };

  constructor(private readonly script: (child: FakeChild, line: Line) => void) {
    super();
  }

  send(lines: string[]): void {
    // Убитый процесс больше ничего не пишет.
    for (const line of lines) if (!this.exited) this.stdout.write(`${line}\n`);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.once('end', () => this.emit('close', code, null));
    this.stdout.end();
    this.stderr.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.exit(null);
    return true;
  }
}

interface Harness {
  deps: SpeechWorkerDeps;
  children: FakeChild[];
  spawned: { bin: string; args: string[] }[];
  logs: string[];
}

/** Поддельный `spawn`: `start` пишет первые строки (по умолчанию `ready`), `script` отвечает на строки stdin. */
function harness(options: { script?: (child: FakeChild, line: Line) => void; start?: string[]; bin?: string | null } = {}): Harness {
  const children: FakeChild[] = [];
  const spawned: { bin: string; args: string[] }[] = [];
  const logs: string[] = [];
  const deps: SpeechWorkerDeps = {
    bin: () => (options.bin === undefined ? '/speech/bin/speech' : options.bin),
    model: () => '/models/qwen3.gguf',
    spawn: (bin, args) => {
      const child = new FakeChild(options.script ?? (() => undefined));
      children.push(child);
      spawned.push({ bin, args });
      child.send(options.start ?? READY);
      return child as unknown as SpeechChild;
    },
    log: (message) => logs.push(message),
    newSeed: () => 777,
  };
  return { deps, children, spawned, logs };
}

/** Отвечает на каждый `synthesize` строками фикстуры под id запроса. */
function replay(...cases: string[][]): (child: FakeChild, line: Line) => void {
  let next = 0;
  return (child, line) => {
    if (line.type !== 'synthesize') return;
    const lines = cases[Math.min(next, cases.length - 1)] ?? [];
    next += 1;
    child.send(
      lines.map((text) => {
        if (!text.startsWith('{')) return text;
        return JSON.stringify({ ...(JSON.parse(text) as Line), id: line.id });
      }),
    );
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function drain(stream: AsyncIterable<Float32Array>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const samples = (chunks: Float32Array[]): number => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveSpeech', () => {
  const files = (list: string[]) => (candidate: string): boolean => list.includes(candidate);

  it('собранное приложение: Resources/speech/bin/speech', () => {
    const bin = path.join('/App/Contents/Resources', 'speech', 'bin', 'speech');
    expect(resolveSpeech({ isPackaged: true, resourcesPath: '/App/Contents/Resources', devDir: '/dev/speech', isFile: files([bin]) })).toBe(bin);
  });

  it('разработка: build/speech/darwin-arm64/bin/speech', () => {
    const bin = path.join('/pkg/build/speech/darwin-arm64', 'bin', 'speech');
    expect(resolveSpeech({ isPackaged: false, resourcesPath: '/r', devDir: '/pkg/build/speech/darwin-arm64', isFile: files([bin]) })).toBe(bin);
  });

  it('нет бинаря — null', () => {
    expect(resolveSpeech({ isPackaged: true, resourcesPath: '/r', devDir: '/d', isFile: files([]) })).toBeNull();
    expect(resolveSpeech({ isPackaged: false, resourcesPath: '/r', devDir: '/d', isFile: files([]) })).toBeNull();
  });
});

describe('decodePcm', () => {
  it('PCM16 LE в base64 → x / 32768, заданные отсчёты точно', () => {
    const pcm = Buffer.from(new Int16Array([32767, -32768, 0, 1, -1]).buffer).toString('base64');
    expect(Array.from(decodePcm(pcm))).toEqual([32767 / 32768, -1, 0, 1 / 32768, -1 / 32768]);
  });
});

describe('lengthLimitSeconds (страж длины)', () => {
  it('max(3 с, 0,1 с × символы) × 2', () => {
    expect(lengthLimitSeconds('Готово.')).toBe(6);
    expect(lengthLimitSeconds('я'.repeat(50))).toBeCloseTo(10, 9);
  });
});

describe('createSpeechWorker', () => {
  it('запуск: `speech worker <модель> --threads 4`, ready с протоколом 3 — готов, частота из ready', async () => {
    const h = harness();
    const worker = createSpeechWorker(h.deps);
    expect(worker.status()).toEqual({ state: 'stopped' });
    await expect(worker.start()).resolves.toEqual({ state: 'ready', sampleRate: 24_000 });
    expect(h.spawned).toEqual([{ bin: '/speech/bin/speech', args: ['worker', '/models/qwen3.gguf', '--threads', '4'] }]);
    expect(worker.status()).toEqual({ state: 'ready', sampleRate: 24_000 });
  });

  it('синтез по фикстуре normal: max_seconds в запросе, куски декодированы точно, поток кончается на end', async () => {
    const h = harness({ script: replay(fixture('normal')) });
    const worker = createSpeechWorker(h.deps);
    const chunks = await drain(worker.synthesize({ id: 'n1', text: 'Готово.', voice: 'serena', language: 'ru', seed: 1 }));
    expect(h.children[0]?.written).toEqual([
      { type: 'synthesize', id: 'n1', text: 'Готово.', voice: 'serena', language: 'ru', seed: 1, max_seconds: 6 },
    ]);
    expect(chunks).toHaveLength(7);
    expect(samples(chunks)).toBe(56); // end.samples фикстуры
    // Кусок seq 4: «O+087WLuEfHg9Ub58fp8+w==».
    expect(Array.from(chunks[4] ?? [])).toEqual([-4805, -4804, -4510, -3823, -2592, -1722, -1295, -1156].map((x) => x / 32768));
    expect(worker.status().state).toBe('ready');
  });

  it('seed не задан — его нет и в запросе', async () => {
    const h = harness({ script: replay(fixture('normal')) });
    const worker = createSpeechWorker(h.deps);
    await drain(worker.synthesize({ id: 'n1', text: 'Готово.', voice: 'serena', language: 'ru' }));
    expect(h.children[0]?.written[0]).not.toHaveProperty('seed');
  });

  it('error worker (неизвестный голос) — поток бросает SpeechWorkerError с кодом worker', async () => {
    const h = harness({ script: replay(fixture('error')) });
    const worker = createSpeechWorker(h.deps);
    const stream = worker.synthesize({ id: 'e1', text: 'Готово.', voice: 'nobody', language: 'ru' });
    const error: unknown = await drain(stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechWorkerError);
    expect((error as SpeechWorkerError).code).toBe('out_of_range');
    expect(worker.status().state).toBe('ready');
  });

  it('id уже в работе — synthesize бросает сразу, worker ничего не получает второй раз', async () => {
    const h = harness();
    const worker = createSpeechWorker(h.deps);
    void worker.synthesize({ id: 'x1', text: 'Готово.', voice: 'serena', language: 'ru' });
    expect(() => worker.synthesize({ id: 'x1', text: 'Ещё.', voice: 'serena', language: 'ru' })).toThrow(/x1/);
    await flush();
    expect(h.children[0]?.written.filter((line) => line.type === 'synthesize')).toHaveLength(1);
  });

  it('stderr уходит в журнал, error без id — тоже, worker остаётся готов', async () => {
    const h = harness();
    const worker = createSpeechWorker(h.deps);
    await worker.start();
    h.children[0]?.stderr.write('ggml_metal_init: loaded\n');
    h.children[0]?.send(['{"type":"error","error":{"code":"invalid_argument","option":null,"message":"the line is not JSON"}}']);
    await flush();
    expect(h.logs.some((line) => line.includes('ggml_metal_init: loaded'))).toBe(true);
    expect(h.logs.some((line) => line.includes('the line is not JSON'))).toBe(true);
    expect(worker.status().state).toBe('ready');
  });

  describe('E6: голос недоступен', () => {
    it('чужой protocol — unavailable с причиной, процесс убит, синтеза нет', async () => {
      const ready = { ...(JSON.parse(READY[0] ?? '{}') as Line), protocol: 4 };
      const h = harness({ start: [JSON.stringify(ready)] });
      const worker = createSpeechWorker(h.deps);
      const status = await worker.start();
      expect(status.state).toBe('unavailable');
      expect(status.state === 'unavailable' && status.reason).toMatch(/protocol 4/);
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      const error: unknown = await drain(worker.synthesize({ id: 'a', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      expect((error as SpeechWorkerError).code).toBe('unavailable');
      expect(h.children[0]?.written).toEqual([]);
      expect(h.spawned).toHaveLength(1);
    });

    it('fatal — unavailable с кодом и сообщением, синтеза нет, повторного запуска нет', async () => {
      const h = harness({ start: [FATAL] });
      const worker = createSpeechWorker(h.deps);
      const status = await worker.start();
      expect(status).toEqual({ state: 'unavailable', reason: 'fatal model_file: the file is not a model' });
      h.children[0]?.exit(1);
      await flush();
      const error: unknown = await drain(worker.synthesize({ id: 'a', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      expect((error as SpeechWorkerError).code).toBe('unavailable');
      expect(h.children[0]?.written).toEqual([]);
      expect(h.spawned).toHaveLength(1);
      expect(worker.status().state).toBe('unavailable');
    });

    it('нет бинаря — unavailable, spawn не зовётся', async () => {
      const h = harness({ bin: null });
      const worker = createSpeechWorker(h.deps);
      await expect(worker.start()).resolves.toMatchObject({ state: 'unavailable' });
      expect(h.spawned).toEqual([]);
    });

    it('spawn падает (ENOENT, чужая архитектура) — unavailable', async () => {
      const h = harness({ start: [] });
      const worker = createSpeechWorker(h.deps);
      const started = worker.start();
      h.children[0]?.emit('error', new Error('spawn ENOENT'));
      await expect(started).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/ENOENT/) as unknown });
    });

    it('процесс вышел до ready — unavailable', async () => {
      const h = harness({ start: [] });
      const worker = createSpeechWorker(h.deps);
      const started = worker.start();
      h.children[0]?.exit(2);
      await expect(started).resolves.toMatchObject({ state: 'unavailable' });
    });

    it('строка не-JSON до ready — unavailable, без круга перезапусков', async () => {
      const h = harness({ start: ['ggml_metal: oops'] });
      const worker = createSpeechWorker(h.deps);
      await expect(worker.start()).resolves.toMatchObject({ state: 'unavailable' });
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      expect(h.spawned).toHaveLength(1);
    });
  });

  describe('E3: отмена', () => {
    it('cancel уходит сразу, куски в очереди и после cancel не отдаются, после cancelled кусков нет', async () => {
      const cancel = fixture('cancel');
      let child: FakeChild | undefined;
      const h = harness({
        script: (fake, line) => {
          child = fake;
          if (line.type === 'synthesize') fake.send([cancel[0] ?? '', '{"type":"chunk","id":"c0","seq":1,"pcm":"/38AgAAAAQD//w=="}']);
        },
      });
      const worker = createSpeechWorker(h.deps);
      const stream = worker.synthesize({ id: 'c0', text: 'Сейчас я подробно расскажу.', voice: 'serena', language: 'ru', seed: 10 });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      await flush(); // второй кусок ждёт в очереди потока
      expect(first.done).toBe(false);
      expect(Array.from(first.value as Float32Array)).toEqual([0, 0, 0, 1, 1, 0, 0, 1].map((x) => x / 32768));

      worker.cancel('c0');
      // Строка cancel записана синхронно, ещё до ответа worker.
      expect(child?.written.at(-1)).toEqual({ type: 'cancel', id: 'c0' });
      // Кусок в очереди выброшен; пришедший между cancel и cancelled на остров не идёт; после cancelled — тоже.
      child?.send(['{"type":"chunk","id":"c0","seq":2,"pcm":"/38AgAAAAQD//w=="}', cancel[1] ?? '', '{"type":"chunk","id":"c0","seq":3,"pcm":"/38AgAAAAQD//w=="}']);
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      worker.cancel('c0');
      expect(child?.written.filter((line) => line.type === 'cancel')).toHaveLength(1);
    });

    it('cancel до отправки — synthesize в worker не уходит, поток пуст', async () => {
      const h = harness({ start: [] });
      const worker = createSpeechWorker(h.deps);
      const stream = worker.synthesize({ id: 'q', text: 'Готово.', voice: 'serena', language: 'ru' });
      worker.cancel('q');
      h.children[0]?.send(READY);
      await expect(drain(stream)).resolves.toEqual([]);
      expect(h.children[0]?.written).toEqual([]);
    });

    it('потребитель бросил поток — уходит cancel', async () => {
      const h = harness({ script: replay(fixture('cancel').slice(0, 1)) });
      const worker = createSpeechWorker(h.deps);
      for await (const chunk of worker.synthesize({ id: 'c0', text: 'Готово.', voice: 'serena', language: 'ru' })) {
        expect(chunk.length).toBe(8);
        break;
      }
      expect(h.children[0]?.written.at(-1)).toEqual({ type: 'cancel', id: 'c0' });
    });
  });

  describe('E2: страж длины', () => {
    it('срыв (end.stop = max_seconds) — один повтор с новым seed, снова срыв — предложение пропускается', async () => {
      const h = harness({ script: replay(fixture('max-seconds'), fixture('max-seconds')) });
      const worker = createSpeechWorker(h.deps);
      const onRunaway = vi.fn();
      const text = 'я'.repeat(50);
      const chunks = await drain(worker.synthesize({ id: 'm1', text, voice: 'serena', language: 'ru', seed: 3 }, { onRunaway }));
      const requests = h.children[0]?.written.filter((line) => line.type === 'synthesize');
      expect(requests).toEqual([
        { type: 'synthesize', id: 'm1', text, voice: 'serena', language: 'ru', seed: 3, max_seconds: 10 },
        { type: 'synthesize', id: 'm1', text, voice: 'serena', language: 'ru', seed: 777, max_seconds: 10 },
      ]);
      expect(onRunaway).toHaveBeenCalledTimes(2);
      expect(chunks).toHaveLength(8);
      expect(worker.status().state).toBe('ready');
    });

    it('срыв, повтор удался — поток кончается на end повтора, onRunaway один раз', async () => {
      const h = harness({ script: replay(fixture('max-seconds'), fixture('normal')) });
      const worker = createSpeechWorker(h.deps);
      const onRunaway = vi.fn();
      const stream = worker.synthesize({ id: 'm1', text: 'Готово.', voice: 'serena', language: 'ru' }, { onRunaway });
      const chunks = await drain(stream);
      expect(onRunaway).toHaveBeenCalledTimes(1);
      expect(chunks).toHaveLength(4 + 7);
      expect(h.children[0]?.written.filter((line) => line.type === 'synthesize')).toHaveLength(2);
    });
  });

  describe('перезапуск', () => {
    it('строка stdout не JSON — SIGKILL, поток бросает, worker запускается заново и снова синтезирует', async () => {
      const h = harness({ script: replay(fixture('non-json-out'), fixture('normal')) });
      const worker = createSpeechWorker(h.deps);
      const error: unknown = await drain(worker.synthesize({ id: 'n1', text: 'Готово.', voice: 'serena', language: 'ru', seed: 1 })).catch((caught: unknown) => caught);
      expect((error as SpeechWorkerError).code).toBe('restarted');
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      expect(h.spawned).toHaveLength(2);
      await expect(worker.start()).resolves.toMatchObject({ state: 'ready' });
      const chunks = await drain(worker.synthesize({ id: 'n2', text: 'Готово.', voice: 'serena', language: 'ru' }));
      expect(samples(chunks)).toBe(56);
      expect(h.children[1]?.written.map((line) => line.id)).toEqual(['n2']);
    });

    it('20 с без конца — cancel, без ответа на cancel — SIGKILL и перезапуск; поток бросает timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = harness();
      const worker = createSpeechWorker(h.deps);
      const outcome = drain(worker.synthesize({ id: 't1', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      await flush();
      expect(h.children[0]?.written.map((line) => line.type)).toEqual(['synthesize']);
      await vi.advanceTimersByTimeAsync(SENTENCE_TIMEOUT_MS);
      expect(h.children[0]?.written.at(-1)).toEqual({ type: 'cancel', id: 't1' });
      expect(h.children[0]?.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      expect(((await outcome) as SpeechWorkerError).code).toBe('timeout');
      expect(h.spawned).toHaveLength(2);
      await flush();
      expect(worker.status().state).toBe('ready');
    });

    it('20 с без конца, но cancelled пришёл — поток бросает timeout, процесс живёт', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = harness({
        script: (child, line) => {
          if (line.type === 'cancel') child.send([JSON.stringify({ type: 'cancelled', id: line.id })]);
        },
      });
      const worker = createSpeechWorker(h.deps);
      const outcome = drain(worker.synthesize({ id: 't1', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      await flush();
      await vi.advanceTimersByTimeAsync(SENTENCE_TIMEOUT_MS);
      await flush();
      expect(((await outcome) as SpeechWorkerError).code).toBe('timeout');
      await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
      expect(h.children[0]?.signals).toEqual([]);
      expect(h.spawned).toHaveLength(1);
    });

    it('worker упал, когда был готов, — поток бросает, следующий синтез запускает его снова', async () => {
      const h = harness();
      const worker = createSpeechWorker(h.deps);
      const outcome = drain(worker.synthesize({ id: 'a', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      await flush();
      h.children[0]?.exit(134);
      expect(((await outcome) as SpeechWorkerError).code).toBe('exited');
      expect(worker.status()).toEqual({ state: 'stopped' });
      void worker.synthesize({ id: 'b', text: 'Готово.', voice: 'serena', language: 'ru' });
      await flush();
      expect(h.spawned).toHaveLength(2);
    });
  });

  describe('close и stop (Р5)', () => {
    it('close закрывает stdin: запрос в работе получает end, выход с 0, потом worker запускается заново', async () => {
      const lines = fixture('stdin-close-in-flight');
      const h = harness();
      const worker = createSpeechWorker(h.deps);
      const outcome = drain(worker.synthesize({ id: 'z1', text: 'Готово: я открыл пулл-реквест.', voice: 'serena', language: 'ru', seed: 5 }));
      await flush();
      const child = h.children[0];
      const closed = worker.close();
      expect(child?.stdinEnded).toBe(true);
      expect(worker.status()).toEqual({ state: 'stopped' });
      child?.send(lines);
      child?.exit(0);
      await closed;
      expect(samples(await outcome)).toBe(24);
      expect(child?.signals).toEqual([]);
      await worker.start();
      expect(h.spawned).toHaveLength(2);
    });

    it('close: процесс не вышел за 5 с — SIGKILL', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const h = harness();
      const worker = createSpeechWorker(h.deps);
      await worker.start();
      const closed = worker.close();
      await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS - 1);
      expect(h.children[0]?.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      await closed;
    });

    it('close без процесса — сразу', async () => {
      const h = harness();
      await createSpeechWorker(h.deps).close();
      expect(h.spawned).toEqual([]);
    });

    it('stop — SIGKILL сразу, потоки бросают', async () => {
      const h = harness();
      const worker = createSpeechWorker(h.deps);
      const outcome = drain(worker.synthesize({ id: 'a', text: 'Готово.', voice: 'serena', language: 'ru' })).catch((caught: unknown) => caught);
      await flush();
      worker.stop();
      expect(h.children[0]?.signals).toEqual(['SIGKILL']);
      expect(((await outcome) as SpeechWorkerError).code).toBe('stopped');
      expect(worker.status()).toEqual({ state: 'stopped' });
    });
  });
});
