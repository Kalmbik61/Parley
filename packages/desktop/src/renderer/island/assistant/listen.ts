/**
 * Голосовой ввод помощника на острове (спека 2026-10-14, 8.4): запись тем же рекордером, что диктовка окна, конец —
 * 1,2 с тишины после речи по пику кадра (или повторный хоткей), затем локальный Whisper с подсказкой языка помощника.
 */

import type { MicStatus, TranscribeRequest, TranscribeResult, VoiceModelId } from '../../../shared/voice-types.js';
import { SILENCE_PEAK } from '../../voice/level.js';
import type { Recording } from '../../voice/recorder.js';

/**
 * Пик кадра, выше которого — речь. Порог чатов (0.02) откалиброван именно как порог пика; по RMS негромкая речь
 * у ноутбучного микрофона (≈ 0.01–0.02) не засчитывалась, и остров ждал NO_SPEECH_MS перед распознаванием.
 */
export const SPEECH_PEAK = SILENCE_PEAK;
export const SILENCE_MS = 1200;
/** Так и не заговорили — перестать слушать. */
export const NO_SPEECH_MS = 8000;
export const MAX_LISTEN_MS = 60_000;

/** Возвращает функцию «пора остановиться?» для каждого кадра по его пику. */
export function silenceGate(now: () => number): (peak: number) => boolean {
  const started = now();
  let heard = false;
  let quietSince: number | null = null;
  return (peak) => {
    const at = now();
    if (at - started >= MAX_LISTEN_MS) return true;
    if (peak >= SPEECH_PEAK) {
      heard = true;
      quietSince = null;
      return false;
    }
    if (!heard) return at - started >= NO_SPEECH_MS;
    quietSince ??= at;
    return at - quietSince >= SILENCE_MS;
  };
}

export type ListenResult = { text: string } | { error: 'mic' | 'no_speech' | 'voice' | 'cancelled' };

export interface ListenDeps {
  record(onLevel: (level: number, peak: number) => void): Promise<Recording>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): Promise<MicStatus>;
  requestMic(): Promise<boolean>;
  now(): number;
  model: VoiceModelId;
  language: string;
  onLevel(level: number): void;
  onTranscribing(): void;
}

export interface Listening {
  stop(): void;
  cancel(): void;
  readonly result: Promise<ListenResult>;
}

export function listen(deps: ListenDeps): Listening {
  let stopRequested = false;
  let cancelled = false;
  let wake: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const stop = (): void => {
    stopRequested = true;
    wake();
  };
  const result = (async (): Promise<ListenResult> => {
    const status = await deps.micStatus();
    const allowed = status === 'granted' || (status === 'not-determined' && (await deps.requestMic()));
    if (!allowed) return { error: 'mic' };
    if (cancelled) return { error: 'cancelled' };
    const gate = silenceGate(deps.now);
    let recording: Recording;
    try {
      recording = await deps.record((level, peak) => {
        deps.onLevel(level);
        if (gate(peak)) stop();
      });
    } catch {
      return { error: 'mic' };
    }
    if (!stopRequested) await stopped;
    if (cancelled) {
      recording.cancel();
      return { error: 'cancelled' };
    }
    const audio = await recording.stop();
    deps.onTranscribing();
    const answer = await deps.transcribe({ pcm: audio.pcm, language: deps.language, model: deps.model });
    if ('text' in answer) return answer.text.trim() === '' ? { error: 'no_speech' } : { text: answer.text.trim() };
    return { error: answer.error === 'no_speech' ? 'no_speech' : 'voice' };
  })();
  return {
    stop,
    cancel: () => {
      cancelled = true;
      stop();
    },
    result,
  };
}
