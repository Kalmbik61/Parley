import { describe, expect, it } from 'vitest';
import { createVoiceTelemetry, type TelemetryRecord } from './telemetry.js';
import type { QueueItem } from './speech-queue.js';

const item = (patch: Partial<QueueItem> = {}): QueueItem => ({
  requestId: 'req-1',
  jobId: 'job-1',
  revision: 4,
  delegationId: 'd1',
  speech: 'queued',
  card: 'hidden',
  text: 'Two rooms are waiting for you: Design review.',
  truncated: false,
  gate: 'open',
  heldSince: null,
  queuedAt: 10_000,
  submittedAt: null,
  ...patch,
});

function setup() {
  let now = 1000;
  const records: TelemetryRecord[] = [];
  const telemetry = createVoiceTelemetry({ now: () => now, record: (entry) => void records.push(entry) });
  return { telemetry, records, at: (value: number) => void (now = value) };
}

describe('VoiceTelemetry', () => {
  it('first_audio_ms — от старта сессии до первого воспроизведения; interrupts — речь поверх модели', () => {
    const { telemetry, records, at } = setup();
    telemetry.sessionStarted('vs-1');
    at(1800);
    telemetry.modelPlaying(true);
    at(2500);
    telemetry.humanSpeaking(true);
    telemetry.humanSpeaking(false);
    telemetry.modelPlaying(false);
    telemetry.humanSpeaking(true);
    telemetry.humanSpeaking(false);
    telemetry.modelPlaying(true);
    telemetry.modelPlaying(false);
    telemetry.sessionEnded();
    expect(records).toEqual([{ voiceSessionId: 'vs-1', firstAudioMs: 800, interrupts: 1, decisionsReceived: 0, decisionsRejected: 0, decisionsInputTokens: 0, decisionsFallback: true }]);
  });

  it('модель не говорила — first_audio_ms = null', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.sessionEnded();
    expect(records).toEqual([{ voiceSessionId: 'vs-1', firstAudioMs: null, interrupts: 0, decisionsReceived: 0, decisionsRejected: 0, decisionsInputTokens: 0, decisionsFallback: false }]);
  });

  it('Decisions: решения, отклонённые и сумма входных токенов считаются за сессию; следующая сессия начинает с нуля', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.modelPlaying(true);
    telemetry.decision({ inputTokens: 165, rejected: false });
    telemetry.decision({ inputTokens: 200.4, rejected: true });
    telemetry.decision({ inputTokens: 0, rejected: false });
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ decisionsReceived: 3, decisionsRejected: 1, decisionsInputTokens: 365, decisionsFallback: false });
    telemetry.sessionStarted('vs-2');
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ voiceSessionId: 'vs-2', decisionsReceived: 0, decisionsRejected: 0, decisionsInputTokens: 0 });
  });

  it('запасной вариант: модель говорила, решений не было — decisionsFallback; не говорила — нет; решения без речи не нужны', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.modelPlaying(true);
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ decisionsReceived: 0, decisionsFallback: true });
    telemetry.sessionStarted('vs-2');
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ decisionsFallback: false });
    telemetry.sessionStarted('vs-3');
    telemetry.modelPlaying(true);
    telemetry.decision({ inputTokens: 10, rejected: true });
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ decisionsReceived: 1, decisionsRejected: 1, decisionsFallback: false });
  });

  it('решение вне сессии не считается', () => {
    const { telemetry, records } = setup();
    telemetry.decision({ inputTokens: 50, rejected: false });
    telemetry.sessionStarted('vs-1');
    telemetry.sessionEnded();
    expect(records.at(-1)).toMatchObject({ decisionsReceived: 0, decisionsInputTokens: 0 });
  });

  it('submit и подтверждение: запись уходит, когда известен Request; порядок событий не важен', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.ackResolved('d1', false);
    expect(records).toEqual([]);
    telemetry.requestSubmitted({ delegationId: 'd1', requestId: 'req-1', delegationToSubmitMs: 1234.4, transcriptWaitMs: 200 });
    expect(records).toEqual([
      { voiceSessionId: 'vs-1', requestId: 'req-1', delegationToSubmitMs: 1234, transcriptWaitMs: 200 },
      { voiceSessionId: 'vs-1', requestId: 'req-1', ackAudible: false },
    ]);
    telemetry.requestSubmitted({ delegationId: 'd2', requestId: 'req-2', delegationToSubmitMs: 900, transcriptWaitMs: 0 });
    telemetry.ackResolved('d2', 'unknown');
    expect(records.at(-1)).toEqual({ voiceSessionId: 'vs-1', requestId: 'req-2', ackAudible: 'unknown' });
  });

  it('очередь речи: срок удержания и итоговое состояние записываются по одному разу', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.observeQueue([item()]);
    expect(records).toEqual([]);
    telemetry.observeQueue([item({ speech: 'submitted', submittedAt: 14_500 })]);
    telemetry.observeQueue([item({ speech: 'submitted', submittedAt: 14_500 })]);
    telemetry.observeQueue([item({ speech: 'played', submittedAt: 14_500 })]);
    telemetry.observeQueue([item({ speech: 'played', submittedAt: 14_500 })]);
    expect(records).toEqual([
      { voiceSessionId: 'vs-1', requestId: 'req-1', resultHoldMs: 4500 },
      { voiceSessionId: 'vs-1', requestId: 'req-1', speechState: 'played' },
    ]);
  });

  it('вытесненный итог — dropped без срока удержания; перебитый — unknown', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.observeQueue([item({ requestId: 'a', speech: 'dropped' }), item({ requestId: 'b', speech: 'unknown', submittedAt: 11_000 })]);
    expect(records).toEqual([
      { voiceSessionId: 'vs-1', requestId: 'a', speechState: 'dropped' },
      { voiceSessionId: 'vs-1', requestId: 'b', speechState: 'unknown', resultHoldMs: 1000 },
    ]);
  });

  it('в записях нет текстовых полей: ни текста итога, ни транскрипта, только id, числа и перечисления', () => {
    const { telemetry, records } = setup();
    telemetry.sessionStarted('vs-1');
    telemetry.requestSubmitted({ delegationId: 'd1', requestId: 'req-1', delegationToSubmitMs: 5, transcriptWaitMs: 1 });
    telemetry.ackResolved('d1', true);
    telemetry.observeQueue([item({ speech: 'played', submittedAt: 11_000 })]);
    telemetry.sessionEnded();
    const allowed = new Set(['voiceSessionId', 'requestId', 'ackAudible', 'delegationToSubmitMs', 'transcriptWaitMs', 'resultHoldMs', 'speechState', 'firstAudioMs', 'interrupts', 'decisionsReceived', 'decisionsRejected', 'decisionsInputTokens', 'decisionsFallback']);
    for (const record of records) {
      expect(Object.keys(record).every((key) => allowed.has(key))).toBe(true);
      expect(JSON.stringify(record)).not.toContain('Two rooms');
    }
  });
});
