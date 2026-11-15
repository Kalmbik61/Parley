/**
 * Durable jobs Assistant Core (спека 2026-11-03, C2): поручение помощнику, которое идёт отдельным прогоном CLI и не
 * зависит от окна и голосовой сессии. Job не трогает разговор (`runAsk`, `stopTurn`): прогон запускает `execute`.
 * Кап — не больше двух параллельных jobs на провайдера, остальные ждут в `queued`. `completed` — ответ готов (чтение
 * кончается им вместе с `toolRefs` хоста); `needs_confirmation` — действие заявлено без карточки или исход после
 * рестарта неизвестен: такой job не повторяется.
 *
 * Служебный job (происхождение `system`, спека автономии §6.3) — сообщение хоста человеку: пересказ ответа сессии или
 * итог действия. Человеческие job запускаются раньше служебных, служебный идёт один за раз, событий слежения в очереди не
 * больше `SERVICE_QUEUE_WATCH`, а не начатый за `SERVICE_TTL_MS` служебный job закрывается готовым текстом без прогона.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AssistantJobCorrelation, AssistantJobOrigin } from '@parley/protocol';
import { REMOTE_JOB_CONTEXT_LIMIT_BYTES, type PhoneJobContext } from '@parley/protocol/remote';
import { HostError } from '../errors.js';
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

/**
 * Служебный job (спека автономии §6.3): вид сообщения, группа замены и готовый текст. Лежит в `context_json` job
 * происхождения `system` (у него нет реплик телефона).
 */
export interface ServiceTag {
  /** `watch` — событие слежения за сессией; `outcome` — итог автономного действия (при переполнении не снимается). */
  kind: 'watch' | 'outcome';
  /** Сессия события слежения: новое событие той же группы заменяет ждущее. `null` — не заменяется. */
  group: string | null;
  /** Итог, которым job закрывается без прогона, если не начат за `SERVICE_TTL_MS`. */
  fallback: string;
}

/**
 * Служебный job снят из очереди: `replaced` — ждёт более новое событие той же сессии (`by` — его job), `overflow` —
 * событий слежения больше предела (`by` — самое новое из оставшихся).
 */
export type ServiceDrop = { jobId: string; reason: 'replaced' | 'overflow'; by: string };

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
  /** Реплики разговора, пришедшие с телефоном (`jobs.submit`, m-3629); `null` — их не было. */
  context: PhoneJobContext | null;
  /** Служебный job (`origin: 'system'`); у остальных `null`. */
  service: ServiceTag | null;
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
  /**
   * Что добавить к резюме job, что был `running` при остановке хоста: исходы его автономных карточек (спека автономии
   * §5.3, `claimRestartOutcome` помощника), не длиннее `room` знаков. Зовётся внутри транзакции записи job: что она
   * пометила взятым, откатывается вместе с ней. `null` — нечего.
   */
  restartNote?(job: Job, room: number): string | null;
  /**
   * Служебный job, вернувшийся в очередь после `limit`, прошёл политику очереди и снял job (свой или чужой): их Request
   * помечаются неактуальными, о снятых переполнением — заметка человеку. При вставке то же делает `requests.submitService`.
   */
  onServiceDrop?(drops: ServiceDrop[]): void;
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
  /** Пишется только при создании job: повторный submit с тем же ключом контекст не меняет. */
  context?: PhoneJobContext;
  /** Только для `origin: 'system'`: вид служебного сообщения, группа замены и готовый текст. */
  service?: ServiceTag;
}

/** Окно прежних поручений телефона для промпта: сколько и как давно созданных (m-3629). */
export interface EarlierMobileQuery {
  limit: number;
  windowMs: number;
}

export type AckInlineResult = { ok: boolean; deliveredInline: boolean; reason: 'acked' | 'already_acked' | 'stale' | 'not_found' };

