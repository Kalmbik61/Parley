// DEVELOPER BUILD ONLY. Pairing arrives with A14; until then a dev server started with PARLEY_MOBILE_DEV_RELAY=host:port
// (extra.devRelay) gets a host record with random keys, so the connection banner has a real local relay to react to:
// a relay without a matching route answers `unknown_route`. The record cannot complete a handshake.
import { b64urlEncode } from '@parley/protocol/remote';
import type { HostRecord } from '@parley/remote-client';

export function seedHostFromEnv(relay: string, random: (n: number) => Uint8Array): HostRecord {
  const b64 = (n: number): string => b64urlEncode(random(n));
  return {
    hostId: 'dev-seed',
    hostName: 'Dev relay (seed)',
    hsPub: b64(32),
    relay,
    relays: [relay],
    routeId: b64(16),
    deviceId: b64(16),
    relayToken: b64(32),
    dsPriv: b64(32),
    dsPub: b64(32),
    lastTs: 0,
    pairedAt: Date.now(),
  };
}
