/**
 * Request голосовых поручений (спека «Голос↔Ассистент», §4 и §9, T2): долговечная запись «человек поручил, Live
 * делегировал», по одной на делегацию. Request связывает разговор острова с job и хранит отметки доставки итога
 * потребителям, поэтому переживает рестарт хоста и закрытие голоса. Job при закрытии голоса не отменяется.
 *
 * Повтор события или потерянный submit с тем же `originKey` возвращает тот же Request и тот же job: второго не бывает.
 * Версия Request (`version`) — своя, не ревизия job; её поднимает связь поручений (T5), здесь поле зарезервировано.
 * Поля `supersededBy` и `transcriptPartial` тоже только хранятся: логика вытеснения и частичного текста — T4/T5.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AssistantRequestAck, AssistantRequestView } from '@parley/protocol';
import type { Jobs } from './jobs.js';

export type RequestView = AssistantRequestView;

export interface SubmitRequestInput {
  conversationId: string;
  /** Исходные идентификаторы голосовой сессии и делегации: из них выводится `originKey`, он не меняется после восстановления. */
  voiceSessionId: string;
  delegationId: string;
  turnId?: string | undefined;
  text: string;
  context?: Record<string, unknown> | undefined;
  transcriptPartial?: boolean | undefined;
}

export interface Requests {
  /** Идемпотентно по `originKey`. `created: false` — Request уже был (повтор события, потерянный ответ). */
  submit(input: SubmitRequestInput): { request: RequestView; created: boolean };
  get(requestId: string): RequestView | null;
  /** Открытые Request разговора и терминальные, чьё финальное состояние потребитель ещё не получил. По возрастанию `seq`. */
  list(conversationId: string, consumer: string): RequestView[];
  /** Потребитель получил итог. Идемпотентно; принимается только ревизия финального состояния job (как `jobs.ackInline`). */
  ack(requestId: string, consumer: string, revision: number): AssistantRequestAck;
}

export interface RequestsDeps {
  db: DatabaseSync;
  jobs: Pick<Jobs, 'submitJob' | 'getJob'>;
  now?(): number;
}

/** Не больше столько знаков JSON контекста: контекст — последние реплики, а не архив. */
export const REQUEST_CONTEXT_LIMIT = 16 * 1024;

const OPEN_JOB_STATES = ['queued', 'running'];

interface Raw {
  request_id: string;
  origin_key: string;
  conversation_id: string;
  seq: number;
  version: number;
  text: string;
  context_json: string | null;
  job_id: string;
  superseded_by: string | null;
  transcript_partial: number;
  created_at: number;
  updated_at: number;
}

/** Ключ происхождения: JSON-массив, поэтому границу между id не подделать двоеточием внутри id. */
export const originKeyOf = (voiceSessionId: string, delegationId: string): string => JSON.stringify([voiceSessionId, delegationId]);

