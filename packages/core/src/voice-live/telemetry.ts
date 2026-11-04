/**
 * Локальная телеметрия Live на клиенте (спека «Голос↔Ассистент» §11, T6). Собирает только числа и перечисления:
 * `first_audio_ms`, `ack_audible`, `delegation_to_submit_ms`, `transcript_wait_ms`, `result_hold_ms`, `speech_state`,
 * `interrupts`. Ни аудио, ни транскрипта, ни текста итога здесь нет: тип записи не имеет строковых полей, кроме id и
 * перечислений. Остальное (`link_request_ms`, `job_duration_ms`, `superseded_count`, `voice_seconds`,
 * `voice_cost_estimate_usd`) хост знает сам и дописывает при записи. Записи частичные: хост сливает их по ключу
 * «сессия + Request», поэтому новые факты можно слать по мере появления.
 *
 * Определения:
 * - `first_audio_ms` — от начала Live-сессии до первого воспроизведения моделью;
 * - `interrupts` — сколько раз человек заговорил поверх воспроизведения модели;
 * - `delegation_to_submit_ms` — от `delegation.created` до принятого хостом Request; `transcript_wait_ms` — часть этого
 *   срока до сборки текста поручения;
 * - `result_hold_ms` — от готовности итога до передачи в Live.
 */
import type { AckAudible } from './ack.js';
import type { QueueItem } from './speech-queue.js';

export type TelemetrySpeechState = 'played' | 'unknown' | 'dropped';

export interface TelemetryRequestRecord {
  voiceSessionId: string;
  requestId: string;
  ackAudible?: AckAudible;
  delegationToSubmitMs?: number;
  transcriptWaitMs?: number;
  resultHoldMs?: number;
  speechState?: TelemetrySpeechState;
}

export interface TelemetrySessionRecord {
  voiceSessionId: string;
  /** `null` — модель за сессию не воспроизводила. */
  firstAudioMs: number | null;
  interrupts: number;
}

export type TelemetryRecord = TelemetryRequestRecord | TelemetrySessionRecord;

export interface VoiceTelemetryDeps {
  now(): number;
  /** Запись уходит на хост; ошибка записи телеметрию не ломает. */
  record(entry: TelemetryRecord): void;
}

export interface VoiceTelemetry {
  sessionStarted(voiceSessionId: string): void;
  humanSpeaking(value: boolean): void;
  modelPlaying(value: boolean): void;
  ackResolved(delegationId: string, audible: AckAudible): void;
  requestSubmitted(info: { delegationId: string; requestId: string; delegationToSubmitMs: number; transcriptWaitMs: number }): void;
  /** Состояние очереди речи: итоговые состояния и срок удержания записываются один раз. */
  observeQueue(items: readonly QueueItem[]): void;
  /** Сессия закончилась: одна запись уровня сессии. */
  sessionEnded(): void;
}

const whole = (ms: number): number => Math.max(0, Math.round(ms));

export function createVoiceTelemetry(deps: VoiceTelemetryDeps): VoiceTelemetry {
  let voiceSessionId: string | null = null;
  let startedAt = 0;
  let firstAudioMs: number | null = null;
  let interrupts = 0;
  let humanSpeaking = false;
  let modelPlaying = false;
  const requestByDelegation = new Map<string, string>();
  const ackByDelegation = new Map<string, AckAudible>();
  /** Что уже записано по Request: состояние речи и срок удержания. */
  const recorded = new Map<string, TelemetrySpeechState>();
  const holdRecorded = new Set<string>();

  const emitAck = (delegationId: string): void => {
    const requestId = requestByDelegation.get(delegationId);
    const audible = ackByDelegation.get(delegationId);
    if (voiceSessionId === null || requestId === undefined || audible === undefined) return;
    deps.record({ voiceSessionId, requestId, ackAudible: audible });
    ackByDelegation.delete(delegationId);
  };

  return {
    sessionStarted(id) {
      voiceSessionId = id;
      startedAt = deps.now();
      firstAudioMs = null;
      interrupts = 0;
      humanSpeaking = false;
      modelPlaying = false;
    },
    humanSpeaking(value) {
      if (value && !humanSpeaking && modelPlaying) interrupts += 1;
      humanSpeaking = value;
    },
    modelPlaying(value) {
      if (value && !modelPlaying && voiceSessionId !== null && firstAudioMs === null) firstAudioMs = whole(deps.now() - startedAt);
      modelPlaying = value;
    },
    ackResolved(delegationId, audible) {
      ackByDelegation.set(delegationId, audible);
      emitAck(delegationId);
    },
    requestSubmitted({ delegationId, requestId, delegationToSubmitMs, transcriptWaitMs }) {
      requestByDelegation.set(delegationId, requestId);
      if (voiceSessionId !== null) {
        deps.record({ voiceSessionId, requestId, delegationToSubmitMs: whole(delegationToSubmitMs), transcriptWaitMs: whole(transcriptWaitMs) });
      }
      emitAck(delegationId);
    },
    observeQueue(items) {
      if (voiceSessionId === null) return;
      for (const item of items) {
        const final = item.speech === 'played' || item.speech === 'unknown' || item.speech === 'dropped' ? item.speech : null;
        const hold = item.submittedAt !== null && !holdRecorded.has(item.requestId) ? whole(item.submittedAt - item.queuedAt) : null;
        if (final === null && hold === null) continue;
        if (final !== null && recorded.get(item.requestId) === final && hold === null) continue;
        const entry: TelemetryRequestRecord = { voiceSessionId, requestId: item.requestId };
        if (final !== null && recorded.get(item.requestId) !== final) {
          entry.speechState = final;
          recorded.set(item.requestId, final);
        }
        if (hold !== null) {
          entry.resultHoldMs = hold;
          holdRecorded.add(item.requestId);
        }
        if (entry.speechState === undefined && entry.resultHoldMs === undefined) continue;
        deps.record(entry);
      }
    },
    sessionEnded() {
      if (voiceSessionId === null) return;
      deps.record({ voiceSessionId, firstAudioMs, interrupts });
      // `voiceSessionId` остаётся: очередь после закрытия сессии переводит отправленное в `unknown`, и это тоже записывается.
    },
  };
}
