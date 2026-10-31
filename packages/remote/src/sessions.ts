import { WebSocket, type RawData } from 'ws';
import { FrameCodec, responder, type TransportCiphers } from '@parley/noise';
import { b64urlDecode } from '@parley/protocol/remote';
import type { AuditLog } from './audit.js';
import type { DeviceStore } from './devices.js';
import type { BridgeKeys } from './keys.js';
import type { BridgeLog } from './log.js';
import type { RelayIncoming, RelayLink } from './relay-link.js';
import type {
  DevicePush,
  PhoneSessions,
  SessionClosingReason,
  SessionHandler,
} from './session-contract.js';

/** Inbound ceiling of an application frame after decompression (spec §5.7); A8 keeps its own copy. */
const PHONE_FRAME_CEILING = 64 * 1024;
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

export const CONNECT_PROLOGUE = 'parley-remote/1';

export function connectPrologue(routeId: string): Uint8Array {
  const label = encoder.encode(CONNECT_PROLOGUE);
  const route = b64urlDecode(routeId);
  const out = new Uint8Array(label.length + route.length);
  out.set(label);
  out.set(route, label.length);
  return out;
}

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? new Uint8Array(Buffer.concat(data))
    : new Uint8Array(data as ArrayBuffer | Buffer);

/** The first binary message on an accepted stream (msg1); text (a relay error), close or timeout reject. */
export function firstMessage(ws: WebSocket, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, value?: Uint8Array): void => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (error) reject(error);
      else resolve(value!);
    };
    const onMessage = (data: RawData, isBinary: boolean): void =>
      isBinary ? done(null, toBytes(data)) : done(new Error('relay refused the stream'));
    const onClose = (): void => done(new Error('stream closed'));
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    timer.unref();
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/**
 * One Noise transport over one relay stream: FrameCodec plaintexts, encrypted one per WebSocket binary message
 * (spec §7.7). Fail closed (critic m4 on A3): the first decryption, order, ceiling or framing error marks the
 * channel failed, destroys its keys and closes the socket; every later `receive` throws and `send` refuses.
 */
export class NoiseChannel {
  readonly #codec: FrameCodec;
  #failed = false;
  constructor(
    readonly ws: WebSocket,
    readonly ciphers: TransportCiphers,
    maxFrame: number,
  ) {
    this.#codec = new FrameCodec({ maxFrame });
  }

  get failed(): boolean {
    return this.#failed;
  }

  /**
   * Encrypts and queues one frame; false when the channel failed or the socket is not open. `compress: false`
   * for frames that carry secrets (critic m5 on A3: no length oracle next to attacker-influenced text).
   */
  send(frame: Uint8Array, options: { compress?: boolean; onSent?: () => void } = {}): boolean {
    if (this.#failed || this.ws.readyState !== WebSocket.OPEN) return false;
    const { onSent } = options;
    let sealed: Uint8Array[];
    try {
      sealed = this.#codec
        .encode(frame, options.compress === false ? { compress: false } : {})
        .map((plain) => this.ciphers.send.encryptWithAd(EMPTY, plain));
    } catch {
      this.#fail();
      return false;
    }
    sealed.forEach((message, n) => {
      this.ws.send(
        message,
        { binary: true },
        n === sealed.length - 1 && onSent ? () => onSent() : undefined,
      );
    });
    return true;
  }

  /** One received WebSocket message → the completed frame or null. Any error is final (see the class note). */
  receive(data: RawData, isBinary: boolean): Uint8Array | null {
    if (this.#failed) throw new Error('channel failed');
    try {
      if (!isBinary) throw new Error('text message on a Noise stream');
      return this.#codec.decode(this.ciphers.receive.decryptWithAd(EMPTY, toBytes(data)));
    } catch (error) {
      this.#fail();
      throw error;
    }
  }

  #fail(): void {
    this.#failed = true;
    this.end(1002);
  }

  get shouldRekey(): boolean {
    return this.ciphers.send.shouldClose || this.ciphers.receive.shouldClose;
  }

  /** Closes the socket (queued frames go out first) and destroys the transport keys. */
  end(code = 1000): void {
    this.#failed = true;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.close(code);
    this.ciphers.send.destroy();
    this.ciphers.receive.destroy();
  }
}

export interface SessionTiming {
  /** Wait for msg1 after accepting a stream. */
  msg1Ms: number;
  /** An unconfirmed session dies after this (spec §7.5). */
  confirmMs: number;
  /** Session lifetime; then `session.closing rekey` (spec §7.6). */
  maxLifeMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  msg1Ms: 10_000,
  confirmMs: 10_000,
  maxLifeMs: 3_600_000,
};

interface Session {
  deviceId: string;
  gen: number;
  channel: NoiseChannel;
  confirmed: boolean;
  closed: boolean;
  timers: NodeJS.Timeout[];
}

export interface SessionManagerOptions {
  keys(): BridgeKeys;
  devices: DeviceStore;
  link: Pick<RelayLink, 'accept'>;
  audit: AuditLog;
  log: BridgeLog;
  timing?: Partial<SessionTiming>;
  now?: () => number;
}

/** Sliding one-minute counters for failed handshakes (spec §5.7). */
class FailureLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #paused = new Map<string, number>();
  constructor(
    private readonly now: () => number,
    private readonly perDevice = 5,
    private readonly global = 60,
  ) {}