export function createRequests(deps: RequestsDeps): Requests {
  const { db, jobs } = deps;
  const now = deps.now ?? Date.now;

  const byOrigin = (originKey: string): Raw | undefined =>
    db.prepare('SELECT * FROM assistant_requests WHERE origin_key = ?').get(originKey) as unknown as Raw | undefined;

  function view(row: Raw): RequestView | null {
    const job = jobs.getJob(row.job_id);
    if (job === null) return null;
    const delivery: Record<string, number> = {};
    for (const mark of db.prepare('SELECT consumer, job_revision FROM assistant_request_deliveries WHERE request_id = ?').all(row.request_id) as unknown as Array<{ consumer: string; job_revision: number }>) {
      delivery[mark.consumer] = Number(mark.job_revision);
    }
    return {
      requestId: row.request_id,
      originKey: row.origin_key,
      conversationId: row.conversation_id,
      seq: row.seq,
      version: row.version,
      text: row.text,
      context: row.context_json === null ? null : (JSON.parse(row.context_json) as Record<string, unknown>),
      jobId: row.job_id,
      supersededBy: row.superseded_by,
      transcriptPartial: row.transcript_partial === 1,
      delivery,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      job: { jobId: job.jobId, state: job.state, revision: job.revision, resultSummary: job.resultSummary },
    };
  }

  return {
    submit(input) {
      const originKey = originKeyOf(input.voiceSessionId, input.delegationId);
      const existing = byOrigin(originKey);
      if (existing !== undefined) {
        const request = view(existing);
        if (request !== null) return { request, created: false };
      }
      const contextJson = input.context === undefined ? null : JSON.stringify(input.context);
      if (contextJson !== null && contextJson.length > REQUEST_CONTEXT_LIMIT) throw new Error(`Request context is longer than ${REQUEST_CONTEXT_LIMIT} characters`);
      // Job первым: он идемпотентен по ключу. Упали между job и Request — повтор с тем же originKey найдёт тот же job и допишет Request.
      const job = jobs.submitJob({
        origin: 'island',
        text: input.text,
        idempotencyKey: `request:${originKey}`,
        correlation: { voiceSessionId: input.voiceSessionId, delegationId: input.delegationId, turnId: input.turnId ?? input.delegationId },
      });
      const stamp = now();
      const requestId = `req-${stamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      // `seq` выбирается тем же оператором, что и вставка: два Request разговора не получат один номер.
      const inserted = db
        .prepare(
          `INSERT INTO assistant_requests (request_id, origin_key, conversation_id, seq, version, text, context_json, job_id, transcript_partial, created_at, updated_at)
           SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, 1, ?, ?, ?, ?, ?, ? FROM assistant_requests WHERE conversation_id = ?
           ON CONFLICT(origin_key) DO NOTHING`,
        )
        .run(requestId, originKey, input.conversationId, input.text, contextJson, job.jobId, input.transcriptPartial === true ? 1 : 0, stamp, stamp, input.conversationId).changes;
      const row = byOrigin(originKey) as Raw;
      return { request: view(row) as RequestView, created: Number(inserted) === 1 };
    },
    get(requestId) {
      const row = db.prepare('SELECT * FROM assistant_requests WHERE request_id = ?').get(requestId) as unknown as Raw | undefined;
      return row === undefined ? null : view(row);
    },
    list(conversationId, consumer) {
      const marks = OPEN_JOB_STATES.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT r.* FROM assistant_requests r
             JOIN assistant_jobs j ON j.job_id = r.job_id
             LEFT JOIN assistant_request_deliveries d ON d.request_id = r.request_id AND d.consumer = ?
            WHERE r.conversation_id = ? AND (j.state IN (${marks}) OR d.job_revision IS NULL OR d.job_revision < j.revision)
            ORDER BY r.seq`,
        )
        .all(consumer, conversationId, ...OPEN_JOB_STATES) as unknown as Raw[];
      return rows.map(view).filter((request): request is RequestView => request !== null);
    },
    ack(requestId, consumer, revision) {
      const row = db.prepare('SELECT * FROM assistant_requests WHERE request_id = ?').get(requestId) as unknown as Raw | undefined;
      const job = row === undefined ? null : jobs.getJob(row.job_id);
      if (job === null) return { ok: false, reason: 'not_found' };
      if (OPEN_JOB_STATES.includes(job.state)) return { ok: false, reason: 'not_terminal' };
      if (job.revision !== revision) return { ok: false, reason: 'stale' };
      // Отметка только растёт: повтор и запоздавший ack старой ревизии её не откатывают.
      const changed = db
        .prepare(
          `INSERT INTO assistant_request_deliveries (request_id, consumer, job_revision, delivered_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(request_id, consumer) DO UPDATE SET job_revision = excluded.job_revision, delivered_at = excluded.delivered_at WHERE excluded.job_revision > job_revision`,
        )
        .run(requestId, consumer, revision, now()).changes;
      return { ok: true, reason: Number(changed) === 1 ? 'acked' : 'already_acked' };
    },
  };
}
