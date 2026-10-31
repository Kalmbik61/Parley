import { createHash, randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { derivePairKeys, NoiseError, responder, sas } from '@parley/noise';
import {
  b64urlEncode,
  buildPairUrl,
  pairMsg1Payload,
  pairPairedFrame,
  PAIR_STALE_REQUEST,
  type PAIR_FAILED_REASONS,
} from '@parley/protocol/remote';

type PairFailedReason = (typeof PAIR_FAILED_REASONS)[number];
import type { AuditLog } from './audit.js';
import { ControlError, type ControlEvents } from './control.js';
import type { DeviceStore } from './devices.js';
import { MAX_DEVICES } from './devices.js';
import { hostIdFor, tokenHash, type BridgeKeys } from './keys.js';
import type { BridgeLog } from './log.js';
import type { RelayIncoming, RelayLink } from './relay-link.js';
import { firstMessage, NoiseChannel, PendingAccepts } from './sessions.js';

export const PAIR_PROLOGUE = new TextEncoder().encode('parley-pair/1');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
/** Pairing frames are tiny: credentials one way, `paired` the other. */
const MAX_PAIR_FRAME = 4 * 1024;

export interface PairingTiming {
  /** Offer lifetime from `pair.start` (spec §7.3). */
  offerMs: number;
  /** The window answers within this (spec §7.4). */
  requestMs: number;
  /** `{t:'paired'}` must arrive within this after `credentials`. */
  ackMs: number;
  /** Wait for msg1 on an accepted pairing stream. */
  msg1Ms: number;
}

export const DEFAULT_PAIRING_TIMING: PairingTiming = {
  offerMs: 120_000,
  requestMs: 120_000,
  ackMs: 30_000,
  msg1Ms: 10_000,
};

interface Offer {
  s: Uint8Array;
  psk: Uint8Array;
  lookup: string;
  exp: number;
  consumed: boolean;
  timer: NodeJS.Timeout;
}

interface PairRequest {
  requestId: string;
  dsPub: Uint8Array;
  name: string;
  platform: string;
  channel: NoiseChannel;
  expiresAt: number;
  /** waiting → answered (deny/allow in progress) → done. */
  phase: 'waiting' | 'answered' | 'done';
  deviceId: string | null;
  timers: NodeJS.Timeout[];
}

export interface PairingOptions {
  keys(): BridgeKeys;
  devices: DeviceStore;
  link: Pick<RelayLink, 'accept' | 'setOffer' | 'sendDevices'>;
  /** Relay address for the QR (`host[:port]`). Null: pairing is unavailable. */
  relay(): string | null;
  hostName: string;
  audit: AuditLog;
  log: BridgeLog;
  emit<E extends keyof ControlEvents>(event: E, data: ControlEvents[E]): void;
  /** Removes a device that was written after «Allow» but never confirmed, in revoke order (spec §7.4, §7.9). */
  removeDevice(deviceId: string): Promise<void>;
  timing?: Partial<PairingTiming>;
  now?: () => number;
  /** Shared with connection sessions: streams accepted from the relay and still waiting for msg1. */
  pending?: PendingAccepts;
}

/**
 * Why a request ended, as the window hears it (`PAIR_FAILED_REASONS`). Requests closed by the window itself, a
 * reissue, a reset, a revoke, shutdown or the phone hanging up are `offer_closed`; the device limit reads as
 * `denied`. The finer reason stays in the audit `detail`.
 */
function windowReason(reason: string): PairFailedReason {
  switch (reason) {
    case 'denied':
    case 'limit':
      return 'denied';
    case 'timeout':
      return 'timeout';
    case 'no-ack':
      return 'no-ack';
    case 'bad-psk':
      return 'bad-psk';
    default:
      return 'offer_closed';
  }
}

// A function, so TypeScript does not narrow `phase` across awaits.
const ended = (r: { phase: string }): boolean => r.phase === 'done';

/** `xxxx xxxx xxxx xxxx`: first 8 bytes of sha256(DS_pub), so the window can tell two phones apart. */
export function keyFingerprint(dsPub: Uint8Array): string {
  const hex = createHash('sha256').update(dsPub).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)!.join(' ');
}