  blocked(deviceId: string): boolean {
    const t = this.now();
    return (this.#paused.get(deviceId) ?? 0) > t || (this.#paused.get('*') ?? 0) > t;
  }

  fail(deviceId: string): void {
    this.#hit(deviceId, this.perDevice);
    this.#hit('*', this.global);
  }

  #hit(key: string, max: number): void {
    const t = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((at) => t - at < 60_000);
    recent.push(t);
    this.#hits.set(key, recent);
    if (recent.length > max) this.#paused.set(key, t + 60_000);
  }
}

/**
 * Connection sessions (spec §7.5–7.6, §7.9): who gets a session, confirmation, replacement, lifetime, and the
 * generation check on activation and on every frame.
 */
export class SessionManager implements PhoneSessions {
  readonly #o: SessionManagerOptions;
  readonly #timing: SessionTiming;
  readonly #now: () => number;
  /** Confirmed session per device. */
  readonly #active = new Map<string, Session>();
  /** Every open session, confirmed or not. */
  readonly #all = new Set<Session>();
  readonly #limiter: FailureLimiter;
  #handler: SessionHandler | null = null;
  #accepting = true;

  constructor(options: SessionManagerOptions) {
    this.#o = options;
    this.#timing = { ...DEFAULT_SESSION_TIMING, ...options.timing };
    this.#now = options.now ?? Date.now;
    this.#limiter = new FailureLimiter(this.#now);
  }

  setHandler(handler: SessionHandler): void {
    this.#handler = handler;
  }

  /** Stop taking new streams (shutdown); open sessions are closed by `closeAll`. */
  stopAccepting(): void {
    this.#accepting = false;
  }

  // ---------- PhoneSessions (A8) ----------

