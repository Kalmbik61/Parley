/**
 * Локальная телеметрия голоса (спека «Голос↔Ассистент» §11, T6): небольшая ограниченная таблица `voice_telemetry` в базе
 * хоста. Остров присылает то, что измерил сам (`first_audio_ms`, `ack_audible`, `delegation_to_submit_ms`,
 * `transcript_wait_ms`, `result_hold_ms`, `speech_state`, `interrupts`); хост дописывает то, что знает точнее клиента:
 * `link_request_ms`, `job_duration_ms` (по Request и job), `superseded_count`, `voice_seconds` (по `voice_usage`) и
 * `voice_cost_estimate_usd` (оценка по `LIVE_USD_PER_MINUTE`, не счёт; без заданного тарифа поле `null`).
 *
 * Только числа, перечисления и id: ни аудио, ни транскрипта, ни текста поручения или итога — у схемы нет таких полей.
 * Записи одного ключа «сессия + Request» сливаются (`COALESCE`): новый факт дописывается, прежний не затирается.
 * Хранится не больше `TELEMETRY_MAX_ROWS` последних строк. Чтение для приёмки (T7) — `list`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { VoiceTelemetryRow } from '@parley/protocol';
import type { Jobs } from '../assistant/jobs.js';
import type { Requests } from '../assistant/requests.js';

export const TELEMETRY_MAX_ROWS = 500;

/**
 * Ориентировочный тариф Live, USD за минуту голоса. Источник: страница цен OpenAI для gpt-live-1, ориентировочная,
 * проверено 2026-11-04; то же значение в спеке «Голос↔Ассистент» и записке T0. `voice_cost_estimate_usd` — оценка, а не счёт.
 */
export const LIVE_USD_PER_MINUTE = 0.05;

export interface VoiceTelemetryInput {
  voiceSessionId: string;
  /** Нет — запись уровня сессии. */
  requestId?: string | undefined;
  firstAudioMs?: number | undefined;
  ackAudible?: boolean | 'unknown' | undefined;
  delegationToSubmitMs?: number | undefined;
  transcriptWaitMs?: number | undefined;
  resultHoldMs?: number | undefined;
  speechState?: 'queued' | 'submitted' | 'played' | 'unknown' | 'dropped' | undefined;
  interrupts?: number | undefined;
}

export interface VoiceTelemetry {
  record(input: VoiceTelemetryInput): void;
  /** Последние строки, новые первыми. */
  list(limit?: number): VoiceTelemetryRow[];
}