/** Pairing (spec §7.3–7.4): offer, IKpsk0 responder, SAS, request, «Allow», credentials, acknowledgement. */
export class Pairing {
  readonly #o: PairingOptions;
  readonly #t: PairingTiming;
  readonly #now: () => number;
  readonly #pending: PendingAccepts;
  #offer: Offer | null = null;
  #request: PairRequest | null = null;

  constructor(options: PairingOptions) {
    this.#o = options;
    this.#t = { ...DEFAULT_PAIRING_TIMING, ...options.timing };
    this.#now = options.now ?? Date.now;
    this.#pending = options.pending ?? new PendingAccepts();
  }

  /** `pair.start`: a new one-shot offer; any earlier offer and unanswered request become stale. */
  async start(): Promise<{ qr: string; expiresAt: number }> {
    const relay = this.#o.relay();
    if (relay === null) throw new ControlError('no_relay', 'relay is not configured');
    this.#closeOffer();
    this.#abortRequest('cancelled');
    const s = new Uint8Array(randomBytes(16));
    const { psk, lookup } = derivePairKeys(s);
    const exp = this.#now() + this.#t.offerMs;
    const timer = setTimeout(() => {
      if (this.#offer?.timer === timer) this.#closeOffer();
    }, this.#t.offerMs);
    timer.unref();
    const lookupB64 = b64urlEncode(lookup);
    this.#offer = { s, psk, lookup: lookupB64, exp, consumed: false, timer };
    this.#o.link.setOffer({ lookup: lookupB64, exp });
    this.#o.audit.append({ kind: 'pair-offer', outcome: 'open' });
    return { qr: buildPairUrl({ k: this.#o.keys().hsPub, s, r: relay }), expiresAt: exp };
  }

  /** `pair.cancel`: closes the offer and any unanswered request. */
  async cancel(): Promise<void> {
    this.#closeOffer();
    this.#abortRequest('cancelled');
  }

  /** `pair.answer`: the check and the state change happen before any await, so two answers cannot both pass. */
  async answer(requestId: string, allow: boolean): Promise<void> {
    const r = this.#request;
    if (!r || r.requestId !== requestId || r.phase !== 'waiting' || r.expiresAt <= this.#now()) {
      throw new ControlError(PAIR_STALE_REQUEST, 'the pairing request is no longer current');
    }
    r.phase = 'answered';
    if (!allow) {
      this.#o.audit.append({ kind: 'pair-denied', deviceName: r.name, outcome: 'denied' });
      this.#finish(r, 'denied');
      return;
    }
    if (this.#o.devices.size >= MAX_DEVICES) {
      this.#o.audit.append({
        kind: 'pair-failed',
        deviceName: r.name,
        outcome: 'failed',
        detail: 'limit',
      });
      this.#finish(r, 'limit');
      throw new ControlError('device_limit', `at most ${MAX_DEVICES} devices`);
    }
    await this.#allow(r);
  }

  /** Reset or revoke-all: the offer and the request end now. */
  abort(reason: string): void {
    this.#closeOffer();
    this.#abortRequest(reason);
  }

  /** A pending device revoked from the window mid-pairing: its request ends without `credentials`. */
  deviceRevoked(deviceId: string): void {
    const r = this.#request;
    if (r && r.deviceId === deviceId && r.phase !== 'done') this.#finish(r, 'revoked');
  }

  /** `incoming {kind: 'pair'}`: accepted only while the offer is open and unused. */
  async handleIncoming(incoming: RelayIncoming): Promise<void> {
    const offer = this.#offer;
    if (!offer || offer.consumed || offer.exp <= this.#now()) return;
    if (!this.#pending.take(this.#o.log)) return;
    let msg1: Uint8Array;
    let ws: WebSocket;
    try {
      ws = this.#o.link.accept(incoming.stream);
      try {
        msg1 = await firstMessage(ws, this.#t.msg1Ms);
      } catch {
        ws.terminate();
        return;
      }
    } finally {
      this.#pending.release();
    }
    this.#onMsg1(ws, offer, msg1);
  }

  #onMsg1(ws: WebSocket, offer: Offer, msg1: Uint8Array): void {
    // One attempt per offer (spec §7.4): the first msg1 uses it up, right or wrong.
    if (this.#offer !== offer || offer.consumed || offer.exp <= this.#now())
      return void ws.close(1000);
    offer.consumed = true;
    const keys = this.#o.keys();
    // The responder copies the psk; closing the offer then wipes the offer's own copy.
    const hs = responder({
      pattern: 'IKpsk0',
      prologue: PAIR_PROLOGUE,
      s: { privateKey: keys.hsPriv, publicKey: keys.hsPub },
      psk: offer.psk,
    });
    this.#closeOffer();
    let payload: { name: string; platform: string };
    try {
      const raw = hs.readMessage(msg1);
      const parsed = pairMsg1Payload.safeParse(JSON.parse(decoder.decode(raw)));
      if (!parsed.success) throw new Error('bad payload');
      payload = parsed.data;
    } catch (error) {
      const badPsk = error instanceof NoiseError && error.code === 'decrypt';
      this.#o.audit.append({
        kind: 'pair-failed',
        outcome: 'failed',
        detail: badPsk ? 'bad-psk' : 'bad-msg1',
      });
      // There is no request yet, so no `pair.failed`; the window still learns the QR is dead (critic m2 on A7).
      this.#o.emit('pair.offerClosed', { reason: badPsk ? 'bad-psk' : 'used' });
      return void ws.close(1000);
    }
    this.#o.emit('pair.offerClosed', { reason: 'used' });

    // msg2 at once and empty of access (spec §7.4); the SAS comes from the finished handshake.
    ws.send(hs.writeMessage(encoder.encode(JSON.stringify({ v: 1 }))), { binary: true });
    const code = sas(hs.handshakeHash());
    const dsPub = hs.remoteStatic()!;
    const channel = new NoiseChannel(ws, hs.split(), MAX_PAIR_FRAME);
    const r: PairRequest = {
      requestId: b64urlEncode(randomBytes(16)),
      dsPub,
      name: payload.name,
      platform: payload.platform,
      channel,
      expiresAt: this.#now() + this.#t.requestMs,
      phase: 'waiting',
      deviceId: null,
      timers: [],
    };
    this.#abortRequest('cancelled');
    this.#request = r;
    const expiry = setTimeout(() => {
      if (r.phase === 'waiting') {
        this.#o.audit.append({
          kind: 'pair-failed',
          deviceName: r.name,
          outcome: 'failed',
          detail: 'timeout',
        });
        this.#finish(r, 'timeout');
      }
    }, this.#t.requestMs);
    expiry.unref();
    r.timers.push(expiry);
    ws.on('message', (data, isBinary) => this.#onPairFrame(r, data, isBinary));
    ws.on('close', () => this.#onClosed(r));

    this.#o.audit.append({ kind: 'pair-request', deviceName: r.name, outcome: 'pending' });
    this.#o.emit('pair.request', {
      requestId: r.requestId,
      name: r.name,
      platform: r.platform,
      sas: code,
      fingerprint: keyFingerprint(dsPub),
      expiresAt: r.expiresAt,
    });
  }

  /** «Allow»: device on disk → token on the relay → `credentials` over this handshake's transport. */
  async #allow(r: PairRequest): Promise<void> {
    const keys = this.#o.keys();
    const relay = this.#o.relay();
    const deviceId = b64urlEncode(randomBytes(16));
    const relayToken = b64urlEncode(randomBytes(32));
    r.deviceId = deviceId;
    try {
      await this.#o.devices.add({
        deviceId,
        dsPub: b64urlEncode(r.dsPub),
        name: r.name,
        platform: r.platform,
        pairedAt: this.#now(),
        lastSeen: null,
        lastTs: 0,
        relayTokenHash: tokenHash(relayToken),
        state: 'pending',
      });
    } catch (error) {
      // The record is in memory (and in the relay list) but not on disk: remove it and end the request, so it does
      // not hang in `answered` with no timer (critic m4 on A7). The window hears the error from `pair.answer`.
      if (!ended(r)) await this.#removeAndFail(r, deviceId, 'storage');
      throw error;
    }
    if (ended(r)) return; // revoked, reset or closed while writing: that path removes the device
    this.#o.audit.append({
      kind: 'pair-allowed',
      deviceId,
      deviceName: r.name,
      outcome: 'allowed',
    });
    const registered = await this.#o.link.sendDevices();
    if (!registered) this.#o.log.warn('pair.relay-not-connected');
    if (ended(r)) return;
    const credentials = {
      t: 'credentials',
      hostId: hostIdFor(keys.hsPub),
      hostName: this.#o.hostName,
      deviceId,
      routeId: keys.routeId,
      relayToken,
      relays: relay ? [relay] : [],
    };
    // Never compressed: the frame carries the relay token (critic m5 on A3).
    if (!r.channel.send(encoder.encode(JSON.stringify(credentials)), { compress: false })) {
      return this.#failAfterAllow(r, 'no-ack');
    }
    const ack = setTimeout(() => this.#failAfterAllow(r, 'no-ack'), this.#t.ackMs);
    ack.unref();
    r.timers.push(ack);
  }

  #onPairFrame(
    r: PairRequest,
    data: Parameters<NoiseChannel['receive']>[0],
    isBinary: boolean,
  ): void {
    if (r.phase === 'done') return;
    let frame: Uint8Array | null;
    try {
      frame = r.channel.receive(data, isBinary);
    } catch {
      return this.#onClosed(r);
    }
    if (!frame || r.deviceId === null) return; // nothing is expected from the phone before «Allow»
    let ok = false;
    try {
      ok = pairPairedFrame.safeParse(JSON.parse(decoder.decode(frame))).success;
    } catch {
      ok = false;
    }
    if (!ok) return;
    const deviceId = r.deviceId;
    r.phase = 'done';
    this.#clear(r);
    void this.#o.devices.activate(deviceId).then(
      (active) => {
        // Revoked while the activation was being written: no «Phone connected ✓» for a removed device.
        if (active && this.#o.devices.get(deviceId)?.state === 'active')
          this.#o.emit('pair.done', { requestId: r.requestId, deviceId });
        r.channel.end();
      },
      (error: unknown) => {
        this.#o.log.error('pair.activate-failed', { error });
        void this.#removeAndFail(r, deviceId, 'no-ack');
      },
    );
  }

  /** The phone closed the stream or broke the transport. */
  #onClosed(r: PairRequest): void {
    if (r.phase === 'done') return;
    if (r.deviceId !== null) return this.#failAfterAllow(r, 'no-ack');
    this.#o.audit.append({
      kind: 'pair-failed',
      deviceName: r.name,
      outcome: 'failed',
      detail: 'closed',
    });
    this.#finish(r, 'closed');
  }

  #failAfterAllow(r: PairRequest, detail: 'no-ack'): void {
    if (r.phase === 'done' || r.deviceId === null) return;
    void this.#removeAndFail(r, r.deviceId, detail);
  }

  async #removeAndFail(r: PairRequest, deviceId: string, detail: string): Promise<void> {
    this.#o.audit.append({
      kind: 'pair-failed',
      deviceId,
      deviceName: r.name,
      outcome: 'failed',
      detail,
    });
    this.#finish(r, detail);
    try {
      await this.#o.removeDevice(deviceId);
    } catch (error) {
      this.#o.log.error('pair.remove-failed', { error });
    }
  }

  #finish(r: PairRequest, reason: string): void {
    if (r.phase === 'done') return;
    r.phase = 'done';
    this.#clear(r);
    r.channel.end();
    this.#o.emit('pair.failed', { requestId: r.requestId, reason: windowReason(reason) });
  }

  #clear(r: PairRequest): void {
    for (const t of r.timers) clearTimeout(t);
    r.timers = [];
    if (this.#request === r) this.#request = null;
  }

  #abortRequest(reason: string): void {
    const r = this.#request;
    if (!r || r.phase === 'done') return;
    if (r.deviceId !== null) return this.#failAfterAllow(r, 'no-ack');
    this.#finish(r, reason);
  }

  #closeOffer(): void {
    const offer = this.#offer;
    if (!offer) return;
    clearTimeout(offer.timer);
    offer.s.fill(0);
    offer.psk.fill(0);
    this.#offer = null;
    this.#o.link.setOffer(null);
  }
}
