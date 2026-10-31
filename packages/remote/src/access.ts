import { relayUrlFor } from '@parley/protocol/remote';
import type { AuditLog } from './audit.js';
import {
  ControlError,
  type ControlDeviceInfo,
  type ControlEvents,
  type ControlHandlers,
} from './control.js';
import { DeviceStore } from './devices.js';
import {
  hostIdFor,
  loadBridgeKeys,
  newBridgeKeys,
  writeBridgeKeys,
  type BridgeKeys,
} from './keys.js';
import type { BridgeLog } from './log.js';
import { Pairing, type PairingTiming } from './pairing.js';
import { createRelayLink, type RelayLink, type RelayState } from './relay-link.js';
import type { PhoneSessions, SessionHandler } from './session-contract.js';
import { SessionManager, type SessionTiming } from './sessions.js';

export interface RemoteAccessOptions {
  keysFile: string;
  devicesFile: string;
  /** Relay address `host[:port]` (spec §6.6); null — not configured, no relay link and no pairing. */
  relay: string | null;
  hostName: string;
  audit: AuditLog;
  log: BridgeLog;
  emit<E extends keyof ControlEvents>(event: E, data: ControlEvents[E]): void;
  timing?: Partial<SessionTiming & PairingTiming>;
  relayBackoff?: { initialMs: number; maxMs: number };
  /** Lazy write delay of `lastTs` / `lastSeen`. */
  lazyWriteMs?: number;
  /** Tests only: maps the relay address to its URL. Default `relayUrlFor(relay, {allowLocal: true})`. */
  resolveRelayUrl?: (relay: string) => string;
}

/** What A22 wires: control handlers for A6a, sessions for A8, the relay link. */
export interface RemoteAccess {
  readonly handlers: ControlHandlers;
  readonly sessions: PhoneSessions;
  setSessionHandler(handler: SessionHandler): void;
  readonly devices: DeviceStore;
  readonly relayState: RelayState;
  readonly hostId: string;
  keys(): BridgeKeys;
  start(): void;
  /** Stop accepting, `session.closing shutdown`, relay link down, lazy writes flushed. */
  stop(): Promise<void>;
}

/**
 * Loads keys.json and devices.json and builds the bridge's access layer (plan A7): relay link, connection
 * sessions, pairing, revoke and reset. Nothing listens until `start()`.
 */
export async function openRemoteAccess(options: RemoteAccessOptions): Promise<RemoteAccess> {
  const { audit, log } = options;
  let keys = await loadBridgeKeys(options.keysFile);
  log.addSecret(keys.routeSecret);
  const devices = await DeviceStore.load(
    options.devicesFile,
    options.lazyWriteMs === undefined ? {} : { lazyWriteMs: options.lazyWriteMs },
  );
  const resolve =
    options.resolveRelayUrl ?? ((relay: string) => relayUrlFor(relay, { allowLocal: true }));
  const relayUrl = options.relay === null ? null : resolve(options.relay);

  // Pairing and sessions talk to the link only through these calls; a bridge without a relay has no streams.
  let link: RelayLink | null = null;
  const linkCalls = {
    accept: (stream: string) => link!.accept(stream),
    setOffer: (offer: { lookup: string; exp: number } | null) => link?.setOffer(offer),
    sendDevices: (list?: { device: string; tokenHash: string }[]) =>
      link?.sendDevices(list) ?? Promise.resolve(false),
  };

  const sessions = new SessionManager({
    keys: () => keys,
    devices,
    link: linkCalls,
    audit,
    log,
    timing: options.timing ?? {},
  });

  /** Revoke order (spec §7.9): memory now → disk → `session.closing` → relay, in the background. */
  async function removeDevice(deviceId: string, reason: 'revoked' | 'pairing'): Promise<boolean> {
    const name = devices.get(deviceId)?.name;
    const known = devices.invalidate(deviceId); // 1. generation up: its sessions are dead from here on
    const affected = sessions.sessionsOf(deviceId);
    pairing.deviceRevoked(deviceId);
    if (!known) return false;
    try {
      await devices.persist(); // 2. atomic write with fsync; only then the window hears back
      if (reason === 'revoked') {
        audit.append({
          kind: 'revoked',
          deviceId,
          ...(name ? { deviceName: name } : {}),
          outcome: 'ok',
        });
      }
    } finally {
      sessions.closeSessions(affected, 'revoked'); // 3. inside Noise, then close
      void linkCalls.sendDevices(); // 4. relay; also re-sent after every reconnect
    }
    return true;
  }

  const pairing = new Pairing({
    keys: () => keys,
    devices,
    link: linkCalls,
    relay: () => options.relay,
    hostName: options.hostName,
    audit,
    log,
    emit: options.emit,
    removeDevice: async (deviceId) => {
      await removeDevice(deviceId, 'pairing');
    },
    timing: options.timing ?? {},
  });

  async function reset(): Promise<void> {
    // 1. every device and session dead now; the offer and any request end.
    devices.invalidateAll();
    const affected = sessions.allSessions();
    pairing.abort('reset');
    const next = newBridgeKeys();
    keys = next; // new handshakes use the new HS from here on
    log.addSecret(next.routeSecret);
    try {
      // 2. disk: devices first (access cut), then the new identity.
      await devices.persist();
      await writeBridgeKeys(options.keysFile, next);
      audit.append({ kind: 'reset', outcome: 'ok' });
    } finally {
      sessions.closeSessions(affected, 'reset'); // 3.
      // 4. the old route keeps no devices; then the link moves to the new route.
      const current = link;
      if (current) void current.sendDevices([]).finally(() => current.reconnect());
    }
  }

  const handlers: ControlHandlers = {
    'pair.start': () => pairing.start(),
    'pair.cancel': () => pairing.cancel(),
    'pair.answer': ({ requestId, allow }) => pairing.answer(requestId, allow),
    'devices.list': async (): Promise<ControlDeviceInfo[]> =>
      devices
        .list()
        .filter((d) => d.state === 'active')
        .map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          platform: d.platform,
          pairedAt: d.pairedAt,
          lastSeen: d.lastSeen,
        })),
    'devices.revoke': async ({ deviceId }) => {
      if (!(await removeDevice(deviceId, 'revoked')))
        throw new ControlError('not_found', 'unknown device');
    },
    reset,
  };

  if (relayUrl !== null) {
    link = createRelayLink({
      relayUrl,
      route: () => ({ routeId: keys.routeId, routeSecret: keys.routeSecret }),
      devices: () => devices.relayList(),
      onIncoming: (incoming) => {
        const run =
          incoming.kind === 'pair'
            ? pairing.handleIncoming(incoming)
            : sessions.handleIncoming(incoming);
        run.catch((error: unknown) => log.error('relay.incoming-failed', { error }));
      },
      log,
      ...(options.relayBackoff ? { backoff: options.relayBackoff } : {}),
    });
  }

  return {
    handlers,
    sessions,
    setSessionHandler: (handler) => sessions.setHandler(handler),
    devices,
    get relayState(): RelayState {
      return link?.state ?? 'stopped';
    },
    get hostId() {
      return hostIdFor(keys.hsPub);
    },
    keys: () => keys,
    start() {
      link?.start();
    },
    async stop() {
      sessions.stopAccepting();
      pairing.abort('shutdown');
      sessions.closeAll('shutdown');
      await link?.stop();
      await devices.flush();
    },
  };
}