export interface Jobs {
  submitJob(input: SubmitInput): { jobId: string; revision: number };
  /**
   * Создание внутри чужой транзакции (служебный Request, спека автономии §6.3): job и снятие служебных job, которые он
   * заменяет или вытесняет, записываются сразу; события и очередь — в `settle()` после COMMIT. `created: false` — job с
   * этим ключом уже был, ничего не записано.
   */
  beginSubmit(input: SubmitInput): { jobId: string; revision: number; created: boolean; dropped: ServiceDrop[]; settle(): void };
  /** Закрывает ждущий служебный job готовым текстом без прогона (`completed`). Не служебный или не `queued` — `null`. */
  closeWithoutRun(jobId: string, text: string): Job | null;
  /** Отменяет ждущие служебные job этого вида (выключение режима); идущие не трогает. Возвращает отменённые. */
  cancelQueuedService(kind: ServiceTag['kind']): Job[];
  getJob(jobId: string): Job | null;
  /**
   * Прежние job телефона (`origin: 'mobile'`) для промпта: созданные в пределах `windowMs` до этого job (по `created_at`,
   * миллисекунды), без него самого, не больше `limit`, от старых к новым.
   */
  earlierMobile(jobId: string, query: EarlierMobileQuery): Job[];
  cancelJob(jobId: string): Job | null;
  /**
   * Отмена внутри чужой транзакции (`link_request`, T5): состояние `cancelled` записывается сразу (одним UPDATE, откатывается
   * вместе с транзакцией), а событие, остановка прогона и очередь выполняет `settle()` — его зовут после COMMIT. `null` —
   * job не в `queued`/`running` или у `running` нет прогона: отменять нечего.
   */
  beginCancel(jobId: string): { job: Job; settle(): void } | null;
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
/** Предел длины резюме job. */
const SUMMARY_LIMIT = 2000;
export const JOB_LIMIT_RETRY_MS = 5 * 60_000;
/** Срок жизни служебного job от создания, включая очередь (спека автономии §6.3). */
export const SERVICE_TTL_MS = 5 * 60_000;
/** Сколько событий слежения может ждать в очереди. */
export const SERVICE_QUEUE_WATCH = 5;

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
  context_json: string | null;
  provider: string;
  created_at: number;
  updated_at: number;
  delivered_inline: number;
}

