/**
 * Связь голосовых поручений (спека «Голос↔Ассистент», §5, T5): инструмент job `link_request`. Первым шагом job сообщает,
 * вытесняет ли его Request прежние открытые Request разговора («нет, вместо этого…») или независим от них.
 *
 * Атомарность. Проверка и все изменения идут в одной транзакции SQLite (`BEGIN IMMEDIATE`): либо вытеснены все перечисленные
 * Request, либо ничего не изменилось. Для каждого вытесняемого Request проверяется, что он того же разговора и старше,
 * его версия равна ожидаемой, он не вытеснен ранее, его job не исполнил действия (каждый вызванный инструмент входит в
 * явный список «чтение плюс `propose_*`», job не в `needs_confirmation`), а ни одна карточка не подтверждена. Затем в той же
 * транзакции: `supersededBy` и `version + 1` у старого Request, отмена его job, если он ещё в очереди или идёт, и отзыв
 * ждущих карточек. Остановка процесса старого job, событие об отмене и очередь выполняются после COMMIT. Схемы «проверить,
 * потом отозвать» нет: второй вызов с той же версией видит уже поднятую `version` и получает отказ.
 *
 * Завершённый старый job отменённым не показывается: его состояние остаётся `completed`, итог только помечается
 * неактуальным (`stale`). Уже переданное в Live отозвать нельзя; ждущие карточки при этом отзываются.
 *
 * Частичный Request (`transcriptPartial`) не вытесняет ничего и не готовит действий (`proposeRefusal`). Независимый Request
 * (`supersedes: []`) разрешает ворота очереди: они считаются по `link_kind` (см. `requests.ts`).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CardRow, CardStore } from './cards.js';
import type { JobTokens } from './job-tokens.js';
import type { Jobs } from './jobs.js';
import type { Requests, RequestView } from './requests.js';

export const LINK_MAX_SUPERSEDES = 10;
const REASON_LIMIT = 500;

export interface LinkInput {
  supersedes: Array<{ requestId: string; expectedVersion: number }>;
  reason: string;
}

/** Отказ: статус для job и причина по-английски. Состояние при отказе не менялось. */
export interface LinkRefusal {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
}

export interface LinkSuccess {
  ok: true;
  kind: 'independent' | 'supersedes';
  /** Что стало с каждым вытесненным Request. */
  superseded: Array<{ requestId: string; jobCancelled: boolean; cardsWithdrawn: number }>;
  /** Отозванные карточки (для событий и экрана); их источник уже `superseded` в базе. */
  withdrawn: CardRow[];
  /** Ответ инструмента модели. */
  text: string;
}

export type LinkOutcome = LinkSuccess | LinkRefusal;

export interface RequestLinker {
  /** Вызов `link_request` от job `jobId` (его хост знает по токену); `raw` — аргументы модели, ей не верят. */
  link(jobId: string, raw: unknown): LinkOutcome;
  /**
   * Почему этот job не должен готовить карточки (`propose_*`): его Request частичный или уже вытеснен; `null` — можно.
   * Job без Request ограничений не имеет.
   */
  proposeRefusal(jobId: string): string | null;
}

export interface RequestLinkerDeps {
  db: DatabaseSync;
  requests: Pick<Requests, 'byJob' | 'get'>;
  jobs: Pick<Jobs, 'getJob' | 'beginCancel'>;
  cards: Pick<CardStore, 'get' | 'bySource' | 'withdrawBySource'>;
  /** Записи хоста о вызовах и карточках идущего job. */
  tokens: Pick<JobTokens, 'peek'>;
  /** Явный список инструментов, после которых job можно отменить (`JOB_CANCEL_SAFE_TOOLS`). */
  safeTools: readonly string[];
  now?(): number;
}

/** Отказ внутри транзакции: откатывает её и возвращается вызывающему как результат. */
class Refuse extends Error {
  constructor(
    readonly status: LinkRefusal['status'],
    message: string,
  ) {
    super(message);
  }
}

const refusal = (status: LinkRefusal['status'], error: string): LinkRefusal => ({ ok: false, status, error });

function parse(raw: unknown): LinkInput | LinkRefusal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refusal(400, 'Pass {supersedes: [...], reason: "..."}');
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input['supersedes'])) return refusal(400, 'supersedes must be an array; use [] when the request is independent');
  if (input['supersedes'].length > LINK_MAX_SUPERSEDES) return refusal(400, `supersedes lists more than ${LINK_MAX_SUPERSEDES} requests`);
  const seen = new Set<string>();
  const supersedes: LinkInput['supersedes'] = [];
  for (const item of input['supersedes'] as unknown[]) {
    const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
    const requestId = entry?.['requestId'];
    const expectedVersion = entry?.['expectedVersion'];
    if (typeof requestId !== 'string' || requestId === '' || typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return refusal(400, 'Every supersedes entry needs a requestId and an integer expectedVersion');
    }
    if (seen.has(requestId)) return refusal(400, `${requestId} is listed twice`);
    seen.add(requestId);
    supersedes.push({ requestId, expectedVersion });
  }
  const reason = typeof input['reason'] === 'string' ? input['reason'].trim().slice(0, REASON_LIMIT) : '';
  return { supersedes, reason };
}

