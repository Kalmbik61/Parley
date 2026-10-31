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
import { PendingAccepts, SessionManager, type SessionTiming } from './sessions.js';

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

  /** One cap for every stream waiting for msg1, connection or pairing (critic m5 on A7). */
  const pending = new PendingAccepts();
  const sessions = new SessionManager({
    keys: () => keys,
    devices,
    link: linkCalls,
    audit,
    log,
    timing: options.timing ?? {},
    pending,
  });
  /**
   * `resetting` — a reset is writing its files; `failed` — the last reset did not get both files on disk. Until a
   * reset succeeds the bridge takes no streams and opens no offer: memory has no devices and the old identity, the
   * disk may hold either (critic m3 on A7).
   */
  let resetState: 'ok' | 'resetting' | 'failed' = 'ok';

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
    pending,
  });

  async function reset(): Promise<void> {
    if (resetState === 'resetting') throw new ControlError('busy', 'a reset is in progress');
    // 1. every device and session dead now; the offer and any request end; no new streams until the files are
    // written.
    resetState = 'resetting';
    devices.invalidateAll();
    const affected = sessions.allSessions();
    pairing.abort('reset');
    const next = newBridgeKeys();
    log.addSecret(next.routeSecret);
    let cleared: Promise<boolean> = Promise.resolve(false);
    try {
      // 2. disk: devices first (access cut), then the new identity. Memory takes the new keys and route only once
      // both are written: a bridge restarted after a half-done reset never runs an identity the window did not get.
      await devices.persist();
      await writeBridgeKeys(options.keysFile, next);
    } catch (error) {
      resetState = 'failed';
      log.error('reset.failed', { error });
      audit.append({ kind: 'reset', outcome: 'failed' });
      throw new ControlError('reset_failed', 'reset failed');
    } finally {
      sessions.closeSessions(affected, 'reset'); // 3.
      // 4. the route the link holds keeps no devices.
      cleared = linkCalls.sendDevices([]);
    }
    keys = next;
    resetState = 'ok';
    audit.append({ kind: 'reset', outcome: 'ok' });
    void cleared.finally(() => link?.reconnect()); // then the link moves to the new route
  }

  const handlers: ControlHandlers = {
    'pair.start': async () => {
      if (resetState !== 'ok') throw new ControlError('reset_failed', 'reset failed');
      return pairing.start();
    },
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
        if (resetState !== 'ok') return; // not accepted: the relay answers the phone after its wait
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