const isService = (row: Raw): boolean => row.origin === 'system';

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
  context: row.context_json === null || isService(row) ? null : (JSON.parse(row.context_json) as PhoneJobContext),
  service: row.context_json === null || !isService(row) ? null : (JSON.parse(row.context_json) as ServiceTag),
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
  /** Ближайший срок ждущего служебного job: по нему очередь разбирается ещё раз. */
  let serviceTimer: NodeJS.Timeout | null = null;
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
  function write(jobId: string, from: readonly JobState[], state: JobState, summary: string | null, result: JobResult | null): boolean {
    const stamp = now();
    const marks = from.map(() => '?').join(',');
    const changed = db
      .prepare(`UPDATE assistant_jobs SET state = ?, revision = revision + 1, updated_at = ?, result_summary = COALESCE(?, result_summary), result_json = COALESCE(?, result_json) WHERE job_id = ? AND state IN (${marks})`)
      .run(state, stamp, summary, result === null ? null : JSON.stringify(result), jobId, ...from).changes;
    return Number(changed) === 1;
  }
  function move(jobId: string, from: readonly JobState[], state: JobState, summary: string | null = null, result: JobResult | null = null): Job | null {
    if (!write(jobId, from, state, summary, result)) return null;
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
    /** Запуск job: `busy` — провайдер занят, `later` — пауза после `limit`, `gone` — job отменили до запуска. */
    const tryStart = (job: Job): 'started' | 'busy' | 'later' | 'gone' => {
      if ((busy.get(job.provider) ?? 0) >= cap) return 'busy';
      if ((notBefore.get(job.jobId) ?? 0) > stamp) return 'later';
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
        return 'gone';
      }
      notBefore.delete(job.jobId);
      busy.set(job.provider, (busy.get(job.provider) ?? 0) + 1);
      launch(started);
      return 'started';
    };
    // Человеческие job — первыми, в порядке создания. Служебный идёт, только если ни один человеческий не ждёт слота
    // (job, отложенный лимитом подписки, слота не ждёт) и ни один служебный уже не идёт.
    let humanWaiting = false;
    for (const job of queued) if (job.service === null && tryStart(job) === 'busy') humanWaiting = true;
    const waiting: Job[] = [];
    for (const job of queued) {
      if (job.service === null) continue;
      // Не начат за срок — прогона не будет: job закрывается готовым текстом.
      if (stamp - job.createdAt >= SERVICE_TTL_MS) {
        closeQueued(job);
        continue;
      }
      waiting.push(job);
    }
    let serviceRunning = Number((db.prepare(`SELECT COUNT(*) AS n FROM assistant_jobs WHERE state = 'running' AND origin = 'system'`).get() as { n: number }).n);
    for (const job of waiting) {
      if (humanWaiting || serviceRunning > 0) break;
      if (tryStart(job) === 'started') serviceRunning += 1;
    }
    armServiceTimer(stamp);
  }

  /** Ждущий служебный job → `completed` с готовым текстом, без запуска. */
  function closeQueued(job: Job): Job | null {
    const text = job.service?.fallback ?? '';
    return move(job.jobId, ['queued'], 'completed', text, { answer: text, capturedAt: now(), cards: [], toolRefs: [] });
  }

  /** Таймер на ближайший срок ждущего служебного job: без него job, которому не дали слот, ждал бы следующего события. */
  function armServiceTimer(stamp: number): void {
    if (serviceTimer !== null) clearTimeout(serviceTimer);
    serviceTimer = null;
    // Срок есть только у job со своим `ServiceTag` (он лежит в `context_json`).
    const row = db.prepare(`SELECT MIN(created_at) AS at FROM assistant_jobs WHERE state = 'queued' AND origin = 'system' AND context_json IS NOT NULL`).get() as { at: number | null };
    if (row.at === null || stopped) return;
    serviceTimer = setTimeout(
      () => {
        serviceTimer = null;
        pump();
      },
      Math.max(0, Number(row.at) + SERVICE_TTL_MS - stamp),
    );
    serviceTimer.unref?.();
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
      const back = move(jobId, ['running'], 'queued', `Waiting for the provider limit: ${end.message}`.slice(0, 2000));
      // Событие слежения возвращается по тем же правилам, что при вставке: замена по сессии и предел очереди.
      const drops = back?.service?.kind === 'watch' ? admitWatch() : [];
      for (const drop of drops) emit(get(drop.jobId) as Job);
      if (drops.length > 0) {
        try {
          deps.onServiceDrop?.(drops);
        } catch (error) {
          deps.log?.(`assistant jobs: service drop was not recorded: ${(error as Error).message}`);
        }
      }
      if (back !== null && !drops.some((drop) => drop.jobId === jobId)) {
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

  /** Запись нового job и снятие служебных, что он заменяет или вытесняет; без событий и очереди. */
  function insert(input: SubmitInput): { job: Job; created: boolean; dropped: ServiceDrop[] } {
    const service = input.origin === 'system' ? (input.service ?? null) : null;
    const contextJson = service !== null ? JSON.stringify(service) : input.context === undefined ? null : JSON.stringify(input.context);
    // Хост не доверяет и схеме моста: длина проверяется ещё раз перед записью.
    if (service === null && contextJson !== null && Buffer.byteLength(contextJson, 'utf8') > REMOTE_JOB_CONTEXT_LIMIT_BYTES) throw new HostError('bad_request', 'job context is too long');
    const stamp = now();
    const jobId = `job-${stamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(
      `INSERT INTO assistant_jobs (job_id, idempotency_key, origin, correlation_json, state, revision, request_text, provider, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(jobId, input.idempotencyKey, input.origin, JSON.stringify(input.correlation), input.text, input.provider ?? deps.defaultProvider(), contextJson, stamp, stamp);
    const row = db.prepare('SELECT * FROM assistant_jobs WHERE idempotency_key = ?').get(input.idempotencyKey) as unknown as Raw;
    const job = fromRaw(row);
    const created = job.jobId === jobId;
    const dropped = created && service?.kind === 'watch' ? admitWatch() : [];
    return { job, created, dropped };
  }

  /**
   * Политика ждущих событий слежения (только запись, без событий): в группе (сессии) остаётся самое новое, сверх предела
   * снимаются старейшие. Зовётся при вставке и при возврате после `limit`.
   */
  function admitWatch(): ServiceDrop[] {
    const waiting = (db.prepare(`SELECT * FROM assistant_jobs WHERE state = 'queued' AND origin = 'system' ORDER BY created_at, rowid`).all() as unknown as Raw[])
      .map(fromRaw)
      .filter((job) => job.service?.kind === 'watch');
    const groupOf = (job: Job): string | null => job.service?.group ?? null;
    const newest = new Map<string, Job>();
    for (const job of waiting) {
      const group = groupOf(job);
      if (group !== null) newest.set(group, job);
    }
    const drops: ServiceDrop[] = [];
    const kept: Job[] = [];
    for (const job of waiting) {
      const group = groupOf(job);
      const top = group === null ? job : (newest.get(group) as Job);
      if (top !== job && write(job.jobId, ['queued'], 'cancelled', 'Replaced by a newer event of the same session', null)) drops.push({ jobId: job.jobId, reason: 'replaced', by: top.jobId });
      else kept.push(job);
    }
    const last = kept.at(-1);
    while (kept.length > SERVICE_QUEUE_WATCH && last !== undefined) {
      const oldest = kept.shift() as Job;
      if (write(oldest.jobId, ['queued'], 'cancelled', 'Dropped: too many service messages waiting', null)) drops.push({ jobId: oldest.jobId, reason: 'overflow', by: last.jobId });
    }
    return drops;
  }

  /** События нового job и снятых им служебных, затем очередь; повтор ключа ничего не оповещает. */
  function announce(jobId: string, created: boolean, dropped: readonly ServiceDrop[]): void {
    if (!created) return;
    for (const drop of dropped) emit(get(drop.jobId) as Job);
    emit(get(jobId) as Job);
    pump();
  }

  return {
    submitJob(input) {
      const { job, created, dropped } = insert(input);
      // Повторный submit с тем же ключом (reconnect, рестарт) ничего не запускает и не оповещает: job тот же.
      announce(job.jobId, created, dropped);
      return { jobId: job.jobId, revision: job.revision };
    },
    beginSubmit(input) {
      const { job, created, dropped } = insert(input);
      return { jobId: job.jobId, revision: job.revision, created, dropped, settle: () => announce(job.jobId, created, dropped) };
    },
    closeWithoutRun(jobId, text) {
      const job = get(jobId);
      if (job?.service === null || job?.service === undefined) return null;
      const closed = closeQueued({ ...job, service: { ...job.service, fallback: text } });
      if (closed !== null) pump();
      return closed;
    },
    cancelQueuedService(kind) {
      const waiting = (db.prepare(`SELECT * FROM assistant_jobs WHERE state = 'queued' AND origin = 'system' ORDER BY created_at, rowid`).all() as unknown as Raw[]).map(fromRaw);
      // Снятие ждущих слотов не освобождает: очередь не разбирается (на старте хоста это идёт до `recover`).
      return waiting.filter((job) => job.service?.kind === kind).flatMap((job) => move(job.jobId, ['queued'], 'cancelled', 'Cancelled: the autonomous mode was turned off') ?? []);
    },
    getJob: get,
    earlierMobile(jobId, query) {
      const row = db.prepare('SELECT created_at, rowid AS rid FROM assistant_jobs WHERE job_id = ?').get(jobId) as unknown as { created_at: number; rid: number } | undefined;
      if (row === undefined) return [];
      // `created_at` — миллисекунды числом: окно сравнивается числами. Берутся самые свежие из окна, отдаются от старых к новым.
      const rows = db
        .prepare(`SELECT * FROM assistant_jobs WHERE origin = 'mobile' AND job_id <> ? AND (created_at < ? OR (created_at = ? AND rowid < ?)) AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(jobId, row.created_at, row.created_at, row.rid, row.created_at - query.windowMs, query.limit) as unknown as Raw[];
      return rows.map(fromRaw).reverse();
    },
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
    beginCancel(jobId) {
      const run = runs.get(jobId);
      const partial = run?.partial?.() ?? null;
      const wrote = write(jobId, ['queued'], 'cancelled', null, null) || (run !== undefined && write(jobId, ['running'], 'cancelled', null, partial));
      if (!wrote) return null;
      return {
        job: get(jobId) as Job,
        settle: () => {
          emit(get(jobId) as Job);
          runs.delete(jobId);
          run?.cancel();
          pump();
        },
      };
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
        // Пересказ без эффектов: исход не «неизвестен», job закрывается своим готовым текстом.
        if (job.service !== null) {
          const text = job.service.fallback;
          move(job.jobId, ['running'], 'completed', text, { answer: text, capturedAt: now(), cards: [], toolRefs: [] });
          continue;
        }
        let verdict: 'confirmed' | 'unconfirmed' = 'unconfirmed';
        try {
          verdict = (await deps.verify?.(job)) ?? 'unconfirmed';
        } catch (error) {
          deps.log?.(`assistant jobs: verify ${job.jobId} failed: ${(error as Error).message}`);
        }
        // Нет подтверждения — исход неизвестен: человек решает, а не «успех» и не «провал».
        const [state, base] = verdict === 'confirmed' ? (['completed', 'Confirmed after the host restarted'] as const) : (['needs_confirmation', 'The host restarted while this job was running; the outcome is unknown'] as const);
        // Резюме и пометка взятых итогов карточек — одной транзакцией: сбой записи job итогов не теряет.
        db.exec('BEGIN IMMEDIATE');
        try {
          const note = deps.restartNote?.(job, SUMMARY_LIMIT - base.length - 1) ?? null;
          if (!write(job.jobId, ['running'], state, note === null ? base : `${base} ${note}`, null)) throw new Error('the job is no longer running');
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          deps.log?.(`assistant jobs: recover ${job.jobId} failed: ${(error as Error).message}`);
          continue;
        }
        emit(get(job.jobId) as Job);
      }
      pump();
    },
    stop() {
      stopped = true;
      if (serviceTimer !== null) clearTimeout(serviceTimer);
      serviceTimer = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const run of runs.values()) run.cancel();
      runs.clear();
    },
  };
}
