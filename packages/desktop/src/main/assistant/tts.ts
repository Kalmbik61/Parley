/**
 * Озвучка помощника в main: контракт `TtsService` и подмена для E2E. Настоящая озвучка — `openai-tts.ts` (план
 * 2026-11-03, S-TTS); локальный движок удалён (S-del). Куски f32 уходят потребителю по мере прихода (шов
 * `island:tts-chunk`, спека #9 §6.3).
 */

/** Частота подменного голоса; настоящий движок присылает свою в каждом куске. */
const DEFAULT_SAMPLE_RATE = 24_000;

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
  /** Id голоса. */
  voice: string;
  language: string;
}

export interface SpeakOptions {
  /** Попытка сорвалась: куски этого `utteranceId` с `seq >= fromSeq` надо выбросить. */
  onDiscard?(utteranceId: string, fromSeq: number): void;
}

export type TtsState =
  | { state: 'unavailable'; reason: string }
  | { state: 'no-key' }
  | { state: 'ready' }
  | { state: 'speaking' };

export interface TtsService {
  /** Ставит предложение в очередь; промис — когда оно кончилось, с состоянием (для «нет голоса» — сразу). */
  speak(request: SpeakRequest, sink: (chunk: TtsChunk) => void, options?: SpeakOptions): Promise<TtsState>;
  /** После отмены кусков предложения нет, даже `final`. */
  cancel(utteranceId: string): void;
  cancelAll(): void;
  state(): TtsState;
  /** Срабатывает при смене состояния. */
  onState(listener: (state: TtsState) => void): () => void;
  warmup(): Promise<TtsState>;
  /** Выход приложения: отмена всего. */
  stop(): void;
}

const FAKE_CHUNK_SAMPLES = Math.round(DEFAULT_SAMPLE_RATE * 0.2);

/** Подмена для E2E (`PARLEY_TTS=fake`): `speak` отдаёт два куска тишины по 0,2 с. */
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
    stop: () => undefined,
  };
}
