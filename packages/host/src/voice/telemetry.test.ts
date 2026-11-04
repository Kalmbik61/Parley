import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { METHODS } from '@parley/protocol';
import { createJobs, type Job, type JobEnd, type JobRun } from '../assistant/jobs.js';
import { createRequests } from '../assistant/requests.js';
import { createVoiceTelemetryHandlers } from '../methods/voice-telemetry.js';
import { createVoiceTelemetry, TELEMETRY_MAX_ROWS } from './telemetry.js';

function setup(rate: number | null = null) {
  const db = openMemoryDb();
  const settle = new Map<string, (end: JobEnd) => void>();
  const execute = vi.fn((job: Job): JobRun => {
    let done: (end: JobEnd) => void = () => {};
    const promise = new Promise<JobEnd>((resolve) => {
      done = resolve;
    });
    settle.set(job.jobId, done);
    return { cancel: () => done({ ok: false, kind: 'cancelled', message: 'cancelled' }), done: promise };
  });
  const jobs = createJobs({ db, execute, defaultProvider: () => 'claude', capPerProvider: 50 });
  const requests = createRequests({ db, jobs });
  let clock = 1_000;
  const telemetry = createVoiceTelemetry({ db, requests, jobs, usdPerMinute: () => rate, now: () => (clock += 1) });
  const submit = (id: string) => requests.submit({ conversationId: 'island', voiceSessionId: 'vs-1', delegationId: id, text: `private question ${id}` }).request;
  return { db, jobs, requests, telemetry, submit, settle };
}
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('VoiceTelemetry (хост)', () => {
  it('частичные записи одного Request сливаются, прежнее не затирается; хост дописывает job_duration_ms и link_request_ms', async () => {
    const h = setup();
    const request = h.submit('d1');
    h.telemetry.record({ voiceSessionId: 'vs-1', requestId: request.requestId, delegationToSubmitMs: 900, transcriptWaitMs: 150 });
    h.telemetry.record({ voiceSessionId: 'vs-1', requestId: request.requestId, ackAudible: false });
    // job закончился, связь определена
    h.settle.get(request.jobId)?.({ ok: true, summary: 'done', result: { answer: 'done', capturedAt: 1, cards: [], toolRefs: [] }, outcome: 'completed' });
    await settled();
    h.db.prepare("UPDATE assistant_requests SET link_kind = 'independent', linked_at = created_at + 700 WHERE request_id = ?").run(request.requestId);
    h.telemetry.record({ voiceSessionId: 'vs-1', requestId: request.requestId, resultHoldMs: 4200, speechState: 'played' });

    const rows = h.telemetry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      voice_session_id: 'vs-1',
      request_id: request.requestId,
      delegation_to_submit_ms: 900,
      transcript_wait_ms: 150,
      ack_audible: false,
      result_hold_ms: 4200,
      speech_state: 'played',
      link_request_ms: 700,
      first_audio_ms: null,
      voice_seconds: null,
    });
    expect(rows[0]?.job_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('ack_audible: true, false и unknown различаются', () => {
    const h = setup();
    for (const [index, value] of ([true, false, 'unknown'] as const).entries()) {
      const request = h.submit(`d${index}`);
      h.telemetry.record({ voiceSessionId: 'vs-1', requestId: request.requestId, ackAudible: value });
    }
    expect(h.telemetry.list().map((row) => row.ack_audible).reverse()).toEqual([true, false, 'unknown']);
  });

  it('запись сессии: расход из voice_usage, superseded_count по Request сессии; стоимость — только при заданном тарифе', () => {
    const h = setup();
    h.db.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate, seconds_final) VALUES ('vs-1', '2026-11-04', 'closed', 100, 90)").run();
    const old = h.submit('d1');
    h.submit('d2');
    h.db.prepare("UPDATE assistant_requests SET superseded_by = 'x' WHERE request_id = ?").run(old.requestId);
    h.telemetry.record({ voiceSessionId: 'vs-1', firstAudioMs: 800, interrupts: 2 });
    expect(h.telemetry.list()[0]).toMatchObject({ request_id: null, first_audio_ms: 800, interrupts: 2, voice_seconds: 90, superseded_count: 1, voice_cost_estimate_usd: null });

    const priced = setup(0.2);
    priced.db.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate, seconds_final) VALUES ('vs-1', '2026-11-04', 'closed', 100, 90)").run();
    priced.telemetry.record({ voiceSessionId: 'vs-1', interrupts: 0 });
    expect(priced.telemetry.list()[0]?.voice_cost_estimate_usd).toBeCloseTo(0.3, 6);
  });

  it('до закрытия usage берётся оценка', () => {
    const h = setup();
    h.db.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate) VALUES ('vs-1', '2026-11-04', 'open', 42)").run();
    h.telemetry.record({ voiceSessionId: 'vs-1' });
    expect(h.telemetry.list()[0]?.voice_seconds).toBe(42);
  });

  it('таблица ограничена: остаются последние строки', () => {
    const h = setup();
    for (let index = 0; index < TELEMETRY_MAX_ROWS + 25; index += 1) h.telemetry.record({ voiceSessionId: `vs-${index}`, interrupts: index });
    const count = h.db.prepare('SELECT COUNT(*) AS n FROM voice_telemetry').get() as { n: number };
    expect(count.n).toBe(TELEMETRY_MAX_ROWS);
    expect(h.telemetry.list(1)[0]?.interrupts).toBe(TELEMETRY_MAX_ROWS + 24);
  });

  it('строки не содержат текста: текстовые колонки — только id и перечисления, значения не несут слов поручения', async () => {
    const h = setup();
    const request = h.submit('d1');
    h.telemetry.record({ voiceSessionId: 'vs-1', requestId: request.requestId, ackAudible: true, delegationToSubmitMs: 5, speechState: 'unknown' });
    h.telemetry.record({ voiceSessionId: 'vs-1', firstAudioMs: 5, interrupts: 0 });
    const text = (h.db.prepare('PRAGMA table_info(voice_telemetry)').all() as Array<{ name: string; type: string }>).filter((column) => column.type === 'TEXT').map((column) => column.name);
    expect(text).toEqual(['voice_session_id', 'request_id', 'ack_audible', 'speech_state']);
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM voice_telemetry').all());
    expect(dump).not.toContain('private question');
    for (const row of h.telemetry.list()) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string') expect(['voice_session_id', 'request_id', 'ack_audible', 'speech_state']).toContain(key);
      }
    }
  });

  it('метод записи принимает только числа и перечисления: лишнее поле (текст) отклоняется схемой', () => {
    const schema = METHODS['voice.telemetry.record'];
    expect(schema.safeParse({ voiceSessionId: 'vs-1', requestId: 'req-1', ackAudible: 'unknown', speechState: 'played', interrupts: 1 }).success).toBe(true);
    expect(schema.safeParse({ voiceSessionId: 'vs-1', transcript: 'hello' }).success).toBe(false);
    expect(schema.safeParse({ voiceSessionId: 'vs-1', speechState: 'free text' }).success).toBe(false);
    expect(schema.safeParse({ voiceSessionId: 'vs-1', resultHoldMs: -1 }).success).toBe(false);
    expect(schema.safeParse({ voiceSessionId: 'vs-1', ackAudible: 'yes' }).success).toBe(false);
  });

  it('обработчики записи и чтения; без телеметрии методов нет', async () => {
    const h = setup();
    expect(createVoiceTelemetryHandlers(undefined)).toEqual({});
    const handlers = createVoiceTelemetryHandlers(h.telemetry);
    expect(Object.keys(handlers).sort()).toEqual(['voice.telemetry.list', 'voice.telemetry.record']);
    const context = {} as never;
    expect(await handlers['voice.telemetry.record']?.({ voiceSessionId: 'vs-1', interrupts: 3 } as never, context)).toEqual({ ok: true });
    expect(await handlers['voice.telemetry.list']?.({} as never, context)).toMatchObject({ rows: [{ voice_session_id: 'vs-1', interrupts: 3 }] });
  });
});
