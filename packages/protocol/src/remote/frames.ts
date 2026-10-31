// Кадры приложения поверх Noise (спека 8), методы и события моста.
import { z } from 'zod';
import { REMOTE_PROTOCOL } from './allowlist.js';
import { isValidRelayHost, plainText } from './qr.js';

/** `id` телефона — строка до 32 знаков; мост подменяет её своей для хоста. */
export const frameIdSchema = z.string().min(1).max(32);

export const appRequestFrame = z.strictObject({
  id: frameIdSchema,
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
});
export const appErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(4096),
  data: z.unknown().optional(),
});
export const appResultFrame = z.strictObject({ id: frameIdSchema, result: z.unknown() });
export const appErrorFrame = z.strictObject({ id: frameIdSchema, error: appErrorSchema });
export const appResponseFrame = z.union([appResultFrame, appErrorFrame]);
export const appEventFrame = z.strictObject({ event: z.string().min(1).max(128), data: z.unknown() });

export const BRIDGE_ERROR_CODES = ['rate_limited', 'host_offline', 'too_large'] as const;

export const hostStateSchema = z.enum(['starting', 'online', 'offline', 'incompatible']);
export const stageSchema = z.enum(['A', 'B', 'C']);

/** Hello моста — payload msg2 подключения (8.2). */
export const bridgeHelloSchema = z.object({
  protocol: z.literal(REMOTE_PROTOCOL),
  minClient: z.string().regex(/^\d+\.\d+\.\d+$/),
  hostId: z.string().min(1).max(64),
  hostName: z.string().max(256),
  bridgeVersion: z.string().max(64),
  hostVersion: z.string().max(64).nullable(),
  host: hostStateSchema,
  epoch: z.string().max(64).nullable(),
  stage: stageSchema,
  methods: z.array(z.string().max(128)).max(512),
  events: z.array(z.string().max(128)).max(512),
  relays: z.array(z.string().refine(isValidRelayHost, 'invalid relay address')).max(16),
  serverTime: z.number().int().nonnegative(),
});
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;

/** События моста (8.3). */
export const bridgeEventSchemas = {
  'bridge.status': z.strictObject({ host: hostStateSchema, epoch: z.string().max(64).nullable() }),
  // `items` — кэш активности моста; форму элемента задаёт мост, клиент разбирает его сам.
  'activity.snapshot': z.strictObject({ epoch: z.string().max(64).nullable(), items: z.array(z.unknown()) }),
  'session.closing': z.strictObject({
    reason: z.enum(['revoked', 'reset', 'rekey', 'replaced', 'shutdown', 'slow', 'protocol']),
  }),
} as const;

export const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;
export const pushEnvSchema = z.enum(['sandbox', 'production']);

/** Методы самого моста (5.4, 9.1): к хосту не идут. */
export const bridgeMethodSchemas = {
  ping: z.strictObject({}),
  'client.info': z.strictObject({
    app: plainText(64),
    version: plainText(32),
    platform: plainText(32),
  }),
  'push.register': z.strictObject({
    apnsToken: z.string().regex(APNS_TOKEN_RE).nullable(),
    env: pushEnvSchema,
  }),
} as const;
