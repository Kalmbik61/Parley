/**
 * Запись событий ядра помощника в каноническое хранилище уведомлений (спека 2026-11-03, T2b). Собственного состояния
 * нет: повторы гасит `dedupeKey` и переходы store. Нетерминальные job строк не дают; в строки идёт только конверт
 * (вид, opaque-id), текст поручения и результата в них не попадает.
 */

import type { AssistantCardChanged } from '@parley/protocol';
import type { Job } from '../assistant/jobs.js';
import { jobKey, needsConfirmationKey, type NotificationStore } from './store.js';

export interface IngestDeps {
  store: NotificationStore;
  hostId: string;
  now?: () => number;
}

export interface Ingest {
  onJob(job: Job): void;
  onCard(change: AssistantCardChanged): void;
}

export function createIngest(deps: IngestDeps): Ingest {
  const now = deps.now ?? Date.now;
  return {
    onJob(job) {
      if (job.state !== 'completed' && job.state !== 'failed' && job.state !== 'cancelled') return;
      deps.store.write(
        {
          dedupeKey: jobKey(job.jobId, job.state),
          eventId: `job:${job.jobId}:${job.revision}`,
          hostId: deps.hostId,
          entityRef: `job:${job.jobId}`,
          type: 'job-finished',
          severity: job.state === 'failed' ? 'warning' : 'info',
        },
        now(),
      );
    },
    onCard(change) {
      const key = needsConfirmationKey(change.cardId);
      if (change.state === 'needs_confirmation') {
        deps.store.write(
          {
            dedupeKey: key,
            eventId: `card:${change.cardId}:${change.revision}`,
            hostId: deps.hostId,
            entityRef: `card:${change.cardId}`,
            type: 'needs-confirmation',
            severity: 'critical',
            requiresAction: true,
          },
          now(),
        );
      } else if (change.state === 'decided') {
        // decidedVia === null: хост умер посреди действия (claim без канала), карточка уже не исполнима.
        if (change.decidedVia !== null) deps.store.ack(key, change.decidedVia, now());
        else deps.store.markExpired(key);
      } else {
        // expired и вытесненная карточка: окно действия закрыто, эскалация снимается без push.
        deps.store.markExpired(key);
      }
    },
  };
}
