// Голос, jobs и карточки помощника на телефоне (план голоса, B3): схемы параметров, проекция job для телефона, правила
// параметров роли `remote` и события. Происхождение и связь job берутся из схем помощника, копий нет.
import { z } from 'zod';
import { assistantJobCorrelationSchema, assistantJobOriginSchema } from './job-schemas.js';
import { REMOTE_TEXT_LIMIT_BYTES, utf8Length } from './limits.js';

/** `sdp` ≤ 32 КиБ. */
export const REMOTE_SDP_LIMIT_BYTES = 32 * 1024;
/** `idempotencyKey`, `jobId`, `cardId`, `delegationId`. */
export const REMOTE_ID_RE = /^[\w.:-]{1,64}$/;
/** Идентификатор голосовой сессии OpenAI длиннее остальных: 1–128 знаков. */
const VOICE_SESSION_ID_RE = /^[\w.:-]{1,128}$/;

const id = z.string().regex(REMOTE_ID_RE);
const revision = z.number().int().nonnegative();

/** Две формы связи — из схемы помощника; сверх них у телефона `delegationId` подчиняется общему шаблону идентификатора. */
const correlation = assistantJobCorrelationSchema.refine((value) => !('delegationId' in value) || REMOTE_ID_RE.test(value.delegationId));

const text = z.string().min(1).refine((value) => utf8Length(value) <= REMOTE_TEXT_LIMIT_BYTES);

const sdp = z.string().min(1).refine((value) => utf8Length(value) <= REMOTE_SDP_LIMIT_BYTES);

/**
 * Параметры методов. Источник поручения (`origin`) в них нет: хост ставит `mobile` сам, телефон его не выбирает.
 * `strict`: лишний ключ — `bad_request`.
 */
export const voiceMethodSchemas = {
  'jobs.submit': z.strictObject({ text, idempotencyKey: id, correlation }),
  'jobs.get': z.strictObject({ jobId: id }),
  'jobs.cancel': z.strictObject({ jobId: id }),
  'voice.session.prepare': z.strictObject({ sdp }),
  'voice.session.close': z.strictObject({ voiceSessionId: z.string().regex(VOICE_SESSION_ID_RE) }),
  'voice.usage.get': z.strictObject({}),
} as const;

/** Те же ограничения для двух методов, чьи схемы живут в `assistant.ts` и проще (окно и Telegram зовут их без шаблона). */
const remoteOnlySchemas = {
  'jobs.ackInline': z.strictObject({ jobId: id, revision }),
  'cards.decide': z.strictObject({ cardId: id, revision, choice: z.enum(['send', 'cancel']) }),
} as const;

export const voiceParamRules: Readonly<Record<string, (params: unknown) => boolean>> = Object.fromEntries(
  Object.entries({ ...voiceMethodSchemas, ...remoteOnlySchemas }).map(([method, schema]) => [method, (params: unknown): boolean => schema.safeParse(params).success]),
);

const jobState = z.enum(['queued', 'running', 'needs_confirmation', 'completed', 'failed', 'cancelled']);

/**
 * Job так, как его видит телефон: без логов, `argv` и всего, чего нет в списке. Схема не `strict` намеренно: проекция
 * берёт поля по именам, лишнее отбрасывается ею, а не отказом.
 */
export const phoneJobSchema = z.object({
  jobId: z.string(),
  origin: assistantJobOriginSchema,
  state: jobState,
  revision: revision,
  requestText: z.string(),
  resultSummary: z.string().nullable(),
  provider: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deliveredInline: z.boolean(),
  correlation: assistantJobCorrelationSchema,
});
export type PhoneJob = z.infer<typeof phoneJobSchema>;

/** Проекция job для телефона по явному списку полей; не job — `null`. */
export function projectPhoneJob(raw: unknown): PhoneJob | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const j = raw as Record<string, unknown>;
  const parsed = phoneJobSchema.safeParse({
    jobId: j.jobId,
    origin: j.origin,
    state: j.state,
    revision: j.revision,
    requestText: j.requestText,
    resultSummary: j.resultSummary,
    provider: j.provider,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    deliveredInline: j.deliveredInline,
    correlation: j.correlation,
  });
  return parsed.success ? parsed.data : null;
}

/** Ответ `jobs.get` и `jobs.cancel` через ту же проекцию: хост шлёт уже проекцию, мост страхуется. */
export function projectJobResult(raw: unknown): { job: PhoneJob | null } {
  const job = typeof raw === 'object' && raw !== null ? (raw as { job?: unknown }).job : null;
  return { job: projectPhoneJob(job) };
}

export type VoicePrepareResult =
  | { ok: true; voiceSessionId: string; sdpAnswer: string }
  | { ok: false; code: 'busy' | 'no_key' | 'failed' | 'limit_reached'; message: string };

export interface VoiceUsage {
  limitSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
}

export interface VoiceMethodResults {
  'jobs.submit': { jobId: string; revision: number };
  'jobs.get': { job: PhoneJob | null };
  'jobs.cancel': { job: PhoneJob | null };
  'voice.session.prepare': VoicePrepareResult;
  'voice.session.close': { closed: boolean };
  'voice.usage.get': VoiceUsage;
}

/** События: `jobs.changed` несёт проекцию job, `voice.session.closed` — причину закрытия без секретов. */
export interface VoiceEvents {
  'jobs.changed': { job: PhoneJob };
  'voice.session.closed': { voiceSessionId: string; reason: string };
}
