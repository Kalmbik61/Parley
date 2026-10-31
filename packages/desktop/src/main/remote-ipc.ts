import { toDataURL } from 'qrcode';
import type { IpcMain } from 'electron';
import {
  REMOTE_CALL_NAMES,
  type RemoteAuditRecord,
  type RemoteBridgeStatus,
  type RemoteCallName,
  type RemoteCalls,
  type RemoteDevice,
  type RemoteEvent,
  type RemotePairOffer,
  type RemoteState,
} from '../shared/remote-types.js';
import { normalizeRelayInput } from '../shared/relay-input.js';
import { ControlCallError, startPresence, type PowerMonitorLike, type PresenceState } from './remote-control.js';
import type { RemoteLauncher } from './remote-launcher.js';
import { withIpcError } from './ipc.js';

const PAIR_EVENTS = new Set(['pair.request', 'pair.done', 'pair.failed', 'pair.offerClosed']);

export interface RemoteServiceOptions {
  launcher: RemoteLauncher;
  powerMonitor: PowerMonitorLike;
  /** Persisted switch «Remote access» (`ui.json`). */
  loadEnabled: () => Promise<boolean>;
  saveEnabled: (enabled: boolean) => Promise<void>;
  /** Delivers an event to every window. */
  broadcast: (event: RemoteEvent) => void;
  /** The offer string is turned into an image here, in main (spec 12). */
  qrDataUrl?: (text: string) => Promise<string>;
  /** Delays of the reconnect to a dropped control socket, ms; the last one repeats. */
  reconnectDelaysMs?: readonly number[];
}

export interface RemoteService {
  /** Starts the bridge when the switch was left on. Never throws. */
  init(): Promise<void>;
  call<N extends RemoteCallName>(name: N, params: RemoteCalls[N]['params']): Promise<RemoteCalls[N]['result']>;
  /** Window quit: disconnect, the bridge keeps running. */
  dispose(): void;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ControlCallError('bad_request', 'invalid argument');
  return value;
}

