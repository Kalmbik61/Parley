/**
 * Каноническое хранилище уведомлений (спека 2026-11-03, T1): пассивный сток событий и durable outbox доставки.
 * В строках только конверт: вид события, счётчики, маршруты и opaque-id; названий проектов, текстов агентов, команд
 * и секретов тут нет, а `write` отвергает всё, что не похоже на opaque-id. Прошлые события не заливаются: строки
 * появляются только от `write` живого события. Повтор с тем же `dedupeKey` (reconnect, рестарт) строки не создаёт.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationState = 'new' | 'seen' | 'acked' | 'expired';
export type NotificationVia = 'island' | 'telegram' | 'mobile';
export type OutboxState = 'pending' | 'sent' | 'failed';

export interface NewNotification {
  dedupeKey: string;
  eventId: string;
  hostId: string;
  workspaceId?: string;
  entityRef: string;
  /** Вид события (kebab/snake-слово), не текст. */
  type: string;
  severity: NotificationSeverity;
  requiresAction?: boolean;
  payloadRef?: string;
  /** Каналы, для которых заводится запись outbox. По умолчанию — ни одного. */
  channels?: readonly string[];
}

export interface NotificationRow {
  id: number;
  dedupeKey: string;
  eventId: string;
  hostId: string;
  workspaceId: string | null;
  entityRef: string;
  type: string;
  severity: NotificationSeverity;
  createdAt: number;
  revision: number;
  requiresAction: boolean;
  payloadRef: string | null;
  notificationId: string;
  state: NotificationState;
  seenAt: number | null;
  ackedAt: number | null;
  ackedVia: NotificationVia | null;
}

export interface OutboxRow {
  id: number;
  notificationId: string;
  channel: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: number;
  sentAt: number | null;
}

export interface WriteResult {
  row: NotificationRow;
  /** `false`: строка с таким `dedupeKey` уже была, ничего не записано. */
  created: boolean;
}

/** Предел попыток доставки: после него запись outbox становится `failed` и не повторяется. */
export const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 10 * 60_000;
/** Аренда записи outbox при выдаче: пока она не истекла, та же запись второму вызову не отдаётся. */
export const LEASE_MS = 60_000;

/** Ключ события job в терминальном состоянии. */
export const jobKey = (jobId: string, terminalState: string): string => `job:${jobId}:${terminalState}`;
/** Ключ карточки, ждущей подтверждения. */
export const needsConfirmationKey = (cardId: string): string => `needs_confirmation:${cardId}`;

/**
 * Opaque-id/маршрут: латиница, цифры и `: _ . - /`; начинается с буквы или цифры (абсолютный путь не проходит), без `..`
 * и `//`, без видимых корней пользовательских путей; пробелов и кириллицы (пользовательского текста) нет.
 */
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$/;
const USER_PATH = /(^|[/:])(users|home|var|tmp|etc|private|volumes)\//i;
const isOpaque = (value: string): boolean => OPAQUE.test(value) && !value.includes('..') && !value.includes('//') && !USER_PATH.test(value);
const KIND = /^[a-z][a-z0-9_-]{0,63}$/;

function assertEnvelope(n: NewNotification): void {
  const opaque: [string, string | undefined][] = [
    ['dedupeKey', n.dedupeKey],
    ['eventId', n.eventId],
    ['hostId', n.hostId],
    ['workspaceId', n.workspaceId],
    ['entityRef', n.entityRef],
    ['payloadRef', n.payloadRef],
  ];
  for (const [name, value] of opaque) {
    if (value !== undefined && !isOpaque(value)) throw new Error(`Notification ${name} must be an opaque id`);
  }
  if (!KIND.test(n.type)) throw new Error('Notification type must be a kind word');
  for (const channel of n.channels ?? []) if (!KIND.test(channel)) throw new Error('Notification channel must be a kind word');
}

interface Raw {
  id: number;
  dedupe_key: string;
  event_id: string;
  host_id: string;
  workspace_id: string | null;
  entity_ref: string;
  type: string;
  severity: NotificationSeverity;
  created_at: number;
  revision: number;
  requires_action: number;
  payload_ref: string | null;
  notification_id: string;
  state: NotificationState;
  seen_at: number | null;
  acked_at: number | null;
  acked_via: NotificationVia | null;
}

const fromRaw = (r: Raw): NotificationRow => ({
  id: Number(r.id),
  dedupeKey: r.dedupe_key,
  eventId: r.event_id,
  hostId: r.host_id,
  workspaceId: r.workspace_id,
  entityRef: r.entity_ref,
  type: r.type,
  severity: r.severity,
  createdAt: Number(r.created_at),
  revision: Number(r.revision),
  requiresAction: Number(r.requires_action) === 1,
  payloadRef: r.payload_ref,
  notificationId: r.notification_id,
  state: r.state,
  seenAt: r.seen_at === null ? null : Number(r.seen_at),
  ackedAt: r.acked_at === null ? null : Number(r.acked_at),
  ackedVia: r.acked_via,
});

interface RawOutbox {
  id: number;
  notification_id: string;
  channel: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: number;
  sent_at: number | null;
}

const outboxFromRaw = (r: RawOutbox): OutboxRow => ({
  id: Number(r.id),
  notificationId: r.notification_id,
  channel: r.channel,
  state: r.state,
  attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at),
  sentAt: r.sent_at === null ? null : Number(r.sent_at),
});

