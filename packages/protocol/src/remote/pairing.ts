// Payload паринга (спека 7.4) и сокет управления, связанный с ним (5.3).
import { z } from 'zod';
import { isValidRelayHost, plainText } from './qr.js';
import { deviceIdSchema, relayTokenSchema, routeIdSchema } from './relay.js';

const relayHost = z.string().refine(isValidRelayHost, 'invalid relay address');

/** Payload msg1 телефона. */
export const pairMsg1Payload = z.strictObject({
  v: z.literal(1),
  name: plainText(64),
  platform: plainText(32),
  app: plainText(32),
});
/** Payload msg2 моста: пустой, без доступа и без имени Мака. */
export const pairMsg2Payload = z.strictObject({ v: z.literal(1) });

/** Транспортный кадр моста после «Allow». */
export const pairCredentialsFrame = z.strictObject({
  t: z.literal('credentials'),
  hostId: z.string().min(1).max(64),
  hostName: z.string().max(256),
  deviceId: deviceIdSchema,
  routeId: routeIdSchema,
  relayToken: relayTokenSchema,
  relays: z.array(relayHost).min(1).max(16),
});
/** Транспортный кадр телефона: доступ получен. */
export const pairPairedFrame = z.strictObject({ t: z.literal('paired') });

/** 16 случайных байт b64url на каждое законченное рукопожатие. */
export const requestIdSchema = routeIdSchema;

export const pairRequestEvent = z.strictObject({
  requestId: requestIdSchema,
  name: plainText(64),
  platform: plainText(32),
  sas: z.string().regex(/^\d{6}$/),
  fingerprint: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
});
export const pairAnswerParams = z.strictObject({ requestId: requestIdSchema, allow: z.boolean() });
export const pairAnswerResult = z.strictObject({ ok: z.literal(true) });
/** Код отказа `pair.answer` для чужого, истёкшего или уже отвеченного запроса. */
export const PAIR_STALE_REQUEST = 'stale_request';

export const pairDoneEvent = z.strictObject({ requestId: requestIdSchema, deviceId: deviceIdSchema });
/** Причины провала паринга (7.4). */
export const PAIR_FAILED_REASONS = ['bad-psk', 'timeout', 'no-ack', 'denied', 'offer_closed'] as const;
export const pairFailedEvent = z.strictObject({ requestId: requestIdSchema, reason: z.enum(PAIR_FAILED_REASONS) });
/**
 * Оффер израсходован первым msg1 (7.4), QR больше не работает. `bad-psk` — неверный код, запроса не будет: окно
 * перевыпускает QR сразу. `used` — оффер принят; дальше `pair.request` или провал без запроса.
 */
export const PAIR_OFFER_CLOSED_REASONS = ['bad-psk', 'used'] as const;
export const pairOfferClosedEvent = z.strictObject({ reason: z.enum(PAIR_OFFER_CLOSED_REASONS) });

/**
 * Весомое действие телефона (спека 12, правки 18): окно показывает уведомление macOS с «Revoke this phone». Без текстов
 * агентов: цель — `ref` сессии (`session-create`, `allow-always`, `plan-auto-accept`), realpath папки (`trust-folder`),
 * имя провайдера (`provider-switch`) или realpath репозитория и имена включённых серверов MCP (`mcp-enable`, A36a: без
 * команд, `env` и отпечатков).
 */
export const PHONE_ACTION_KINDS = ['session-create', 'trust-folder', 'provider-switch', 'allow-always', 'plan-auto-accept', 'mcp-enable'] as const;
export type PhoneActionKind = (typeof PHONE_ACTION_KINDS)[number];
const phoneActionRef = z.strictObject({
  projectPath: z.string().min(1).max(4096),
  workId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
});
const phoneActionMcp = z.strictObject({
  repo: z.string().min(1).max(4096),
  servers: z.array(z.string().min(1).max(200)).min(1).max(200),
});
export const phoneActionEvent = z
  .strictObject({
    deviceId: deviceIdSchema,
    kind: z.enum(PHONE_ACTION_KINDS),
    target: z.union([phoneActionRef, phoneActionMcp, z.string().min(1).max(4096)]),
  })
  // Цель `{repo, servers}` — только у `mcp-enable`, и у него только она.
  .refine((event) => (event.kind === 'mcp-enable') === (typeof event.target === 'object' && 'repo' in event.target), {
    message: 'mcp-enable takes {repo, servers} and only it does',
  });
export type PhoneActionEvent = z.infer<typeof phoneActionEvent>;

export const pairStartResult = z.strictObject({ qr: z.string().max(256), expiresAt: z.number().int().positive() });
export const controlStatusResult = z.strictObject({
  running: z.boolean(),
  host: z.enum(['starting', 'online', 'offline', 'incompatible']),
  relay: z.enum(['connected', 'connecting', 'error']),
  relayUrl: relayHost.nullable(),
  devices: z.number().int().nonnegative(),
  version: z.string().max(64),
});
export const controlConfigureParams = z.strictObject({ relayUrl: relayHost });
export const controlPresenceParams = z.strictObject({ state: z.enum(['active', 'idle', 'locked']) });
export const controlRevokeParams = z.strictObject({ deviceId: deviceIdSchema });
export const controlAuditTailParams = z.strictObject({ limit: z.number().int().min(1).max(200) });