export function createRequestLinker(deps: RequestLinkerDeps): RequestLinker {
  const { db, requests, jobs, cards, tokens } = deps;
  const now = deps.now ?? Date.now;

  /** Что хост записал о вызовах job: идущего — в памяти токена, закончившегося — в `JobResult`. */
  const toolsOf = (request: RequestView): string[] => [...tokens.peek(request.jobId).toolRefs.map((ref) => ref.tool), ...(request.job.result?.toolRefs.map((ref) => ref.tool) ?? [])];

  /** Карточки job: по источнику `job:<id>` и по записи хоста об их id; подтверждённая или решённая — повод отказать. */
  function decidedCardOf(request: RequestView): CardRow | null {
    const ids = new Set([...tokens.peek(request.jobId).cards.map((card) => card.cardId), ...(request.job.result?.cards.map((card) => card.cardId) ?? [])]);
    const rows = [...cards.bySource(`job:${request.jobId}`), ...[...ids].map((id) => cards.get(id)).filter((row): row is CardRow => row !== null)];
    return rows.find((row) => row.state === 'decided') ?? null;
  }

  /** Проверка одного вытесняемого Request; бросает `Refuse` с причиной. */
  function check(own: RequestView, target: { requestId: string; expectedVersion: number }): RequestView {
    const old = requests.get(target.requestId);
    // Чужой разговор и несуществующий Request отвечают одинаково: id чужого разговора модель не должна уметь зондировать.
    if (old === null || old.conversationId !== own.conversationId) throw new Refuse(404, `${target.requestId} is not an open request of this conversation`);
    if (old.requestId === own.requestId || old.seq > own.seq) throw new Refuse(409, `${old.requestId} is not older than this request`);
    if (old.supersededBy !== null) throw new Refuse(409, `${old.requestId} was already replaced`);
    if (old.version !== target.expectedVersion) throw new Refuse(409, `${old.requestId} changed: its version is ${old.version}, not ${target.expectedVersion}`);
    if (old.job.state === 'needs_confirmation') throw new Refuse(409, `${old.requestId} may have acted and waits for the person`);
    const stray = toolsOf(old).find((tool) => !deps.safeTools.includes(tool));
    if (stray !== undefined) throw new Refuse(409, `${old.requestId} already used ${stray}, which can have side effects`);
    if (decidedCardOf(old) !== null) throw new Refuse(409, `A card of ${old.requestId} was already confirmed or decided`);
    return old;
  }

  return {
    link(jobId, raw) {
      const input = parse(raw);
      if ('ok' in input) return input;
      const settlers: Array<() => void> = [];
      const superseded: LinkSuccess['superseded'] = [];
      const withdrawn: CardRow[] = [];
      let kind: LinkSuccess['kind'] = 'independent';
      db.exec('BEGIN IMMEDIATE');
      try {
        const own = requests.byJob(jobId);
        if (own === null) throw new Refuse(409, 'This task is not a voice request, so there is nothing to link');
        if (own.supersededBy !== null) throw new Refuse(409, 'This request was already replaced by a newer one');
        if (own.link !== null) throw new Refuse(409, `link_request was already called for this request (${own.link.kind})`);
        if (input.supersedes.length > 0 && own.transcriptPartial) throw new Refuse(409, 'This request has no complete transcript yet, so it cannot replace anything; use []');
        // Сначала проверяются все: один отказ откатывает всё, а не вытесняет часть.
        const olds = input.supersedes.map((target) => check(own, target));
        const stamp = now();
        for (const old of olds) {
          const changed = db
            .prepare('UPDATE assistant_requests SET superseded_by = ?, version = version + 1, updated_at = ? WHERE request_id = ? AND version = ? AND superseded_by IS NULL')
            .run(own.requestId, stamp, old.requestId, old.version).changes;
          if (Number(changed) !== 1) throw new Refuse(409, `${old.requestId} changed while linking`);
          let jobCancelled = false;
          if (old.job.state === 'queued' || old.job.state === 'running') {
            const cancel = jobs.beginCancel(old.jobId);
            if (cancel === null) throw new Refuse(409, `${old.requestId} could not be cancelled`);
            settlers.push(cancel.settle);
            jobCancelled = true;
          }
          const cardsWithdrawn = cards.withdrawBySource(`job:${old.jobId}`);
          withdrawn.push(...cardsWithdrawn);
          superseded.push({ requestId: old.requestId, jobCancelled, cardsWithdrawn: cardsWithdrawn.length });
        }
        kind = olds.length === 0 ? 'independent' : 'supersedes';
        const linked = db
          .prepare('UPDATE assistant_requests SET link_kind = ?, link_supersedes_json = ?, link_reason = ?, linked_at = ?, updated_at = ? WHERE request_id = ? AND link_kind IS NULL')
          .run(kind, JSON.stringify(olds.map((old) => old.requestId)), input.reason, stamp, stamp, own.requestId).changes;
        if (Number(linked) !== 1) throw new Refuse(409, 'link_request was already called for this request');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (error instanceof Refuse) return refusal(error.status, `Nothing was changed: ${error.message}`);
        throw error;
      }
      // После COMMIT: события, остановка процессов и очередь. Состояние уже на диске, откатить их нельзя и не нужно.
      for (const settle of settlers) settle();
      const cancelled = superseded.filter((item) => item.jobCancelled).length;
      return {
        ok: true,
        kind,
        superseded,
        withdrawn,
        text:
          kind === 'independent'
            ? 'Recorded: this request is independent of the earlier ones. Go on with the task.'
            : `Recorded: this request replaces ${superseded.length} earlier one(s); cancelled ${cancelled} running or queued task(s) and withdrew ${withdrawn.length} card(s). Go on with the task.`,
      };
    },
    proposeRefusal(jobId) {
      const own = requests.byJob(jobId);
      if (own === null) return null;
      if (own.transcriptPartial) return 'This request has no complete transcript yet: answer it, but do not prepare actions. Ask the person to say it again.';
      if (own.supersededBy !== null) return 'This request was replaced by a newer one: do not prepare actions for it.';
      return null;
    },
  };
}
