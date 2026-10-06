/**
 * Запись с микрофона (спека 4.1): `getUserMedia` моно с шумоподавлением → `AudioContext` 16 кГц (ресемплинг —
 * Chromium) → AudioWorklet `pcm-capture` → PCM Int16 в памяти. Громкость каждого кадра уходит наружу для полоски,
 * пик — для порога тишины. Зависимости браузера подменяемы: jsdom их не знает. Настоящие — в `browser-recorder.ts`:
 * там импорт worklet, и этот модуль (его тянут store, кнопка и поля) от сборщика worklet не зависит.
 */
import { joinChunks, floatTo16 } from './pcm.js';
import { peakOf, rms } from './level.js';

export const RECORDING_SAMPLE_RATE = 16_000;

export class MicError extends Error {
  constructor(readonly kind: 'denied' | 'not_found') {
    super(`microphone ${kind}`);
  }
}

export interface RecordedAudio {
  pcm: ArrayBuffer;
  durationMs: number;
  peak: number;
}

export interface Recording {
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}

/** Часть `AudioContext`, которая нужна записи. */
export interface CaptureContext {
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): { connect(node: unknown): void; disconnect(): void };
  destination: unknown;
  close(): Promise<void>;
}

export interface CaptureNode {
  port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface RecorderDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): CaptureContext;
  createNode(context: CaptureContext): CaptureNode;
  /** Адрес модуля worklet; у настоящих зависимостей — ленивый импорт. */
  workletUrl(): Promise<string>;
}

export async function startRecording(onLevel: (level: number) => void, deps: RecorderDeps): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    throw new MicError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'not_found');
  }
  // Всё после getUserMedia может бросить: тогда микрофон нельзя оставлять открытым (спека 4.1).
  let context: CaptureContext | undefined;
  let source: ReturnType<CaptureContext['createMediaStreamSource']>;
  let node: CaptureNode;
  const chunks: Int16Array[] = [];
  let samples = 0;
  let peak = 0;
  try {
    context = deps.createContext();
    await context.audioWorklet.addModule(await deps.workletUrl());
    source = context.createMediaStreamSource(stream);
    node = deps.createNode(context);
    node.port.onmessage = (event) => {
      const frame = event.data;
      chunks.push(floatTo16(frame));
      samples += frame.length;
      peak = Math.max(peak, peakOf(frame));
      onLevel(rms(frame));
    };
    source.connect(node);
    node.connect(context.destination);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context?.close().catch(() => undefined);
    throw error;
  }
  const openContext = context;

  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await openContext.close();
    })();
    return closed;
  };

  return {
    async stop() {
      await close();
      const pcm = joinChunks(chunks);
      return { pcm: pcm.buffer as ArrayBuffer, durationMs: (samples / RECORDING_SAMPLE_RATE) * 1000, peak };
    },
    cancel() {
      void close();
    },
  };
}
