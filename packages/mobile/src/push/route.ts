// The rule lives in remote-client (the end-to-end test uses it too); the app imports it from here as before.
import { resolvePushTarget, type PushTarget } from '@parley/remote-client';
import type { HostRecord } from '@parley/remote-client';
export { resolvePushTarget, type PushTarget };

/**
 * Inbox segment a push tap opens (D1 §7): a letter push (`data.kind: 'letter'`) lands on Letters, anything else on Needs you.
 * The current wire payload only has `kind: 'needs-you'`; a letter payload is resolved as the same host by its `route`.
 */
export function resolvePushRoute(data: unknown, hosts: readonly HostRecord[]): { target: PushTarget; segment: 'letters' | 'needs-you' } {
  const letter = typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === 'letter';
  return { target: resolvePushTarget(letter ? { ...(data as object), kind: 'needs-you' } : data, hosts), segment: letter ? 'letters' : 'needs-you' };
}