export interface NotificationStore {
  /** Новое событие; повтор с тем же `dedupeKey` возвращает существующую строку и `created: false`. */
  write(n: NewNotification, now: number): WriteResult;
  get(dedupeKey: string): NotificationRow | null;
  /** Решение принято в одном из каналов: строка `acked` (один раз; `false` — уже обработана или её нет). */
  ack(dedupeKey: string, via: NotificationVia, now: number): boolean;
  /** Показано пользователю: `new` → `seen`. */
  seen(dedupeKey: string, now: number): boolean;
  /** Окно действия закрылось: строка терминальна, ожидающая доставка снимается. */
  markExpired(dedupeKey: string): boolean;
  /**
   * Записи outbox, которым пора на отправку, с арендой: выданная запись не выдаётся снова, пока аренда (`LEASE_MS`)
   * не истекла; истёкшая (в том числе после рестарта) снова due. Доставка at-least-once: отправка дольше аренды может уйти дважды. Отдаются только строки, чьё уведомление ещё `new`/`seen`.
   */
  dueOutbox(now: number): OutboxRow[];
  markSent(outboxId: number, now: number): void;
  /** Неудача доставки: следующая попытка через экспоненциальную паузу с jitter, после `MAX_ATTEMPTS` — `failed`. */
  markFailed(outboxId: number, now: number): OutboxRow | null;
}

export function createNotificationStore(db: DatabaseSync, random: () => number = Math.random): NotificationStore {
  const byKey = (key: string): NotificationRow | null => {
    const row = db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?').get(key) as unknown as Raw | undefined;
    return row === undefined ? null : fromRaw(row);
  };
  const outboxById = (id: number): OutboxRow | null => {
    const row = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(id) as unknown as RawOutbox | undefined;
    return row === undefined ? null : outboxFromRaw(row);
  };
  /** Снимает ожидающие записи outbox строки: событие закрыто, доставлять нечего. */
  const dropPending = (notificationId: string): void => {
    db.prepare(`DELETE FROM notification_outbox WHERE notification_id = ? AND state = 'pending'`).run(notificationId);
  };
  /** Смена состояния строки и снятие её очереди — одна транзакция (вложенный вызов использует внешнюю). */
  const atomically = <T>(fn: () => T): T => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    write(n, now) {
      assertEnvelope(n);
      db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = db
          .prepare(
            `INSERT INTO notifications (dedupe_key, event_id, host_id, workspace_id, entity_ref, type, severity, created_at, revision, requires_action, payload_ref, notification_id, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'new') ON CONFLICT(dedupe_key) DO NOTHING`,
          )
          .run(n.dedupeKey, n.eventId, n.hostId, n.workspaceId ?? null, n.entityRef, n.type, n.severity, now, n.requiresAction === true ? 1 : 0, n.payloadRef ?? null, randomUUID());
        const created = Number(inserted.changes) === 1;
        const row = byKey(n.dedupeKey) as NotificationRow;
        if (created) {
          for (const channel of n.channels ?? []) {
            db.prepare(`INSERT INTO notification_outbox (notification_id, channel, state, attempts, next_attempt_at) VALUES (?, ?, 'pending', 0, ?)`).run(row.notificationId, channel, now);
          }
        }
        db.exec('COMMIT');
        return { row, created };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    get: byKey,
    ack(dedupeKey, via, now) {
      const row = byKey(dedupeKey);
      if (row === null) return false;
      return atomically(() => {
        const changed = db
          .prepare(`UPDATE notifications SET state = 'acked', acked_at = ?, acked_via = ?, revision = revision + 1 WHERE dedupe_key = ? AND state IN ('new','seen')`)
          .run(now, via, dedupeKey).changes;
        if (Number(changed) !== 1) return false;
        dropPending(row.notificationId);
        return true;
      });
    },
    seen(dedupeKey, now) {
      const changed = db.prepare(`UPDATE notifications SET state = 'seen', seen_at = ?, revision = revision + 1 WHERE dedupe_key = ? AND state = 'new'`).run(now, dedupeKey).changes;
      return Number(changed) === 1;
    },
    markExpired(dedupeKey) {
      const row = byKey(dedupeKey);
      if (row === null) return false;
      return atomically(() => {
        const changed = db.prepare(`UPDATE notifications SET state = 'expired', revision = revision + 1 WHERE dedupe_key = ? AND state IN ('new','seen')`).run(dedupeKey).changes;
        if (Number(changed) !== 1) return false;
        dropPending(row.notificationId);
        return true;
      });
    },
    dueOutbox(now) {
      const rows = db
        .prepare(
          `UPDATE notification_outbox SET next_attempt_at = ?
           WHERE id IN (
             SELECT o.id FROM notification_outbox o JOIN notifications n ON n.notification_id = o.notification_id
             WHERE o.state = 'pending' AND o.next_attempt_at <= ? AND n.state IN ('new','seen'))
           RETURNING *`,
        )
        .all(now + LEASE_MS, now) as unknown as RawOutbox[];
      return rows.map(outboxFromRaw).sort((x, y) => x.id - y.id);
    },
    markSent(outboxId, now) {
      db.prepare(`UPDATE notification_outbox SET state = 'sent', sent_at = ? WHERE id = ? AND state = 'pending'`).run(now, outboxId);
    },
    markFailed(outboxId, now) {
      const row = outboxById(outboxId);
      if (row === null || row.state !== 'pending') return row;
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE notification_outbox SET state = 'failed', attempts = ? WHERE id = ?`).run(attempts, outboxId);
      } else {
        const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
        const delay = Math.round(base * (0.5 + random() * 0.5));
        db.prepare(`UPDATE notification_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, now + delay, outboxId);
      }
      return outboxById(outboxId);
    },
  };
}
