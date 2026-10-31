// Push-шлюз (спека 6.5) и данные уведомления (9.4): свободных строк нет.
import { z } from 'zod';
import { APNS_TOKEN_RE, pushEnvSchema } from './frames.js';
import { routeIdSchema } from './relay.js';

const count = z.number().int().min(0).max(9999);

/** `POST /v1/push`; лишние поля — 400. */
export const pushRequestSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(APNS_TOKEN_RE),
  env: pushEnvSchema,
  count,
  route: routeIdSchema,
});

/** Статусы шлюза: 200 — принял APNs; 410 — токен недействителен; 400; 429. */
export const PUSH_GATEWAY_STATUSES = [200, 400, 410, 429] as const;

/** `data` уведомления. */
export const pushDataSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('needs-you'),
  count,
  route: routeIdSchema,
});
