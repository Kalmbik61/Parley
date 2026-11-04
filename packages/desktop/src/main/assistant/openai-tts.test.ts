import { describe, expect, it, vi } from 'vitest';
import { createOpenAiTtsService, OPENAI_SPEECH_URL, type OpenAiTtsDeps } from './openai-tts.js';
import type { TtsChunk, TtsState } from './tts.js';

type FetchInit = Parameters<OpenAiTtsDeps['fetch']>[1];

const MARKER = 'marker-key-0123456789abcdef';
const REQUEST = { utteranceId: 'u-1', text: 'Two agents are busy.', voice: 'alloy', language: 'en' };

const s16 = (...values: number[]): Uint8Array => new Uint8Array(new Int16Array(values).buffer);

function streamOf(...parts: Uint8Array[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[index++];
        if (part === undefined) controller.close();
        else controller.enqueue(part);
      },
    }),
    { status: 200 },
  );
}

function setup(over: { key?: string | null; respond?: (init: FetchInit) => Promise<Response> } = {}) {
  const logs: string[] = [];
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const tts = createOpenAiTtsService({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return over.respond === undefined ? streamOf(s16(0, 16384, -16384)) : over.respond(init);
    },
    readKey: async () => (over.key === undefined ? MARKER : over.key),
    log: (line) => logs.push(line),
  });
  return { tts, logs, calls };
}

describe('createOpenAiTtsService', () => {
  it('без ключа: no-key, запрос не уходит, предложение закрыто пустым final-куском', async () => {
    const { tts, calls } = setup({ key: null });
    const chunks: TtsChunk[] = [];
    await expect(tts.speak(REQUEST, (chunk) => chunks.push(chunk))).resolves.toEqual({ state: 'no-key' });
    expect(calls).toHaveLength(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ final: true });
    expect(chunks[0]!.pcm.length).toBe(0);
    expect(tts.state()).toEqual({ state: 'no-key' });
  });

  it('warmup: ключ появился — ready, исчез — no-key', async () => {
    let key: string | null = null;
    const tts = createOpenAiTtsService({ fetch: async () => streamOf(), readKey: async () => key });
    await expect(tts.warmup()).resolves.toEqual({ state: 'no-key' });
    key = MARKER;
    await expect(tts.warmup()).resolves.toEqual({ state: 'ready' });
    key = null;
    await expect(tts.warmup()).resolves.toEqual({ state: 'no-key' });
  });

  it('speak: POST на /v1/audio/speech в формате pcm; s16le превращается в f32; последний кусок final', async () => {
    const { tts, calls } = setup();
    const chunks: TtsChunk[] = [];
    const states: TtsState['state'][] = [];
    tts.onState((state) => states.push(state.state));
    await expect(tts.speak(REQUEST, (chunk) => chunks.push(chunk))).resolves.toEqual({ state: 'ready' });
    expect(calls[0]!.url).toBe(OPENAI_SPEECH_URL);
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ input: REQUEST.text, voice: 'alloy', response_format: 'pcm' });
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${MARKER}`);
    expect(chunks.map((chunk) => [chunk.seq, chunk.final, chunk.sampleRate])).toEqual([[0, false, 24_000], [1, true, 24_000]]);
    expect(Array.from(chunks[0]!.pcm)).toEqual([0, 0.5, -0.5]);
    expect(states).toEqual(['ready', 'speaking', 'ready']);
  });

  it('нечётная граница байт между сетевыми кусками не ломает выборку', async () => {
    const whole = s16(16384, -16384);
    const { tts } = setup({ respond: async () => streamOf(whole.slice(0, 1), whole.slice(1)) });
    const chunks: TtsChunk[] = [];
    await tts.speak(REQUEST, (chunk) => chunks.push(chunk));
    expect(chunks.flatMap((chunk) => Array.from(chunk.pcm))).toEqual([0.5, -0.5]);
  });

  it('cancel прерывает запрос через AbortController; кусков после отмены нет, даже final', async () => {
    let signal: AbortSignal | null = null;
    const { tts } = setup({
      respond: (init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal;
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const chunks: TtsChunk[] = [];
    const done = tts.speak(REQUEST, (chunk) => chunks.push(chunk));
    await vi.waitFor(() => expect(signal).not.toBeNull());
    tts.cancel('u-1');
    await done;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(chunks).toHaveLength(0);
    expect(tts.state()).toEqual({ state: 'ready' });
  });

  it('cancel предложения в очереди: запрос для него не уходит', async () => {
    const releases: Array<() => void> = [];
    const { tts, calls } = setup({ respond: () => new Promise<Response>((resolve) => releases.push(() => resolve(streamOf(s16(1))))) });
    const first = tts.speak(REQUEST, () => undefined);
    const second = tts.speak({ ...REQUEST, utteranceId: 'u-2' }, () => undefined);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    tts.cancel('u-2');
    releases[0]!();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it('401: unavailable с причиной без текста ключа; предложение закрыто', async () => {
    const { tts, logs } = setup({ respond: async () => new Response('{"error":"bad key"}', { status: 401 }) });
    const chunks: TtsChunk[] = [];
    await expect(tts.speak(REQUEST, (chunk) => chunks.push(chunk))).resolves.toEqual({ state: 'unavailable', reason: 'OpenAI rejected the key' });
    expect(chunks.map((chunk) => chunk.final)).toEqual([true]);
    expect(logs.join('\n')).toContain('401');
  });

  it('401, затем warmup с ключом: снова ready', async () => {
    const { tts } = setup({ respond: async () => new Response('{}', { status: 401 }) });
    await tts.speak(REQUEST, () => undefined);
    expect(tts.state().state).toBe('unavailable');
    await expect(tts.warmup()).resolves.toEqual({ state: 'ready' });
  });

  it('404 (модель снята): unavailable с фиксированной причиной', async () => {
    const { tts } = setup({ respond: async () => new Response('{}', { status: 404 }) });
    await expect(tts.speak(REQUEST, () => undefined)).resolves.toEqual({ state: 'unavailable', reason: 'OpenAI voice model is unavailable' });
  });

  it('маркерный ключ не попадает ни в логи main, ни в куски и состояния, уходящие окну (IPC)', async () => {
    const failing = setup({ respond: async () => { throw new Error(`boom ${MARKER}`); } });
    const rejected = setup({ respond: async () => new Response(`echo ${MARKER}`, { status: 401 }) });
    const ok = setup();
    const seen: unknown[] = [];
    for (const { tts } of [failing, rejected, ok]) {
      tts.onState((state) => seen.push(state));
      seen.push(await tts.speak(REQUEST, (chunk) => seen.push({ ...chunk, pcm: Array.from(chunk.pcm) })));
      seen.push(tts.state());
    }
    const logs = [...failing.logs, ...rejected.logs, ...ok.logs].join('\n');
    expect(logs).not.toContain(MARKER);
    expect(JSON.stringify(seen)).not.toContain(MARKER);
    expect(logs).toContain('openai tts failed');
  });
});
