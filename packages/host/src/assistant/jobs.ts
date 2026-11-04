/**
 * Durable jobs Assistant Core (спека 2026-11-03, C2): поручение помощнику, которое идёт отдельным прогоном CLI и не
 * зависит от окна и голосовой сессии. Job не трогает разговор (`runAsk`, `stopTurn`): прогон запускает `execute`.
 * Кап — не больше двух параллельных jobs на провайдера, остальные ждут в `queued`. `completed` — ответ готов (чтение
 * кончается им вместе с `toolRefs` хоста); `needs_confirmation` — действие заявлено без карточки или исход после
 * рестарта неизвестен: такой job не повторяется.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AssistantJobCorrelation, AssistantJobOrigin } from '@parley/protocol';
import type { JobCardRef, JobToolRef } from './job-tokens.js';

export type JobOrigin = AssistantJobOrigin;
export type JobCorrelation = AssistantJobCorrelation;
export type JobState = 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';

/**
 * Итог job (план голоса, T1). `answer` — слова модели; `cards` и `toolRefs` записал хост по вызовам инструментов job,
 * модель их не пишет. `capturedAt` — когда итог снят: по нему голос решает, не устарел ли ответ.
 */
export interface JobResult {
  answer: string;
  capturedAt: number;
  cards: JobCardRef[];
  toolRefs: JobToolRef[];
}

export interface Job {
  jobId: string;
  idempotencyKey: string;
  origin: JobOrigin;
  correlation: JobCorrelation;
  state: JobState;
  /** Растёт на каждое изменение job и только вверх. */
  revision: number;
  requestText: string;
  resultSummary: string | null;
  /** Итог прогона; `null` — прогон не кончился успешно или итог не снимался (подтверждение после рестарта). */
  result: JobResult | null;
  provider: string;
  createdAt: number;
  updatedAt: number;
  /** Экран уже показал финал job (`ackInline`): push по этому событию не нужен. Читает раздел уведомлений. */
  deliveredInline: boolean;
}

/**
 * Чем кончился прогон CLI. `outcome` решает хост по записанному им, а не по тексту модели: `completed` — ответ готов,
 * `needs_confirmation` — действие заявлено без карточки, успех не объявляется.
 */
export type JobEnd =
  | { ok: true; summary: string; result: JobResult; outcome: 'completed' | 'needs_confirmation' }
  | { ok: false; kind: 'limit' | 'resume' | 'timeout' | 'cancelled' | 'start' | 'other'; message: string };

export interface JobRun {
  cancel(): void;
  /** Что job успел подготовить к этому моменту (карточки и вызовы хоста); `null` — ничего. Нужен отмене. */
  partial?(): JobResult | null;
  readonly done: Promise<JobEnd>;
}

export interface JobsDeps {
  db: DatabaseSync;
  /** Отдельный прогон CLI по job. Не разговор помощника. */
  execute(job: Job): JobRun;
  /** Провайдер по умолчанию, когда `submitJob` его не назвал. */
  defaultProvider(): string;
  /** Сверка реального состояния для job, что был `running` при остановке хоста. Нет сверки — исход неизвестен. */
  verify?(job: Job): Promise<'confirmed' | 'unconfirmed'>;
  now?(): number;
  log?(line: string): void;
  /** Пауза перед повтором job после `limit`. */
  limitRetryMs?: number;
  capPerProvider?: number;
}

export interface SubmitInput {
  origin: JobOrigin;
  text: string;
  idempotencyKey: string;
  correlation: JobCorrelation;
  provider?: string;
}

export type AckInlineResult = { ok: boolean; deliveredInline: boolean; reason: 'acked' | 'already_acked' | 'stale' | 'not_found' };

export interface Jobs {
  submitJob(input: SubmitInput): { jobId: string; revision: number };
  getJob(jobId: string): Job | null;
  cancelJob(jobId: string): Job | null;
  /**
   * Идемпотентно ставит флаг `deliveredInline` и больше ничего не меняет: ни состояние, ни ревизию, ни событие.
   * Принимается только ревизия финального состояния; ack устаревшей ревизии или живого job — `stale`.
   */
  ackInline(jobId: string, revision: number): AckInlineResult;
  onJobChanged(listener: (job: Job) => void): () => void;
  /** Старт хоста: job в `running` без процесса сверяется с реальностью; queued продолжают очередь. */
  recover(): Promise<void>;
  /** Остановка: прогоны гасятся, их job остаются `running` для `recover` следующего хоста. */
  stop(): void;
}

