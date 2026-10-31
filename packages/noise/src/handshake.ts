import { CipherState } from './cipher.js';
import { NoiseError } from './errors.js';
import { PATTERNS, type HandshakePattern, type PatternName, type Token } from './patterns.js';
import { noblePrimitives, type KeyPair, type NoisePrimitives } from './primitives.js';
import { SymmetricState } from './symmetric.js';
import { concat, copy, equalBytes, wipe, EMPTY } from './bytes.js';

/** Noise limit on any handshake or transport message (§3). */
export const MAX_MESSAGE = 65_535;
const TAG = 16;

export interface HandshakeOptions {
  pattern: PatternName;
  /** Bound into h before the first message (Noise §6); both sides must use the same bytes. */
  prologue: Uint8Array;
  /** Local static key pair. */
  s: KeyPair;
  /**
   * Initiator: the responder's static public key (required for IK).
   * Responder: optional expected initiator static key; reading msg1 then fails unless it matches.
   */
  rs?: Uint8Array;
  /** 32-byte pre-shared key; required for IKpsk0, forbidden for IK. */
  psk?: Uint8Array;
  /** Defaults to `noblePrimitives` (the frozen suite). */
  primitives?: NoisePrimitives;
}

export interface TransportCiphers {
  /** Cipher for messages this side sends. */
  send: CipherState;
  /** Cipher for messages this side receives. */
  receive: CipherState;
}

type Phase = 'running' | 'complete' | 'split' | 'failed';

/**
 * Noise HandshakeState (§5.3) for IK and IKpsk0. Strictly one message in turn; any error — including a
 * failed decryption — leaves the state `failed` and every later call throws. Inputs are never written to;
 * keys and payloads handed out are copies.
 */
export class HandshakeState {
  readonly pattern: HandshakePattern;
  readonly initiator: boolean;
  readonly protocolName: string;
  readonly #primitives: NoisePrimitives;
  readonly #ss: SymmetricState;
  readonly #s: KeyPair;
  #e: KeyPair | null = null;
  #rs: Uint8Array | null = null;
  #re: Uint8Array | null = null;
  readonly #expectedRs: Uint8Array | null = null;
  readonly #psk: Uint8Array | null;
  #index = 0;
  #phase: Phase = 'running';

  constructor(initiator: boolean, options: HandshakeOptions) {
    // Own properties only: names such as `constructor` must not resolve through Object.prototype.
    const pattern = Object.prototype.hasOwnProperty.call(PATTERNS, options.pattern)
      ? PATTERNS[options.pattern]
      : undefined;
    if (!pattern) throw new NoiseError('state', 'unknown handshake pattern');
    const primitives = options.primitives ?? noblePrimitives;
    const { dhLen } = primitives;
    this.pattern = pattern;
    this.initiator = initiator;
    this.#primitives = primitives;
    this.protocolName = `Noise_${pattern.name}_${primitives.suite}`;

    if (options.s.privateKey.length !== dhLen || options.s.publicKey.length !== dhLen) {
      throw new NoiseError('key', 'static key must be DHLEN bytes');
    }
    this.#s = { privateKey: copy(options.s.privateKey), publicKey: copy(options.s.publicKey) };

    if (options.rs !== undefined && options.rs.length !== dhLen) {
      throw new NoiseError('key', 'remote static key must be DHLEN bytes');
    }
    if (initiator) {
      if (pattern.responderPre.includes('s') && options.rs === undefined) {
        throw new NoiseError('key', 'initiator needs the responder static key');
      }
      this.#rs = options.rs ? copy(options.rs) : null;
    } else if (options.rs !== undefined) {
      this.#expectedRs = copy(options.rs);
    }

    if (pattern.psk) {
      if (options.psk === undefined || options.psk.length !== 32) {
        throw new NoiseError('key', 'psk must be 32 bytes');
      }
      this.#psk = copy(options.psk);
    } else {
      if (options.psk !== undefined)
        throw new NoiseError('key', 'psk given for a pattern without psk');
      this.#psk = null;
    }

    this.#ss = new SymmetricState(primitives, this.protocolName);
    this.#ss.mixHash(options.prologue);
    // Pre-messages (§7.1): the initiator's first, then the responder's.
    for (const token of pattern.initiatorPre)
      this.#mixPre(token, initiator ? this.#s.publicKey : null);
    for (const token of pattern.responderPre)
      this.#mixPre(token, initiator ? this.#rs : this.#s.publicKey);
  }

  /** True when this side writes the next message. */
  get isMyTurn(): boolean {
    return this.#phase === 'running' && this.#index % 2 === (this.initiator ? 0 : 1);
  }

  get isComplete(): boolean {
    return this.#phase === 'complete' || this.#phase === 'split';
  }

