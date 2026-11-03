/**
 * Озвучка помощника через OpenAI (`POST /v1/audio/speech`, формат `pcm`: s16le, 24 кГц, моно). Ключ читается из
 * хранилища секретов на каждое предложение и живёт только в заголовке запроса: ни в логах, ни в состоянии, ни в
 * кусках, уходящих окну. Предложения идут по очереди; отмена обрывает запрос через `AbortController`.
 */
import type { SpeakOptions, SpeakRequest, TtsChunk, TtsService, TtsState } from './tts.js';

export const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
/**
 * TODO: OpenAI снимает gpt-4o-mini-tts (и tts-1, tts-1-hd) 2027-01-06; замена gpt-realtime-2.1-mini не принимается
 * /v1/audio/speech, нужен перенос на Realtime API.
 */
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
/** Частота формата `pcm` у OpenAI. */
export const OPENAI_PCM_RATE = 24_000;

export interface OpenAiTtsDeps {
  fetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
  /** `readSecret('voice:openai')` из `@parley/core`. */
  readKey(): Promise<string | null>;
  log?(line: string): void;
}

/** s16le → f32; нечётный хвост байт возвращается, чтобы дописать к следующему куску сети. */
function decodePcm(bytes: Uint8Array): { pcm: Float32Array; rest: Uint8Array } {
  const samples = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) pcm[i] = view.getInt16(i * 2, true) / 32768;
  return { pcm, rest: bytes.slice(samples * 2) };
}

export function createOpenAiTtsService(deps: OpenAiTtsDeps): TtsService {
  let current: TtsState = { state: 'no-key' };
  const listeners = new Set<(state: TtsState) => void>();
  const controllers = new Map<string, AbortController>();
  /** Предложения в очереди, ещё не начавшие запрос; отмена переносит id в `cancelled`. */
  const queued = new Set<string>();
  const cancelled = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  let active = 0;
  let stopped = false;

  const setState = (next: TtsState): void => {
    if (next.state === current.state && (next.state !== 'unavailable' || (current.state === 'unavailable' && current.reason === next.reason))) return;
    current = next;
    for (const listener of listeners) listener(next);
  };
  const idle = (): TtsState => (active > 0 ? { state: 'speaking' } : current.state === 'speaking' ? { state: 'ready' } : current);

  const refresh = async (): Promise<TtsState> => {
    const key = await deps.readKey().catch(() => null);
    if (key === null) setState({ state: 'no-key' });
    else if (current.state === 'no-key' || current.state === 'unavailable') setState({ state: 'ready' });
    return current;
  };

  const run = async (request: SpeakRequest, sink: (chunk: TtsChunk) => void, options?: SpeakOptions): Promise<TtsState> => {
    const closing = (seq: number): void =>
      sink({ utteranceId: request.utteranceId, seq, sampleRate: OPENAI_PCM_RATE, channels: 1, format: 'f32', pcm: new Float32Array(0), final: true });
    queued.delete(request.utteranceId);
    if (stopped || cancelled.delete(request.utteranceId)) return current;
    const key = await deps.readKey().catch(() => null);
    if (key === null) {
      setState({ state: 'no-key' });
      closing(0);
      return current;
    }
    if (current.state === 'no-key') setState({ state: 'ready' });
    const controller = new AbortController();
    controllers.set(request.utteranceId, controller);
    active += 1;
    setState({ state: 'speaking' });
    let seq = 0;
    try {
      const response = await deps.fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_TTS_MODEL, input: request.text, voice: request.voice, response_format: 'pcm' }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        deps.log?.(`openai tts failed: HTTP ${response.status}`);
        if (response.status === 401) setState({ state: 'unavailable', reason: 'OpenAI rejected the key' });
        else if (response.status === 400 || response.status === 403 || response.status === 404)
          setState({ state: 'unavailable', reason: 'OpenAI voice model is unavailable' });
        void response.body?.cancel().catch(() => undefined);
        closing(0);
        return current;
      }
      const reader = response.body.getReader();
      let rest: Uint8Array = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return current;
        if (done) break;
        const bytes = new Uint8Array(rest.length + value.length);
        bytes.set(rest);
        bytes.set(value, rest.length);
        const decoded = decodePcm(bytes);
        rest = decoded.rest;
        if (decoded.pcm.length > 0) sink({ utteranceId: request.utteranceId, seq: seq++, sampleRate: OPENAI_PCM_RATE, channels: 1, format: 'f32', pcm: decoded.pcm, final: false });
      }
      closing(seq);
    } catch (error) {
      if (!controller.signal.aborted) {
        deps.log?.(`openai tts failed: ${error instanceof Error ? error.name : 'error'}`);
        if (seq > 0) options?.onDiscard?.(request.utteranceId, 0);
        closing(seq);
      }
    } finally {
      controllers.delete(request.utteranceId);
      active -= 1;
      setState(idle());
    }
    return current;
  };

  return {
    speak(request, sink, options) {
      queued.add(request.utteranceId);
      const result = tail.then(() => run(request, sink, options));
      tail = result.catch(() => undefined);
      return result;
    },
    cancel(utteranceId) {
      const controller = controllers.get(utteranceId);
      if (controller !== undefined) controller.abort();
      else if (queued.has(utteranceId)) cancelled.add(utteranceId);
    },
    cancelAll() {
      for (const id of queued) cancelled.add(id);
      for (const controller of controllers.values()) controller.abort();
    },
    state: () => current,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    warmup: refresh,
    stop() {
      stopped = true;
      for (const controller of controllers.values()) controller.abort();
    },
  };
}
