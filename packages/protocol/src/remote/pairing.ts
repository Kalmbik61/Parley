// Payload паринга (спека 7.4) и сокет управления, связанный с ним (5.3).
import { z } from 'zod';
import { deviceIdSchema, relayTokenSchema, routeIdSchema } from './relay.js';

/** Payload msg1 телефона. */
export const pairMsg1Payload = z.strictObject({
  v: z.literal(1),
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  app: z.string().min(1).max(32),
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
  relays: z.array(z.string().min(1).max(64)).min(1).max(16),
});
/** Транспортный кадр телефона: доступ получен. */
export const pairPairedFrame = z.strictObject({ t: z.literal('paired') });

/** 16 случайных байт b64url на каждое законченное рукопожатие. */
export const requestIdSchema = routeIdSchema;

export const pairRequestEvent = z.strictObject({
  requestId: requestIdSchema,
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  sas: z.string().regex(/^\d{6}$/),
  fingerprint: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
});
export const pairAnswerParams = z.strictObject({ requestId: requestIdSchema, allow: z.boolean() });
export const pairAnswerResult = z.strictObject({ ok: z.literal(true) });
/** Код отказа `pair.answer` для чужого, истёкшего или уже отвеченного запроса. */
export const PAIR_STALE_REQUEST = 'stale_request';

export const pairDoneEvent = z.strictObject({ requestId: requestIdSchema, deviceId: deviceIdSchema });
export const pairFailedEvent = z.strictObject({ requestId: requestIdSchema, reason: z.string().min(1).max(64) });

export const pairStartResult = z.strictObject({ qr: z.string().max(256), expiresAt: z.number().int().positive() });
export const controlStatusResult = z.strictObject({
  running: z.boolean(),
  host: z.enum(['starting', 'online', 'offline', 'incompatible']),
  relay: z.enum(['connected', 'connecting', 'error']),
  relayUrl: z.string().max(128).nullable(),
  devices: z.number().int().nonnegative(),
  version: z.string().max(64),
});
export const controlConfigureParams = z.strictObject({ relayUrl: z.string().min(1).max(64) });
export const controlPresenceParams = z.strictObject({ state: z.enum(['active', 'idle', 'locked']) });
export const controlRevokeParams = z.strictObject({ deviceId: deviceIdSchema });
export const controlAuditTailParams = z.strictObject({ limit: z.number().int().min(1).max(200) });