export function createRemoteService(options: RemoteServiceOptions): RemoteService {
  const { launcher, broadcast } = options;
  const qrDataUrl = options.qrDataUrl ?? ((value: string) => toDataURL(value, { margin: 1, width: 256 }));
  const state: RemoteState = { enabled: false, process: 'off', error: null, status: null };
  let presence: { resend(): void; stop(): void } | null = null;
  let unsubscribe: Array<() => void> = [];
  // Starts and stops of the bridge run one after another: a stop never overtakes a start still in flight.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  const reconnectDelays = options.reconnectDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];

  const snapshot = (): RemoteState => ({ ...state });
  const publish = (): void => broadcast({ event: 'state', data: snapshot() });
  const control = (method: string, params?: unknown): Promise<unknown> => launcher.client.call(method, params);

  async function refreshStatus(): Promise<void> {
    if (state.process !== 'running') return;
    try {
      state.status = (await control('status')) as RemoteBridgeStatus;
    } catch {
      state.status = null;
    }
  }

  function detachListeners(): void {
    for (const off of unsubscribe) off();
    unsubscribe = [];
    presence?.stop();
    presence = null;
  }

  async function bringUp(): Promise<void> {
    state.process = 'starting';
    state.error = null;
    publish();
    try {
      await launcher.start();
    } catch (error) {
      state.process = 'error';
      state.error = error instanceof Error ? error.message : 'The bridge could not be started';
      state.status = null;
      publish();
      return;
    }
    // Switched off while the bridge was starting: do not leave it running behind an off switch.
    if (!state.enabled) {
      await bringDown();
      return;
    }
    detachListeners();
    unsubscribe.push(
      launcher.client.onEvent((event, data) => {
        if (PAIR_EVENTS.has(event)) broadcast({ event, data } as RemoteEvent);
      }),
      launcher.client.onClose(() => {
        detachListeners();
        state.status = null;
        // Switched off by the user: a quiet stop, not an error.
        state.process = state.enabled ? 'error' : 'off';
        state.error = state.enabled ? 'The bridge stopped' : null;
        publish();
        if (state.enabled) scheduleReconnect();
      }),
    );
    presence = startPresence({
      powerMonitor: options.powerMonitor,
      send: (value: PresenceState) => {
        void control('presence', { state: value }).catch(() => {});
      },
    });
    state.process = 'running';
    reconnectAttempt = 0;
    await refreshStatus();
    publish();
  }

  /** A dropped control socket of a live bridge: connect again with a backoff while the switch is on (presence, pairing events). */
  function scheduleReconnect(): void {
    if (reconnectTimer !== null || !state.enabled) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 30_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void serial(async () => {
        if (!state.enabled || state.process === 'running') return;
        await bringUp();
        if (state.process === 'error' && state.enabled) scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref();
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
  }

  async function bringDown(): Promise<void> {
    cancelReconnect();
    detachListeners();
    await launcher.stop();
    state.process = 'off';
    state.error = null;
    state.status = null;
    publish();
  }

  const handlers: { [N in RemoteCallName]: (params: RemoteCalls[N]['params']) => Promise<RemoteCalls[N]['result']> } = {
    async state() {
      await refreshStatus();
      return snapshot();
    },
    async setEnabled({ enabled }) {
      if (typeof enabled !== 'boolean') throw new ControlCallError('bad_request', 'invalid argument');
      state.enabled = enabled;
      await options.saveEnabled(enabled);
      await serial(() => (state.enabled ? bringUp() : bringDown()));
      return snapshot();
    },
    async configure({ relayUrl }) {
      // The bridge takes `host[:port]` only (spec 5.3): a scheme is dropped here, a path or `@` is refused.
      const host = normalizeRelayInput(text(relayUrl, 256));
      if (host === null) throw new ControlCallError('bad_request', 'invalid relay address');
      await control('configure', { relayUrl: host });
      await refreshStatus();
      publish();
      return snapshot();
    },
    async 'pair.start'(): Promise<RemotePairOffer> {
      const offer = (await control('pair.start')) as { qr: string; expiresAt: number };
      return { qr: await qrDataUrl(offer.qr), expiresAt: offer.expiresAt };
    },
    async 'pair.cancel'() {
      await control('pair.cancel');
      return null;
    },
    async 'pair.answer'({ requestId, allow }) {
      if (typeof allow !== 'boolean') throw new ControlCallError('bad_request', 'invalid argument');
      // The answer carries the id of the dialog that was clicked, never "the current request" (spec 5.3).
      await control('pair.answer', { requestId: text(requestId, 64), allow });
      return null;
    },
    async 'devices.list'() {
      const result = (await control('devices.list')) as { devices: RemoteDevice[] };
      return result.devices;
    },
    async 'devices.revoke'({ deviceId }) {
      await control('devices.revoke', { deviceId: text(deviceId, 64) });
      await refreshStatus();
      publish();
      return null;
    },
    async reset() {
      await control('reset');
      await refreshStatus();
      publish();
      return null;
    },
    async 'audit.tail'({ limit }) {
      const result = (await control('audit.tail', { limit: Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 200)) })) as {
        records: RemoteAuditRecord[];
      };
      return result.records;
    },
  };

  return {
    async init() {
      try {
        state.enabled = await options.loadEnabled();
        // Off: a bridge left running by an earlier window (a start that was interrupted) is stopped, not forgotten.
        await serial(() => (state.enabled ? bringUp() : launcher.stop()));
        if (state.process === 'error' && state.enabled) scheduleReconnect();
      } catch (error) {
        console.warn('[parley] remote access init failed', error);
      }
    },
    call(name, params) {
      return handlers[name](params as never) as Promise<RemoteCalls[typeof name]['result']>;
    },
    dispose() {
      cancelReconnect();
      detachListeners();
      launcher.detach();
    },
  };
}

/** `remote:call` — one channel for the screen, limited to the names in `REMOTE_CALL_NAMES`. */
export function registerRemoteIpc(ipcMain: IpcMain, service: RemoteService): void {
  const allowed = new Set<string>(REMOTE_CALL_NAMES);
  ipcMain.handle(
    'remote:call',
    withIpcError(async (_event, name: unknown, params: unknown) => {
      if (typeof name !== 'string' || !allowed.has(name)) throw new ControlCallError('bad_request', 'unknown remote method');
      const args = typeof params === 'object' && params !== null ? params : {};
      return service.call(name as RemoteCallName, args as never);
    }),
  );
}
