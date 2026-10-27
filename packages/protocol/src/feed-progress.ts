import { z } from 'zod';

/** Отдельная проекция: не меняет FeedItem, FeedDecision и FEED_SCHEMA_VERSION. */
export const FEED_PROGRESS_ID_LIMIT = 128;
export const FEED_PROGRESS_RECENT_LIMIT = 20;
export const FEED_PROGRESS_MAX_BYTES = 16 * 1024;
export const FEED_PROGRESS_RETRY_AFTER_MAX_MS = 250;

/** Существующий RPC code `conflict`; нового ErrorCode для квоты нет. */
export interface ProgressRateLimitData {
  reason: 'island-progress-rate-limit';
  /** Конечное целое 0..FEED_PROGRESS_RETRY_AFTER_MAX_MS, не новый интервал source polling. */
  retryAfterMs: number;
}

const canonicalTime = z.string().length(24).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, { message: 'Expected a valid canonical UTC ISO24 timestamp.' });

export const progressLine = z.strictObject({
  // Wire id — opaque; host выдаёт SHA-256 lowercase hex64, без сырого tool id.
  id: z.string().min(1).max(FEED_PROGRESS_ID_LIMIT),
  at: canonicalTime,
  category: z.enum(['read', 'edit', 'execute', 'search', 'delegate', 'other']),
  status: z.enum(['running', 'done', 'failed', 'rejected']),
  endedAt: canonicalTime.optional(),
});
export type ProgressLine = z.infer<typeof progressLine>;

export const progressResult = z.strictObject({
  /** Feed revision в пределах SessionRef + connection generation + process lifecycle; не счётчик опроса. */
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Unavailable: пустая форма, revision=0 без feed state, иначе сохранённая feed revision. */
  availability: z.enum(['available', 'unavailable']),
  current: progressLine.nullable(),
  recent: z.array(progressLine).max(FEED_PROGRESS_RECENT_LIMIT),
  truncated: z.boolean(),
}).superRefine((value, context) => {
  if (new Set(value.recent.map((line) => line.id)).size !== value.recent.length) {
    context.addIssue({ code: 'custom', path: ['recent'], message: 'Recent progress ids must be unique.' });
  }
  if (value.availability === 'unavailable') {
    if (value.current !== null || value.recent.length !== 0 || value.truncated) {
      context.addIssue({ code: 'custom', message: 'Unavailable progress must not retain history.' });
    }
  } else {
    // Порядок задаёт projector: schema не сортирует по времени/id. Current — точная последняя running-строка.
    const last = value.recent.filter((line) => line.status === 'running').at(-1) ?? null;
    const current = value.current;
    if (last === null ? current !== null : current === null || current.id !== last.id || current.at !== last.at || current.category !== last.category || current.status !== last.status || current.endedAt !== last.endedAt) {
      context.addIssue({ code: 'custom', path: ['current'], message: 'Current must exactly match the last running row.' });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > FEED_PROGRESS_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Progress result exceeds the UTF-8 transport budget.' });
  }
});
export type ProgressResult = z.infer<typeof progressResult>;
