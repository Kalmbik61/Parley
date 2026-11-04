import { isValidRelayHost } from '@parley/protocol/remote';

/**
 * What the person typed in the Relay field → the `host[:port]` the bridge accepts (`configure`, spec 5.3, 6.6, 9).
 * A `ws://` / `wss://` / `https://` prefix and a trailing slash are removed; `http://` (no TLS), a path, `@`,
 * a query or anything else is refused (`null`).
 */
export function normalizeRelayInput(text: string): string | null {
  const host = text.trim().replace(/^(?:wss?|https):\/\//i, '').replace(/\/$/, '');
  return isValidRelayHost(host) ? host : null;
}

/** Why `normalizeRelayInput` refused the text: a plain `http://` address, or anything else; `null` when it is accepted. */
export function relayInputProblem(text: string): 'insecure' | 'invalid' | null {
  if (normalizeRelayInput(text) !== null) return null;
  return /^http:\/\//i.test(text.trim()) ? 'insecure' : 'invalid';
}