export interface VoiceTelemetryDeps {
  db: DatabaseSync;
  requests: Pick<Requests, 'get'>;
  jobs: Pick<Jobs, 'getJob'>;
  /** Тариф, USD за минуту голоса; `null` или отсутствие — стоимость не считается. */
  usdPerMinute?(): number | null;
  now?(): number;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_confirmation']);

const COLUMNS = [
  'first_audio_ms',
  'ack_audible',
  'delegation_to_submit_ms',
  'transcript_wait_ms',
  'link_request_ms',
  'job_duration_ms',
  'result_hold_ms',
  'speech_state',
  'interrupts',
  'superseded_count',
  'voice_seconds',
  'voice_cost_estimate_usd',
] as const;

type Column = (typeof COLUMNS)[number];
type Values = Partial<Record<Column, number | string | null>>;

interface Raw extends Record<string, unknown> {
  voice_session_id: string;
  request_id: string;
  at: number;
}

const wholeOrNull = (value: number | undefined): number | null => (value === undefined ? null : Math.max(0, Math.round(value)));

export function createVoiceTelemetry(deps: VoiceTelemetryDeps): VoiceTelemetry {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  /** Что хост знает о Request сам. */
  function ofRequest(requestId: string): Values {
    const request = deps.requests.get(requestId);
    if (request === null) return {};
    const job = deps.jobs.getJob(request.jobId);
    const values: Values = {};
    if (request.link !== null) values.link_request_ms = Math.max(0, request.link.linkedAt - request.createdAt);
    if (job !== null && TERMINAL.has(job.state)) values.job_duration_ms = Math.max(0, job.updatedAt - job.createdAt);
    return values;
  }

  /** Что хост знает о сессии сам: расход из `voice_usage` и число вытесненных Request. */
  function ofSession(voiceSessionId: string): Values {
    const values: Values = {};
    try {
      const usage = db.prepare('SELECT COALESCE(seconds_final, seconds_estimate) AS seconds FROM voice_usage WHERE voice_session_id = ?').get(voiceSessionId) as { seconds: number } | undefined;
      if (usage !== undefined) {
        values.voice_seconds = usage.seconds;
        const rate = deps.usdPerMinute?.() ?? null;
        if (rate !== null) values.voice_cost_estimate_usd = (usage.seconds / 60) * rate;
      }
      const stale = db.prepare("SELECT COUNT(*) AS n FROM assistant_requests WHERE json_extract(origin_key, '$[0]') = ? AND superseded_by IS NOT NULL").get(voiceSessionId) as { n: number };
      values.superseded_count = Number(stale.n);
    } catch {
      // учёта нет или он недоступен: телеметрия не ломает голос
    }
    return values;
  }

  return {
    record(input) {
      const requestId = input.requestId ?? '';
      const values: Values = {
        first_audio_ms: wholeOrNull(input.firstAudioMs),
        ack_audible: input.ackAudible === undefined ? null : String(input.ackAudible),
        delegation_to_submit_ms: wholeOrNull(input.delegationToSubmitMs),
        transcript_wait_ms: wholeOrNull(input.transcriptWaitMs),
        result_hold_ms: wholeOrNull(input.resultHoldMs),
        speech_state: input.speechState ?? null,
        interrupts: wholeOrNull(input.interrupts),
        ...(requestId === '' ? ofSession(input.voiceSessionId) : ofRequest(requestId)),
      };
      const names = COLUMNS;
      const marks = names.map(() => '?').join(', ');
      const merge = names.map((column) => `${column} = COALESCE(excluded.${column}, ${column})`).join(', ');
      db.prepare(
        `INSERT INTO voice_telemetry (voice_session_id, request_id, at, ${names.join(', ')}) VALUES (?, ?, ?, ${marks})
         ON CONFLICT(voice_session_id, request_id) DO UPDATE SET at = excluded.at, ${merge}`,
      ).run(input.voiceSessionId, requestId, now(), ...names.map((column) => values[column] ?? null));
      // Ограничение размера: остаются последние строки.
      db.prepare('DELETE FROM voice_telemetry WHERE id <= (SELECT MAX(id) FROM voice_telemetry) - ?').run(TELEMETRY_MAX_ROWS);
    },
    list(limit = 100) {
      const rows = db.prepare('SELECT * FROM voice_telemetry ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(TELEMETRY_MAX_ROWS, limit))) as Raw[];
      const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
      return rows.map((row): VoiceTelemetryRow => {
        const ack = row['ack_audible'];
        const speech = row['speech_state'];
        return {
          voice_session_id: row.voice_session_id,
          request_id: row.request_id === '' ? null : row.request_id,
          at: row.at,
          first_audio_ms: num(row['first_audio_ms']),
          ack_audible: ack === 'unknown' ? 'unknown' : ack === 'true' ? true : ack === 'false' ? false : null,
          delegation_to_submit_ms: num(row['delegation_to_submit_ms']),
          transcript_wait_ms: num(row['transcript_wait_ms']),
          link_request_ms: num(row['link_request_ms']),
          job_duration_ms: num(row['job_duration_ms']),
          result_hold_ms: num(row['result_hold_ms']),
          speech_state: speech === 'queued' || speech === 'submitted' || speech === 'played' || speech === 'unknown' || speech === 'dropped' ? speech : null,
          interrupts: num(row['interrupts']),
          superseded_count: num(row['superseded_count']),
          voice_seconds: num(row['voice_seconds']),
          voice_cost_estimate_usd: num(row['voice_cost_estimate_usd']),
        };
      });
    },
  };
}