  send(deviceId: string, frame: Uint8Array): boolean {
    const s = this.#active.get(deviceId);
    if (!s || !this.#valid(s)) return false;
    const ok = s.channel.send(frame);
    if (ok && s.channel.shouldRekey) this.#closeSession(s, 'rekey');
    return ok;
  }

  close(deviceId: string, reason: SessionClosingReason): void {
    const s = this.#active.get(deviceId);
    if (s) this.#closeSession(s, reason);
  }

  bufferedBytes(deviceId: string): number {
    return this.#active.get(deviceId)?.channel.ws.bufferedAmount ?? 0;
  }

  async setPush(deviceId: string, push: DevicePush | null): Promise<void> {
    await this.#o.devices.setPush(deviceId, push, this.#now());
  }

  // ---------- relay streams ----------

  isActive(deviceId: string): boolean {
    return this.#active.has(deviceId);
  }

  /** `incoming {kind: 'connect'}` from the relay. */
  async handleIncoming(incoming: RelayIncoming): Promise<void> {
    const claimed = incoming.device;
    // The relay must name the device (critic m5): without it the DS_pub ↔ deviceId check (§7.5) has nothing to bind.
    if (!this.#accepting || incoming.kind !== 'connect' || claimed === undefined) return;
    if (this.#limiter.blocked(claimed)) {
      // Not accepted: the relay answers the phone itself after its wait.
      this.#o.audit.append({
        kind: 'connect-refused',
        deviceId: claimed,
        outcome: 'refused',
        detail: 'rate',
      });
      return;
    }
    const ws = this.#o.link.accept(incoming.stream);
    let msg1: Uint8Array;
    try {
      msg1 = await firstMessage(ws, this.#timing.msg1Ms);
    } catch {
      ws.terminate();
      return;
    }
    this.#handshake(ws, claimed, msg1);
  }

  // Synchronous from msg1 to the session object: no await can interleave a revoke between checks and binding.
  #handshake(ws: WebSocket, claimed: string, msg1: Uint8Array): void {
    const keys = this.#o.keys();
    const refuse = (detail: string, deviceId = claimed): void => {
      this.#limiter.fail(claimed);
      const name = this.#o.devices.get(deviceId)?.name;
      this.#o.audit.append({
        kind: 'connect-refused',
        deviceId,
        ...(name ? { deviceName: name } : {}),
        outcome: 'refused',
        detail,
      });
      ws.close(1000);
    };
    const hs = responder({
      pattern: 'IK',
      prologue: connectPrologue(keys.routeId),
      s: { privateKey: keys.hsPriv, publicKey: keys.hsPub },
    });
    let payload: Uint8Array;
    try {
      payload = hs.readMessage(msg1);
    } catch {
      // msg1 not made for our key (e.g. sealed to the HS before a reset).
      return refuse('unknown-key');
    }
    const device = this.#o.devices.byKey(hs.remoteStatic()!);
    if (!device || device.state !== 'active') return refuse('unknown-key');
    if (device.deviceId !== claimed) return refuse('device-mismatch');
    if (payload.length !== 8) return refuse('replay', device.deviceId);
    const ts = new DataView(payload.buffer, payload.byteOffset, 8).getBigUint64(0, false);
    if (ts > BigInt(Number.MAX_SAFE_INTEGER) || Number(ts) <= device.lastTs)
      return refuse('replay', device.deviceId);
    if (!this.#handler || ws.readyState !== WebSocket.OPEN) return void ws.close(1000);

    const gen = this.#o.devices.generation(device.deviceId);
    this.#o.devices.noteConnect(device.deviceId, Number(ts), this.#now());
    const hello = encoder.encode(JSON.stringify(this.#handler.hello(device.deviceId)));
    ws.send(hs.writeMessage(hello), { binary: true });
    const session: Session = {
      deviceId: device.deviceId,
      gen,
      channel: new NoiseChannel(ws, hs.split(), PHONE_FRAME_CEILING),
      confirmed: false,
      closed: false,
      timers: [],
    };
    this.#all.add(session);
    const unconfirmed = setTimeout(() => {
      if (!session.confirmed) this.#drop(session);
    }, this.#timing.confirmMs);
    const life = setTimeout(() => this.#closeSession(session, 'rekey'), this.#timing.maxLifeMs);
    unconfirmed.unref();
    life.unref();
    session.timers.push(unconfirmed, life);
    ws.on('message', (data, isBinary) => this.#onMessage(session, data, isBinary));
    ws.on('close', () => this.#drop(session));
  }

  #onMessage(s: Session, data: RawData, isBinary: boolean): void {
    if (s.closed) return;
    // Revoked or reset since msg1: nothing reaches A8 and the session never activates (spec §7.9).
    if (!this.#valid(s)) return this.#drop(s);
    let frame: Uint8Array | null;
    try {
      frame = s.channel.receive(data, isBinary);
    } catch {
      return this.#drop(s);
    }
    if (!s.confirmed) this.#confirm(s);
    if (s.closed) return;
    if (frame) this.#handler?.onFrame(s.deviceId, frame);
    if (!s.closed && s.channel.shouldRekey) this.#closeSession(s, 'rekey');
  }

  /** First valid transport message: the session becomes the device's live one, replacing the old (spec §7.5). */
  #confirm(s: Session): void {
    s.confirmed = true;
    const old = this.#active.get(s.deviceId);
    if (old && old !== s) this.#closeSession(old, 'replaced');
    this.#active.set(s.deviceId, s);
    const name = this.#o.devices.get(s.deviceId)?.name;
    this.#o.audit.append({
      kind: 'connect',
      deviceId: s.deviceId,
      ...(name ? { deviceName: name } : {}),
      outcome: 'ok',
    });
    this.#handler?.onOpen(s.deviceId);
  }

  #valid(s: Session): boolean {
    return (
      !s.closed &&
      s.gen === this.#o.devices.generation(s.deviceId) &&
      this.#o.devices.get(s.deviceId) !== undefined
    );
  }

  /** `session.closing {reason}` inside Noise, then close (confirmed sessions); unconfirmed ones close silently. */
  #closeSession(s: Session, reason: SessionClosingReason): void {
    if (s.closed) return;
    if (!s.confirmed) return this.#drop(s);
    const closing = encoder.encode(JSON.stringify({ event: 'session.closing', data: { reason } }));
    const sent = s.channel.send(closing, { onSent: () => this.#drop(s) });
    if (!sent) this.#drop(s);
    else {
      this.#detach(s);
      // The socket closes once the closing frame is flushed; a stuck socket is cut after a second.
      const cut = setTimeout(() => this.#drop(s), 1000);
      cut.unref();
      s.timers.push(cut);
    }
  }

  /** Close without a word. */
  #drop(s: Session): void {
    this.#detach(s);
    if (!s.closed) {
      s.closed = true;
      for (const t of s.timers) clearTimeout(t);
      s.channel.end();
    }
    this.#all.delete(s);
  }

  /** Stops routing for the session; A8 hears `onClose` once for a confirmed session. */
  #detach(s: Session): void {
    if (this.#active.get(s.deviceId) === s) {
      this.#active.delete(s.deviceId);
      this.#handler?.onClose(s.deviceId);
    }
  }

  // ---------- revoke / reset (spec §7.9) ----------

  /**
   * Revoke step 1 helper: every session of the device is already dead by its generation; this returns them so
   * step 3 can close them after the disk write.
   */
  sessionsOf(deviceId: string): Session[] {
    return [...this.#all].filter((s) => s.deviceId === deviceId);
  }

  allSessions(): Session[] {
    return [...this.#all];
  }

  /** Step 3: live sessions get `session.closing {reason}`, unconfirmed ones close silently. */
  closeSessions(sessions: Session[], reason: SessionClosingReason): void {
    for (const s of sessions) this.#closeSession(s, reason);
  }

  /** Shutdown: `session.closing shutdown` to every live session. */
  closeAll(reason: SessionClosingReason): void {
    this.closeSessions(this.allSessions(), reason);
  }
}

export type { Session };