export const JOB_CAP_PER_PROVIDER = 2;
export const JOB_LIMIT_RETRY_MS = 5 * 60_000;

interface Raw {
  job_id: string;
  idempotency_key: string;
  origin: JobOrigin;
  correlation_json: string;
  state: JobState;
  revision: number;
  request_text: string;
  result_summary: string | null;
  result_json: string | null;
  provider: string;
  created_at: number;
  updated_at: number;
  delivered_inline: number;
}

const fromRaw = (row: Raw): Job => ({
  jobId: row.job_id,
  idempotencyKey: row.idempotency_key,
  origin: row.origin,
  correlation: JSON.parse(row.correlation_json) as JobCorrelation,
  state: row.state,
  revision: row.revision,
  requestText: row.request_text,
  resultSummary: row.result_summary,
  result: row.result_json === null ? null : (JSON.parse(row.result_json) as JobResult),
  provider: row.provider,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deliveredInline: row.delivered_inline === 1,
});

export function createJobs(deps: JobsDeps): Jobs {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const cap = deps.capPerProvider ?? JOB_CAP_PER_PROVIDER;
  const retryMs = deps.limitRetryMs ?? JOB_LIMIT_RETRY_MS;
  const listeners = new Set<(job: Job) => void>();
  const runs = new Map<string, JobRun>();
  /** Job после `limit`: до этого момента не стартует (в памяти — после рестарта повтор сразу). */
  const notBefore = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const get = (jobId: string): Job | null => {
    const row = db.prepare('SELECT * FROM assistant_jobs WHERE job_id = ?').get(jobId) as unknown as Raw | undefined;
    return row === undefined ? null : fromRaw(row);
  };
  const emit = (job: Job): void => {
    for (const listener of [...listeners]) {
      try {
        listener(job);
      } catch (error) {
        deps.log?.(`assistant jobs: listener failed: ${(error as Error).message}`);
      }
    }
  };
  /** Переход состояния; терминальные состояния не покидаются, поэтому финал событием выходит один раз. */
  function move(jobId: string, from: readonly JobState[], state: JobState, summary: string | null = null, result: JobResult | null = null): Job | null {
    const stamp = now();
    const marks = from.map(() => '?').join(',');
    const changed = db
      .prepare(`UPDATE assistant_jobs SET state = ?, revision = revision + 1, updated_at = ?, result_summary = COALESCE(?, result_summary), result_json = COALESCE(?, result_json) WHERE job_id = ? AND state IN (${marks})`)
      .run(state, stamp, summary, result === null ? null : JSON.stringify(result), jobId, ...from).changes;
    if (Number(changed) !== 1) return null;
    const job = get(jobId) as Job;
    emit(job);
    return job;
  }

  let pumping = false;
  let repump = false;
  function pump(): void {
    if (stopped) return;
    // move() сообщает слушателям синхронно; вложенный вызов откладывается, чтобы не пересчитывать занятость поверх устаревшей.
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    try {
      do {
        repump = false;
        pumpOnce();
      } while (repump && !stopped);
    } finally {
      pumping = false;
    }
  }

  function pumpOnce(): void {
    const stamp = now();
    const queued = (db.prepare(`SELECT * FROM assistant_jobs WHERE state = 'queued' ORDER BY created_at, rowid`).all() as unknown as Raw[]).map(fromRaw);
    const busy = new Map<string, number>();
    for (const row of db.prepare(`SELECT provider, COUNT(*) AS n FROM assistant_jobs WHERE state = 'running' GROUP BY provider`).all() as unknown as Array<{ provider: string; n: number }>) {
      busy.set(row.provider, Number(row.n));
    }
    for (const job of queued) {
      if ((busy.get(job.provider) ?? 0) >= cap) continue;
      if ((notBefore.get(job.jobId) ?? 0) > stamp) continue;
      // move() сообщает слушателям синхронно, и слушатель может отменить job до запуска: заглушка принимает отмену.
      const early = { cancelled: false };
      runs.set(job.jobId, {
        cancel: () => {
          early.cancelled = true;
        },
        done: new Promise<JobEnd>(() => {}),
      });
      const started = move(job.jobId, ['queued'], 'running');
      if (started === null || early.cancelled) {
        runs.delete(job.jobId);
        continue;
      }
      notBefore.delete(job.jobId);
      busy.set(job.provider, (busy.get(job.provider) ?? 0) + 1);
      launch(started);
    }
  }

  function launch(job: Job): void {
    let run: JobRun;
    try {
      run = deps.execute(job);
    } catch (error) {
      finish(job.jobId, { ok: false, kind: 'start', message: (error as Error).message });
      return;
    }
    runs.set(job.jobId, run);
    void run.done.then(
      (end) => finish(job.jobId, end),
      (error: unknown) => finish(job.jobId, { ok: false, kind: 'other', message: (error as Error).message }),
    );
  }

  function finish(jobId: string, end: JobEnd): void {
    runs.delete(jobId);
    if (stopped) return; // job остаётся `running`: исход сверит `recover` следующего хоста
    if (end.ok) {
      if (end.outcome === 'completed') move(jobId, ['running'], 'completed', end.summary, end.result);
      else move(jobId, ['running'], 'needs_confirmation', `Not confirmed by the host: ${end.summary}`.slice(0, 2000), end.result);
    } else if (end.kind === 'cancelled') {
      move(jobId, ['running'], 'cancelled', end.message);
    } else if (end.kind === 'limit') {
      // Лимит подписки — не провал: job возвращается в очередь и повторяется позже.
      if (move(jobId, ['running'], 'queued', `Waiting for the provider limit: ${end.message}`.slice(0, 2000)) !== null) {
        notBefore.set(jobId, now() + retryMs);
        const timer = setTimeout(() => {
          timers.delete(timer);
          pump();
        }, retryMs);
        timer.unref?.();
        timers.add(timer);
      }
    } else {
      move(jobId, ['running'], 'failed', end.message.slice(0, 2000));
    }
    pump();
  }

  return {
    submitJob(input) {
      const stamp = now();
      const jobId = `job-${stamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      db.prepare(
        `INSERT INTO assistant_jobs (job_id, idempotency_key, origin, correlation_json, state, revision, request_text, provider, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(jobId, input.idempotencyKey, input.origin, JSON.stringify(input.correlation), input.text, input.provider ?? deps.defaultProvider(), stamp, stamp);
      const row = db.prepare('SELECT * FROM assistant_jobs WHERE idempotency_key = ?').get(input.idempotencyKey) as unknown as Raw;
      const job = fromRaw(row);
      // Повторный submit с тем же ключом (reconnect, рестарт) ничего не запускает и не оповещает: job тот же.
      if (job.jobId === jobId) {
        emit(job);
        pump();
      }
      return { jobId: job.jobId, revision: job.revision };
    },
    getJob: get,
    cancelJob(jobId) {
      const run = runs.get(jobId);
      // Карточки, что job уже показал человеку, остаются в итоге отменённого job: их можно найти и отозвать.
      const partial = run?.partial?.() ?? null;
      const job = move(jobId, ['queued', 'needs_confirmation'], 'cancelled') ?? (run === undefined ? null : move(jobId, ['running'], 'cancelled', null, partial));
      if (job !== null) {
        runs.delete(jobId);
        run?.cancel();
        pump();
        return job;
      }
      return get(jobId);
    },
    ackInline(jobId, revision) {
      const job = get(jobId);
      if (job === null) return { ok: false, deliveredInline: false, reason: 'not_found' };
      if (!['completed', 'failed', 'cancelled'].includes(job.state) || job.revision !== revision) return { ok: false, deliveredInline: job.deliveredInline, reason: 'stale' };
      const changed = db.prepare('UPDATE assistant_jobs SET delivered_inline = 1 WHERE job_id = ? AND delivered_inline = 0').run(jobId).changes;
      return { ok: true, deliveredInline: true, reason: Number(changed) === 1 ? 'acked' : 'already_acked' };
    },
    onJobChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async recover() {
      const orphans = (db.prepare(`SELECT * FROM assistant_jobs WHERE state = 'running'`).all() as unknown as Raw[]).map(fromRaw).filter((job) => !runs.has(job.jobId));
      for (const job of orphans) {
        let verdict: 'confirmed' | 'unconfirmed' = 'unconfirmed';
        try {
          verdict = (await deps.verify?.(job)) ?? 'unconfirmed';
        } catch (error) {
          deps.log?.(`assistant jobs: verify ${job.jobId} failed: ${(error as Error).message}`);
        }
        // Нет подтверждения — исход неизвестен: человек решает, а не «успех» и не «провал».
        if (verdict === 'confirmed') move(job.jobId, ['running'], 'completed', 'Confirmed after the host restarted');
        else move(job.jobId, ['running'], 'needs_confirmation', 'The host restarted while this job was running; the outcome is unknown');
      }
      pump();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const run of runs.values()) run.cancel();
      runs.clear();
    },
  };
}
