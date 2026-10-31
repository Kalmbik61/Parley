// Push `data` → which host to open (D1 §12, spec §9.4).
import { pushDataSchema } from '@parley/protocol/remote';
import type { HostRecord } from '@parley/remote-client';

export type PushTarget =
  | { kind: 'host'; host: HostRecord; count: number }
  /** Bad `data` or a `route` of a Mac that is not paired any more: the host list with a toast. */
  | { kind: 'unknown' };

export function resolvePushTarget(data: unknown, hosts: readonly HostRecord[]): PushTarget {
  const parsed = pushDataSchema.safeParse(data);
  if (!parsed.success) return { kind: 'unknown' };
  const host = hosts.find((h) => h.routeId === parsed.data.route);
  return host ? { kind: 'host', host, count: parsed.data.count } : { kind: 'unknown' };
}
