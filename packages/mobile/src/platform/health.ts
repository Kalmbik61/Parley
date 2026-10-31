// Relay reachability probe: `GET /v1/health` on the relay (plain HTTP(S) beside the WebSocket endpoint).
import { relayUrlFor } from '@parley/protocol/remote';

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>;

export const HEALTH_TIMEOUT_MS = 3000;

export function healthUrl(relay: string, allowLocal: boolean): string {
  // `relayUrlFor` also refuses a private address in a release build, so the probe never reaches a LAN host there.
  return relayUrlFor(relay, { allowLocal }).replace(/^ws/, 'http') + '/v1/health';
}

/** Resolves `true` only for a 200 answer inside the timeout; never rejects. */
export async function probeRelay(
  fetchFn: FetchLike,
  relay: string,
  allowLocal: boolean,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(healthUrl(relay, allowLocal), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