  /** The remote static public key once known (initiator: from the start; responder: after msg1). */
  remoteStatic(): Uint8Array | null {
    return this.#rs ? copy(this.#rs) : null;
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    this.#checkTurn(true);
    return this.#guard(() => {
      const parts: Uint8Array[] = [];
      for (const token of this.pattern.messages[this.#index]!) {
        switch (token) {
          case 'e': {
            const e = this.#primitives.generateKeyPair();
            if (
              e.privateKey.length !== this.#primitives.dhLen ||
              e.publicKey.length !== this.#primitives.dhLen
            ) {
              throw new NoiseError('key', 'ephemeral key must be DHLEN bytes');
            }
            this.#e = { privateKey: copy(e.privateKey), publicKey: copy(e.publicKey) };
            parts.push(copy(this.#e.publicKey));
            this.#ss.mixHash(this.#e.publicKey);
            if (this.pattern.psk) this.#ss.mixKey(this.#e.publicKey);
            break;
          }
          case 's':
            parts.push(this.#ss.encryptAndHash(this.#s.publicKey));
            break;
          case 'psk':
            this.#ss.mixKeyAndHash(this.#psk!);
            break;
          default:
            this.#ss.mixKey(this.#dh(token));
        }
      }
      parts.push(this.#ss.encryptAndHash(payload));
      const message = concat(...parts);
      if (message.length > MAX_MESSAGE) throw new NoiseError('size', 'handshake message too long');
      this.#advance();
      return message;
    });
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.#checkTurn(false);
    return this.#guard(() => {
      if (message.length > MAX_MESSAGE) throw new NoiseError('size', 'handshake message too long');
      const { dhLen } = this.#primitives;
      let at = 0;
      const take = (length: number): Uint8Array => {
        if (message.length - at < length)
          throw new NoiseError('size', 'handshake message too short');
        const out = message.slice(at, at + length);
        at += length;
        return out;
      };
      for (const token of this.pattern.messages[this.#index]!) {
        switch (token) {
          case 'e': {
            const re = take(dhLen);
            this.#re = re;
            this.#ss.mixHash(re);
            if (this.pattern.psk) this.#ss.mixKey(re);
            break;
          }
          case 's': {
            const sealed = take(this.#ss.hasKey() ? dhLen + TAG : dhLen);
            let rs: Uint8Array;
            try {
              rs = this.#ss.decryptAndHash(sealed);
            } catch (error) {
              // IKpsk0: a wrong psk surfaces here, before any payload (spec §7.4, "bad-psk").
              if (error instanceof NoiseError && error.code === 'decrypt') {
                throw new NoiseError('decrypt', 'cannot decrypt the remote static key');
              }
              throw error;
            }
            if (this.#expectedRs && !equalBytes(rs, this.#expectedRs)) {
              throw new NoiseError('key', 'remote static key is not the expected one');
            }
            this.#rs = rs;
            break;
          }
          case 'psk':
            this.#ss.mixKeyAndHash(this.#psk!);
            break;
          default:
            this.#ss.mixKey(this.#dh(token));
        }
      }
      const payload = this.#ss.decryptAndHash(message.subarray(at));
      this.#advance();
      return payload;
    });
  }

  /** h of the finished handshake (Noise §11.2 channel binding; input of the SAS). */
  handshakeHash(): Uint8Array {
    if (!this.isComplete) throw new NoiseError('state', 'handshake not complete');
    return this.#ss.handshakeHash();
  }

  /** Transport ciphers, once. Wipes the handshake secrets. */
  split(): TransportCiphers {
    if (this.#phase !== 'complete')
      throw new NoiseError('state', 'handshake not complete or already split');
    const [c1, c2] = this.#ss.split();
    this.#phase = 'split';
    this.#wipeKeys();
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }

  #mixPre(token: Token, publicKey: Uint8Array | null): void {
    if (token !== 's' || !publicKey) throw new NoiseError('state', 'unsupported pre-message');
    this.#ss.mixHash(publicKey);
  }

  // es/se name (initiator key, responder key): each side picks its own private and the other's public half.
  #dh(token: Token): Uint8Array {
    const [initKey, respKey] = [token[0], token[1]] as ['e' | 's', 'e' | 's'];
    const local = this.initiator ? initKey : respKey;
    const remote = this.initiator ? respKey : initKey;
    const priv = local === 'e' ? this.#e?.privateKey : this.#s.privateKey;
    const pub = remote === 'e' ? this.#re : this.#rs;
    if (!priv || !pub) throw new NoiseError('state', 'missing key for DH');
    return this.#primitives.dh(priv, pub);
  }

  #checkTurn(writing: boolean): void {
    if (this.#phase !== 'running') throw new NoiseError('state', `handshake is ${this.#phase}`);
    if (this.isMyTurn !== writing) throw new NoiseError('state', 'not this side’s turn');
  }

  #advance(): void {
    this.#index += 1;
    if (this.#index === this.pattern.messages.length) this.#phase = 'complete';
  }

  #guard<T>(step: () => T): T {
    try {
      return step();
    } catch (error) {
      this.#phase = 'failed';
      this.#wipeKeys();
      throw error instanceof NoiseError ? error : new NoiseError('state', 'handshake step failed');
    }
  }

  #wipeKeys(): void {
    wipe(this.#e?.privateKey ?? null);
    wipe(this.#s.privateKey);
    wipe(this.#psk);
  }
}

/** Starts the initiator side (the phone). */
export function initiator(options: HandshakeOptions): HandshakeState {
  return new HandshakeState(true, options);
}

/** Starts the responder side (the bridge). */
export function responder(options: HandshakeOptions): HandshakeState {
  return new HandshakeState(false, options);
}
