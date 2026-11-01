import { isValidRelayHost } from '@parley/protocol/remote';

/**
 * What the person typed in the Relay field → the `host[:port]` the bridge accepts (`configure`, spec 5.3, 6.6).
 * A `ws://` / `wss://` prefix and a trailing slash are removed; a path, `@`, a query or anything else is refused (`null`).
 */
export function normalizeRelayInput(text: string): string | null {
  const host = text.trim().replace(/^wss?:\/\//i, '').replace(/\/$/, '');
  return isValidRelayHost(host) ? host : null;
}
