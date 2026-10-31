import { WebSocket, type RawData } from 'ws';
import { relayErrorFrame, relayIncomingFrame, relayOkFrame } from '@parley/protocol/remote';
import type { BridgeLog } from './log.js';

export type RelayState = 'connecting' | 'connected' | 'error' | 'stopped';

export interface RelayIncoming {
  stream: string;
  kind: 'connect' | 'pair';
  device?: string;
}

export interface RelayRoute {
  routeId: string;
  routeSecret: string;
}

export interface RelayLinkOptions {
  /** `ws://` or `wss://` base from `relayUrlFor(r, {allowLocal: true})`. */
  relayUrl: string;
  /** Current route; read on every (re)connect, so a reset takes effect with `reconnect()`. */
  route(): RelayRoute;
  /** Full device list, sent after every `ok` (spec §6.3). */
  devices(): { device: string; tokenHash: string }[];
  onIncoming(incoming: RelayIncoming): void;
  onState?(state: RelayState): void;
  log: BridgeLog;
  backoff?: { initialMs: number; maxMs: number };
  /** No `ok` within this time → reconnect. */
  helloTimeoutMs?: number;
}

export interface RelayLink {
  start(): void;
  stop(): Promise<void>;
  readonly state: RelayState;
  /**
   * Sends the device list (default: `devices()`); resolves `true` once written to an authenticated control socket,
   * `false` when not connected — the list then goes out after the next `ok` anyway. The relay does not acknowledge.
   */
  sendDevices(list?: { device: string; tokenHash: string }[]): Promise<boolean>;
  /** Opens or closes the pairing offer; remembered and re-sent after every `ok` while it has not expired. */
  setOffer(offer: { lookup: string; exp: number } | null): void;
  /** Drops the control socket and connects again with the current `route()`. */
  reconnect(): void;
  /** Opens `/v1/accept` for a stream and sends `accept`; the relay splices it with the phone. */
  accept(stream: string): WebSocket;
}

const parse = (data: RawData, isBinary: boolean): unknown => {
  if (isBinary) return undefined;
  try {
    return JSON.parse(
      Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8'),
    );
  } catch {
    return undefined;
  }
};

/** Control connection of the bridge to `/v1/host` (spec §6.3), reconnecting with jittered backoff. */
export function createRelayLink(options: RelayLinkOptions): RelayLink {
  const { log } = options;
  const backoff = options.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const base = options.relayUrl.replace(/\/+$/, '');
  let ws: WebSocket | null = null;
  let state: RelayState = 'stopped';
  let authed = false;
  let attempt = 0;
  let retry: NodeJS.Timeout | null = null;
  let helloTimer: NodeJS.Timeout | null = null;
  let offer: { lookup: string; exp: number } | null = null;
  let running = false;

  const setState = (next: RelayState): void => {
    if (state === next) return;
    state = next;
    options.onState?.(next);
  };

  const sendJson = (body: object): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = ws;
      if (!socket || !authed || socket.readyState !== WebSocket.OPEN) return resolve(false);
      socket.send(JSON.stringify(body), (error) => resolve(!error));
    });

  const sendOffer = (): void => {
    if (offer && offer.exp > Date.now())
      void sendJson({ v: 1, t: 'offer', lookup: offer.lookup, exp: offer.exp });
  };

  function schedule(delayMs?: number): void {
    if (!running || retry) return;
    const cap = Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt);
    attempt += 1;
    const delay = delayMs ?? Math.round(cap / 2 + (Math.random() * cap) / 2);
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
    retry.unref();
  }

  function drop(socket: WebSocket): void {
    socket.removeAllListeners('message');
    socket.on('error', () => {});
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      socket.terminate();
  }

  function connect(): void {
    if (!running) return;
    setState('connecting');
    authed = false;
    const { routeId, routeSecret } = options.route();
    const socket = new WebSocket(`${base}/v1/host`, { perMessageDeflate: false });
    ws = socket;
    socket.on('error', () => {});
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, t: 'hello', route: routeId, secret: routeSecret }));
      helloTimer = setTimeout(() => {
        log.warn('relay.hello-timeout');
        drop(socket);
      }, helloTimeoutMs);
      helloTimer.unref();
    });
    socket.on('message', (data, isBinary) => {
      if (ws !== socket) return;
      const json = parse(data, isBinary);
      if (!authed) {
        if (relayOkFrame.safeParse(json).success) {
          if (helloTimer) clearTimeout(helloTimer);
          authed = true;
          attempt = 0;
          setState('connected');
          log.info('relay.connected');
          void sendJson({ v: 1, t: 'devices', list: options.devices() });
          sendOffer();
          return;
        }
        const error = relayErrorFrame.safeParse(json);
        log.warn('relay.refused', { code: error.success ? error.data.code : 'malformed' });
        setState('error');
        drop(socket);
        return;
      }
      const incoming = relayIncomingFrame.safeParse(json);
      if (incoming.success) {
        const { stream, kind, device } = incoming.data;
        options.onIncoming(device === undefined ? { stream, kind } : { stream, kind, device });
        return;
      }
      const error = relayErrorFrame.safeParse(json);
      log.warn('relay.error', { code: error.success ? error.data.code : 'malformed' });
    });
    socket.on('close', (code) => {
      if (helloTimer) clearTimeout(helloTimer);
      if (ws !== socket) return;
      ws = null;
      authed = false;
      if (!running) return;
      // 4000: a newer bridge took the route over (spec §6.3); try again only after the longest pause.
      if (code === 4000) log.warn('relay.evicted');
      if (state !== 'error') setState('connecting');
      schedule(code === 4000 ? backoff.maxMs : undefined);
    });
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      connect();
    },
    async stop() {
      running = false;
      if (retry) clearTimeout(retry);
      retry = null;
      const socket = ws;
      ws = null;
      authed = false;
      setState('stopped');
      if (socket) {
        await new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once('close', () => resolve());
          socket.close(1000);
          setTimeout(() => {
            socket.terminate();
            resolve();
          }, 1000).unref();
        });
      }
    },
    sendDevices(list) {
      return sendJson({ v: 1, t: 'devices', list: list ?? options.devices() });
    },
    setOffer(next) {
      offer = next;
      if (next) sendOffer();
      else void sendJson({ v: 1, t: 'offer', lookup: null });
    },
    reconnect() {
      if (!running) return;
      const socket = ws;
      ws = null;
      authed = false;
      if (socket) drop(socket);
      if (retry) clearTimeout(retry);
      retry = null;
      attempt = 0;
      connect();
    },
    accept(stream) {
      const { routeId, routeSecret } = options.route();
      const socket = new WebSocket(`${base}/v1/accept`, { perMessageDeflate: false });
      socket.on('error', () => {});
      socket.once('open', () => {
        socket.send(
          JSON.stringify({ v: 1, t: 'accept', route: routeId, secret: routeSecret, stream }),
        );
      });
      return socket;
    },
  };
}
