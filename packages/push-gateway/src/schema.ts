import { pushDataSchema, pushRequestSchema } from '@parley/protocol/remote';
import type { z } from 'zod';

export { pushRequestSchema };
export type PushRequest = z.infer<typeof pushRequestSchema>;

/** Тело APNs: текст собирает шлюз, из запроса берутся только числа и `route`. */
export function buildApnsPayload(req: PushRequest): Record<string, unknown> {
  const data = pushDataSchema.parse({
    v: 1,
    kind: 'needs-you',
    count: req.count,
    route: req.route,
  });
  return {
    aps: {
      alert: { title: 'Parley', body: `${req.count} waiting` },
      badge: req.count,
      'thread-id': req.route,
    },
    ...data,
  };
}
